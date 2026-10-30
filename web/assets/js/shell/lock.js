/**
 * @fileoverview 全站锁屏界面（按需加载：由 shell/lock-guard.js 在 locked / unknown 时 import()；守卫、去处判定在 lock-guard.js）。
 * 原说明：全站锁屏（2.4.0 H；2026-10-23 访客进入改临时 LockKey，去掉 Turnstile）。
 * 分层规范 L4：lock.js 只负责两件事——
 * 1. 按 L1（middleware 注入的 <html data-sgx-lock-session>）画锁屏，不自己判断会话；
 * 2. 把密码或通行密钥提交给 L2（functions/api/*）。
 * 唯一状态源是服务端签发的 sgx-lock-session 会话；禁止用 sessionStorage、
 * localStorage、前端内存或标签页状态另做判断。
 * - 点头像（电脑回车/空格）→ 解锁方式弹层：访客进入（输入临时钥匙）/ 通行密钥 / 密码；
 *   通过 → 开锁动画 → 现有解锁流程；失败 → 红色提示。
 * - 本地开发（localhost）跳过验证。
 * - 安全与隐私：临时钥匙/密码/通行密钥三态共用同一个底部弹层组件（圆角、材质、
 *   拖动条、标题字号位置、按钮样式一致）；弹层背景完全不透明；打开时底层
 *   名字与入口设 visibility:hidden + inert；容器无 outline，:focus-visible 只在
 *   内部可交互元素上用本站焦点色。
 * - 临时钥匙：admin 在账号页签发（12 位，XXXX-XXXX-XXXX），访客在这里输入 → POST /api/lock-tempkey-unlock
 *   → 访客会话（没有账号、设置里的锁屏凭证等 admin 权限）。
 */
import { on } from '../lib/events.js';
import { reducedMotion } from '../lib/util.js';
import { followKeyboard } from './vk.js';
import { tapFeedback } from '../lib/dialog-behavior.js';
import { createMethodSheet, createVerifyDialog, METHOD_ICONS, keepInputFocus } from '../auth/auth-sheet.js';
import { getPasskeyAssertion, passkeyErrorText, assertionOptions, assertionToJSON, isPasskeyCancel } from '../auth/passkey-assert.js';
import { pwFieldHtml, bindPwEye, onEnter, focusNoScroll } from '../auth/auth-flow.js';
import { KEY_LOCK } from '../lib/key-names.js';
import { mountResetFlow, resetT } from '../auth/reset-flow.js';

import { sgxNavigate } from '../lib/diag-jumptrace.js';
import { isLocalDev, pageState, askServer, proceed, bindAutoLock } from './lock-guard.js';

const UNLOCK =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/></svg>';

/**
 * 显示锁屏 UI（2.4.0 H）。
 */
export function showLockScreen() {
  const en = document.documentElement.lang === 'en';
  const isLocal = isLocalDev();

  /* 头像：复用导航抽屉头的头像图片（2026-10-22 从顶栏挪进抽屉） */
  const navImg = /** @type {HTMLImageElement|null} */ (document.querySelector('.sgx-tb-avatar'));
  /* 锁屏头像 72px：用 192 那张（顶栏是 96） */
  const avatarSrc = navImg ? navImg.src.replace(/\/avatar\/96\.webp/, '/avatar/192.webp') : '';

  /* 顶栏保持全站三件套（用户 2026-10-23：顶栏保留设计）：左九宫格圆 + 页名长条 + 右快捷面板圆，图标取页面顶栏同一份。
     锁屏上两侧圆只是外观（span、不可点、不进读屏），抽屉 / 快捷面板在锁定时打不开，不能绕过锁屏。 */
  const tbNavEl = document.querySelector('#site-nav .sgx-tb-nav');
  const tbEndEl = document.querySelector('#site-nav .sgx-tb-end');
  const tbNavIc = tbNavEl ? tbNavEl.innerHTML : '';
  const tbEndIc = tbEndEl ? tbEndEl.innerHTML : '';
  const ov = document.createElement('div');
  ov.id = 'sgx-lock';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', en ? 'Lock screen' : '锁屏');
  /* PR3 锁屏版面：保留锁屏的感觉（小锁 → 时钟 → 日期天气 → 日刻今日一句 → 头像解锁），
     整组在屏幕里垂直居中，不再「时钟顶在上面、头像压在底部、中间一大片空」。
     日刻卡只展示（div，不是链接，点了不跳转）；拉不到就不显示。
     为了不跳版面：整组先透明，日刻有结论（缓存画上 / 拉到 / 失败）或等满 1.2 秒再一起显示；
     之后才拉到的句子这次不再插进来（下次锁屏从缓存直接画）。 */
  /* 2026-10-23 锁屏视觉统一（用户定稿）：和账号登录页同一套玻璃背景与版面 ——
     顶栏和全站一样是三件套（两侧圆只是外观，点不了，锁屏不能绕过）；
     头像（点它解锁）→ 欢迎回来 / 很高兴再次见到你 → 解锁按钮，整组在屏幕上下左右居中。
     （2026-10-23：小锁图标、左上字标、底部站点清单删掉；A Personal Digital Space 挪到抽屉头）
     时钟、日期天气、日刻不再放在锁屏上。解锁、凭证、会话逻辑不变：按钮只是转点头像。 */
  ov.innerHTML =
    '<div class="sgx-glass-bg" aria-hidden="true"></div>' +
    '<div class="sgx-lock-tb">' +
    '<span class="sgx-tb-nav" aria-hidden="true">' + tbNavIc + '</span>' +
    /* 顶栏标题（2026-10-24）：静止时「锁定屏幕」，打开解锁方式 / 验证弹层时「解锁屏幕」（syncTitle） */
    '<div class="sgx-tb-pill"><span class="sgx-tb-title" id="sgx-lock-title" aria-live="polite">' + (en ? 'Lock screen' : '锁定屏幕') + '</span></div>' +
    '<span class="sgx-tb-end" aria-hidden="true">' + tbEndIc + '</span>' +
    '</div>' +
    '<div class="sgx-lock-stage is-pending" id="sgx-lock-stage">' +
    '<div class="sgx-lock-user"><button type="button" id="sgx-lock-avatar" aria-label="' +
    (en ? 'Unlock, choose method' : '解锁，选择方式') +
    '" aria-haspopup="dialog">' +
    '<span class="sgx-lock-halo" aria-hidden="true"></span>' +
    (avatarSrc
      ? '<img src="' + avatarSrc + '" alt="Styrigx" width="120" height="120">'
      : '<span class="sgx-lock-fb" aria-hidden="true">S</span>') +
    '</button>' +
    '<p class="sgx-lock-welcome">' + (en ? 'Welcome back' : '欢迎回来') + '</p>' +
    '<p class="sgx-lock-sub">' + (en ? 'Good to see you again' : '很高兴再次见到你') + '</p>' +
    '<button type="button" class="sgx-credential-btn sgx-credential-btn-primary sgx-lock-go" id="sgx-lock-go" aria-haspopup="dialog">' +
    UNLOCK + '<span>' + (en ? 'Unlock' : '解锁') + '</span></button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(ov);
  document.body.classList.add('sgx-locked');
  /* 守卫先盖的遮罩（lock-guard.js showLockCover）：锁屏已经画上，撤掉 */
  const cover = document.getElementById('sgx-lock-cover');
  if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';


  /* 版面一次画完，直接显示（以前要等日刻） */
  const stage = document.getElementById('sgx-lock-stage');
  if (stage) stage.classList.remove('is-pending');

  let done = false;
  function cleanup() {
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.classList.remove('sgx-locked');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    bindAutoLock();
  }

  /** 服务端确认有效后：关掉弹层，交给模块级 proceed（唯一去处判定） */
  function onServerOk(ans) {
    done = true;
    try { closeMethodSheet(true); } catch (e) {}
    if (vd.isOpen()) closeDialog('session-ok');
    proceed(ans, doUnlockAnimation);
  }

  /* 解锁成功（密码 / 通行密钥 / 访客）后：先向服务端确认会话真的生效，再按服务端给的 next 走；
     没确认到 → 停在锁屏显示错误，绝不跳转。 */
  function unlock() {
    if (done) return;
    done = true;
    if (isLocal) {
      /* 本地开发没有后端：原地开锁 */
      doUnlockAnimation();
      return;
    }
    askServer().then(function (ans) {
      if (ans.ok) onServerOk(ans);
      else sessionCheckFailed();
    });
  }

  /* 锁屏显示期间（用户可能在别的标签页解锁了）：visibilitychange（visible）、focus、pageshow 时对账，
     节流 1 秒。ok → proceed；401/网络失败 → 保持锁屏（fail closed）。 */
  let lastRecheck = 0;
  function recheckSession() {
    if (done || isLocal) return;
    const now = Date.now();
    if (now - lastRecheck < 1000) return;
    lastRecheck = now;
    askServer().then(function (ans) {
      if (!done && ans.ok) onServerOk(ans);
    });
  }

  function bindRecheck() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') recheckSession();
    });
    window.addEventListener('focus', recheckSession);
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) recheckSession();
    });
  }

  /* 会话没生效：停在锁屏，显示友好错误，不跳转（允许重试） */
  function sessionCheckFailed() {
    done = false;
    try {
      setTitle(en ? 'Session not active' : '会话未生效');
      setBody(
        '<p class="sgx-verify-failtx">' +
          (en
            ? 'The session was not recognized. Please try again.'
            : '会话未生效，请重试。') +
          '</p>'
      );
      clearErr();
      if (!vd.isOpen()) openDialog();
      dlgState = 'session-failed';
    } catch (e) {}
  }

  /* 开锁动画（无 return 时）：显示桌面 */
  function doUnlockAnimation() {
    if (reducedMotion()) {
      ov.style.transition = 'opacity .25s ease';
      ov.style.opacity = '0';
      window.setTimeout(cleanup, 280);
    } else {
      document.body.classList.remove('sgx-locked');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          ov.classList.add('sgx-lock-out');
        });
      });
      window.setTimeout(cleanup, 450);
    }
  }

  /* ============================================================
     统一底部弹层：临时钥匙 / 密码 / 通行密钥三态共用同一个 dialog（auth/auth-sheet.js，账号登录页同一个组件）。
     - 同样的圆角、材质、拖动条、标题字号/位置、按钮样式；
     - 卡片背景完全不透明；打开时底层名字与入口 visibility:hidden + inert；
     - 容器无 outline；:focus-visible 只在内部可交互元素上用本站焦点色。
     键盘避让：各态 setBody 后对新生成输入框调 vd.armKb(input)（followKeyboard 作用到 dlg 而非 card，避免与 card 入场动画冲突）。
     ============================================================ */
  /** @type {string|null} */ let dlgState = null;
  let pwLockedUntil = 0;
  const vd = createVerifyDialog({
    en: en,
    reasonTag: 'lock-verify',
    followKeyboard: followKeyboard,
    onClose: function () {
      resetAvatar();
      setBgHidden(false);
      dlgState = null;
      syncTitle();
    },
  });
  const setTitle = vd.setTitle;
  const setBody = vd.setBody;
  const clearErr = vd.clearErr;
  const showError = vd.showError;
  /** @param {any} input */
  function armDlgKbFor(input) { vd.armKb(input); }
  /** @param {string} reason */
  function closeDialog(reason) { vd.close(reason); }

  /* 顶栏标题：锁屏静止时「锁定屏幕」，打开解锁方式 / 验证弹层（正在解锁）时「解锁屏幕」 */
  function syncTitle() {
    const el = document.getElementById('sgx-lock-title');
    if (!el) return;
    const unlocking = !!methodSheet || vd.isOpen();
    el.textContent = unlocking ? (en ? 'Unlock screen' : '解锁屏幕') : (en ? 'Lock screen' : '锁定屏幕');
  }

  /* 底层元素：弹层打开时隐藏并 inert，关闭时恢复 */
  /** @param {boolean} hidden */
  function setBgHidden(hidden) {
    const sels = ['.sgx-lock-name', '.sgx-lock-links'];
    for (let i = 0; i < sels.length; i++) {
      const el = document.querySelector(sels[i]);
      if (el) {
        el.classList.toggle('sgx-bg-hidden', hidden);
        try {
          /** @type {any} */ (el).inert = hidden;
        } catch (e) {}
      }
    }
  }

  /* 头像淡出避让：弹层打开时淡出，关闭时恢复（One UI 式） */
  function liftAvatar() {
    try {
      document.body.classList.add('sgx-dlg-open');
    } catch (e) {}
  }
  function resetAvatar() {
    try {
      document.body.classList.remove('sgx-dlg-open');
    } catch (e) {}
  }

  function openDialog() {
    setBgHidden(true);
    if (!vd.open()) {
      setBgHidden(false);
      return false;
    }
    syncTitle();
    requestAnimationFrame(function () {
      liftAvatar();
    });
    return true;
  }

  /**
   * 2.8.0 锁屏重设计：点击头像后弹出的解锁方式选择底部弹层（auth/auth-sheet.js createMethodSheet，账号登录页同一个组件）。
   * One UI 风格：底部弹层（宽屏居中卡片），各带图标和一行说明。
   *
   * 补充定稿七.1：入口按锁屏凭证配置显示（配置以服务端 /api/lock-entry 为准，
   * 读取失败按「已配置」处理）。「访客进入」始终在第一位，最下面一行小字「无法登录？」（PR3）：
   * - 两者都有 → 访客进入 / 通行密钥 / 密码 / 无法登录？
   * - 仅通行密钥 / 仅密码 → 访客进入 / 该项 / 无法登录？
   * - 都没设置（启动站）→ 访客进入 / 无法登录？（里面的根凭证走 root-auth 引导，原「根凭证」一行）
   * 「无法登录？」→ 弹层原地切到重置登录（openResetInSheet）。
   * 点外部、Esc 或下滑关闭；键盘可操作。
   */
  /** @type {{el: HTMLElement, card: HTMLElement, close: (navigating?: boolean) => void}|null} */
  let methodSheet = null;
  let methodSheetLoading = false;
  function openMethodSheet() {
    if (methodSheet || methodSheetLoading) return;
    methodSheetLoading = true;
    fetch('/api/lock-entry', { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        methodSheetLoading = false;
        if (methodSheet) return;
        var cfg = { passkey: true, password: true };
        if (j && j.ok) {
          /* 账号拆分 PR3：lock-entry 只回锁屏自己的 passkey / password（不再有 resetOnly / accountConfigured） */
          cfg = { passkey: !!j.passkey, password: !!j.password };
        }
        buildMethodSheet(cfg);
      })
      .catch(function () {
        methodSheetLoading = false;
        if (methodSheet) return;
        /* 读取失败按已配置处理：不暴露根凭证入口 */
        buildMethodSheet({ passkey: true, password: true });
      });
  }
  /**
   * 按锁屏凭证配置构建方法弹层。
   * @param {{passkey:boolean, password:boolean}} cfg
   */
  function buildMethodSheet(cfg) {
    const hasPk = !!(window.PublicKeyCredential);
    /* PR3：根凭证不再是单独一行；锁屏凭证都没设置（启动站）时，「无法登录？」里的根凭证走 root-auth 引导。 */
    const showPk = cfg.passkey && hasPk;
    const showPw = cfg.password;
    /* 批次 A 验收修复 P2：方法行点击轻触觉反馈。(b) 行 busy 不适用：
       点击即关弹层并在同一 tick 打开下一态；通行密钥行 → openPk() 已有带转圈的加载态。 */
    /** @type {import('../auth/auth-sheet.js').MethodOpt[]} */
    const opts = [
      /* 1. 访客进入（临时钥匙，2026-10-23 取代 Turnstile） */
      { id: 'sgx-mopt-visitor', icon: METHOD_ICONS.visitor, name: en ? 'Visitor' : '访客进入',
        desc: en ? 'Enter the temporary key you received' : '输入收到的临时钥匙',
        ariaLabel: en ? 'Enter as visitor with a temporary key' : '访客进入，输入临时钥匙',
        onPick: function () { tapFeedback(); openTemp(); } },
    ];
    /* 2. 通行密钥（已配置且设备支持） */
    if (showPk) opts.push({ id: 'sgx-mopt-pk', icon: METHOD_ICONS.passkey, name: en ? 'Passkey' : '通行密钥',
      desc: en ? 'Unlock with fingerprint or device PIN' : '用指纹或设备 PIN 解锁',
      ariaLabel: en ? 'Use passkey' : '使用通行密钥',
      onPick: function () { tapFeedback(); openPk(); } });
    /* 3. 密码（已配置） */
    if (showPw) opts.push({ id: 'sgx-mopt-pw', icon: METHOD_ICONS.password, name: en ? 'Password' : '密码',
      desc: en ? 'Enter your unlock password' : '输入解锁密码',
      ariaLabel: en ? 'Use password' : '使用密码',
      onPick: function () { tapFeedback(); openPw(); } });
    const ms = createMethodSheet({
      ariaLabel: en ? 'Choose unlock method' : '选择解锁方式',
      title: en ? 'Unlock' : '解锁',
      options: opts,
      /* 4. PR3：「无法登录？」小字（原「重置锁屏」「根凭证」两行合并到这里）：点了弹层原地切到重置登录 */
      cant: { id: 'sgx-mopt-cant', text: en ? 'Can’t sign in?' : '无法登录？',
        onClick: function (card) { tapFeedback(); openResetInSheet(card, cfg); } },
      /* 关闭一开始（Esc / 遮罩 / 下滑 / 选了方式 / closeMethodSheet）：清本地状态 */
      onClose: function () {
        if (methodSheet === ms) methodSheet = null;
        if (flow) {
          try { flow.destroy(); } catch (e) {}
          flow = null;
        }
        syncTitle();
      },
      onClosed: function (navigating) {
        /* 焦点回到头像：只在没有别的弹层接手焦点时（选了某个方式会马上打开验证弹层，
           这时把焦点抢回头像会让刚聚焦的密码框失焦，2026-10-24 修） */
        if (navigating || vd.isOpen()) return;
        try {
          const av = document.getElementById('sgx-lock-avatar');
          if (av) av.focus({ preventScroll: true });
        } catch (e) {}
      },
    });
    methodSheet = ms;
    syncTitle();
  }

  /** @param {boolean} [navigating] 重置完成要跳页：不把焦点还给头像 */
  function closeMethodSheet(navigating) {
    if (!methodSheet) return;
    methodSheet.close(navigating);
  }


  /* ---------- 临时钥匙态（访客进入；与密码态同一弹层） ---------- */
  let tempLockedUntil = 0;
  function openTemp() {
    if (isLocal) {
      unlock();
      return;
    }
    dlgState = 'temp';
    setTitle(en ? 'Enter temporary key' : '输入临时钥匙');
    setBody(
      '<div class="sgx-pw-field"><input type="text" id="sgx-temp-input" class="sgx-pw-input sgx-temp-input" inputmode="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="20" ' +
        'aria-label="' + (en ? 'Temporary key' : '临时钥匙') + '" placeholder="XXXX-XXXX-XXXX"></div>' +
        '<p class="sgx-temp-hint">' + (en ? 'Format XXXX-XXXX-XXXX, case doesn’t matter' : '格式 XXXX-XXXX-XXXX，不区分大小写') + '</p>' +
        '<p id="sgx-temp-count" class="sgx-pw-count" hidden></p>' +
        '<button type="button" class="sgx-verify-skip" id="sgx-temp-go">' + (en ? 'Enter' : '确定') + '</button>'
    );
    clearErr();
    if (!openDialog()) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-temp-input'));
    const go = document.getElementById('sgx-temp-go');
    armDlgKbFor(input);
    if (input) {
      onEnter(input, submitTemp);
      focusNoScroll(input);
    }
    if (go) { on(go, 'click', submitTemp); keepInputFocus(go); }
    if (Date.now() < tempLockedUntil) tempCountdown();
  }

  function tempCountdown() {
    const el = document.getElementById('sgx-temp-count');
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-temp-input'));
    const go = /** @type {HTMLButtonElement|null} */ (document.getElementById('sgx-temp-go'));
    function tick() {
      if (dlgState !== 'temp') return;
      const left = Math.max(0, Math.ceil((tempLockedUntil - Date.now()) / 60000));
      if (Date.now() >= tempLockedUntil) {
        if (el) el.hidden = true;
        if (input) input.disabled = false;
        if (go) go.disabled = false;
        return;
      }
      if (el) {
        el.textContent = en ? 'Try again in ' + left + ' min' : left + ' 分钟后可再试';
        el.hidden = false;
      }
      if (input) input.disabled = true;
      if (go) go.disabled = true;
      window.setTimeout(tick, 5000);
    }
    tick();
  }

  function submitTemp() {
    if (dlgState !== 'temp') return;
    if (Date.now() < tempLockedUntil) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-temp-input'));
    const code = input ? input.value.trim() : '';
    if (!code) {
      showError(en ? 'Enter the temporary key' : '请输入临时钥匙', input);
      return;
    }
    fetch('/api/lock-tempkey-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    })
      .then(function (r) {
        return r.text().then(function (t) {
          let j = null;
          try { j = JSON.parse(t); } catch (e) {}
          return { s: r.status, j: j };
        });
      })
      .then(function (res) {
        if (dlgState !== 'temp') return;
        const j = res.j;
        if (!j) {
          showError(en ? 'Server error' : '服务器错误');
          return;
        }
        if (j.ok) {
          closeDialog('success');
          unlock();
        } else if (j.error === 'cooldown') {
          /* retryAfter（秒）：网关无会话总限流（_kernel/anon-limit.js）给的；没有就是临时码自己的 15 分钟锁 */
          tempLockedUntil = Date.now() + (j.retryAfter > 0 ? j.retryAfter * 1000 : 15 * 60000);
          showError(en ? 'Too many attempts' : '尝试次数过多');
          tempCountdown();
        } else if (j.error === 'wrong' || j.error === 'code') {
          if (input) input.value = '';
          showError(en ? 'Invalid or expired key' : '临时钥匙无效或已过期', input);
        } else {
          showError(en ? 'Server error' : '服务器错误');
        }
      })
      .catch(function () {
        if (dlgState !== 'temp') return;
        showError(en ? 'Network error' : '网络错误');
      });
  }

  /* ---------- 密码态（与验证态同一弹层） ---------- */
  function openPw() {
    dlgState = 'password';
    setTitle(en ? 'Enter password' : '输入密码');
    setBody(
      pwFieldHtml({ id: 'sgx-pw-input', eyeId: 'sgx-pw-eye', autocomplete: 'current-password', pmUser: KEY_LOCK, ariaLabel: en ? 'Password' : '密码', placeholder: en ? 'Password' : '密码', en: en }) +
        '<p id="sgx-pw-count" class="sgx-pw-count" hidden></p>' +
        '<button type="button" class="sgx-verify-skip" id="sgx-pw-go">' + (en ? 'Unlock' : '确定') + '</button>'
    );
    clearErr();
    if (!openDialog()) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const eye = document.getElementById('sgx-pw-eye');
    const go = document.getElementById('sgx-pw-go');
    /* 批次 A 验收修复 P2：眼睛按钮走 bindEyeButton（初始 eye-off） */
    if (eye && input) bindPwEye(eye, input, en);
    armDlgKbFor(input);
    if (input) {
      onEnter(input, submitPw);
      focusNoScroll(input);
    }
    if (go) { on(go, 'click', submitPw); keepInputFocus(go); }
    if (Date.now() < pwLockedUntil) pwCountdown();
  }

  function pwCountdown() {
    const el = document.getElementById('sgx-pw-count');
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const go = document.getElementById('sgx-pw-go');
    function tickCount() {
      if (dlgState !== 'password') return;
      const left = Math.max(0, Math.ceil((pwLockedUntil - Date.now()) / 1000));
      if (left <= 0) {
        if (el) el.hidden = true;
        if (input) input.disabled = false;
        if (go) /** @type {HTMLButtonElement} */ (go).disabled = false;
        return;
      }
      if (el) {
        el.textContent = en ? 'Try again in ' + left + 's' : left + ' 秒后可再试';
        el.hidden = false;
      }
      if (input) input.disabled = true;
      if (go) /** @type {HTMLButtonElement} */ (go).disabled = true;
      window.setTimeout(tickCount, 1000);
    }
    tickCount();
  }

  function submitPw() {
    if (dlgState !== 'password') return;
    if (Date.now() < pwLockedUntil) return;
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('sgx-pw-input'));
    const pw = input ? input.value : '';
    if (!pw) {
      showError(en ? 'Enter password' : '请输入密码', input);
      return;
    }
    fetch('/api/lock-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', password: pw }),
    })
      /* 区分网络错误（fetch 抛错）/ 服务器错误（非 JSON 响应）/ 业务错误 */
      .then(function (r) {
        return r.text().then(function (t) {
          let j = null;
          try {
            j = JSON.parse(t);
          } catch (e) {}
          return { s: r.status, j: j };
        });
      })
      .then(function (res) {
        if (dlgState !== 'password') return;
        const j = res.j;
        if (!j) {
          showError(en ? 'Server error' : '服务器错误');
          return;
        }
        if (j.ok) {
          closeDialog('success');
          unlock();
        } else if (j.error === 'cooldown') {
          /* retryAfter（秒）：网关无会话总限流给的；没有就是密码输错的 30 秒冷却 */
          pwLockedUntil = Date.now() + (j.retryAfter > 0 ? j.retryAfter * 1000 : 30000);
          showError(en ? 'Too many attempts' : '尝试次数过多');
          pwCountdown();
        } else if (j.error === 'not-set') {
          showError(en ? 'No password set yet' : '尚未设置密码');
        } else if (j.error === 'server') {
          showError(en ? 'Server error' : '服务器错误');
        } else {
          if (input) input.value = '';
          showError(en ? 'Wrong password' : '密码错误', input);
        }
      })
      .catch(function () {
        if (dlgState !== 'password') return;
        showError(en ? 'Network error' : '网络错误');
      });
  }

  /* ---------- 重置登录（PR3：方法弹层里的「无法登录？」原地切到 auth/reset-flow.js） ----------
     与账号页 /account/reset/ 同一个界面，提交不同：
     - 锁屏凭证已设置（或读不到配置，按已设置处理）：根凭证 → POST /api/lock-reset verify；
       恢复开关有效直接拿到重置锁屏票（sgx-lock-reset）；否则服务端回 needLock → 再验锁屏凭证（锁屏通行密钥 / 解锁密码，
       账号拆分 PR3 起网关不读账号凭证）→ 重置锁屏票 → 去 /settings/security/lock/ 重设解锁方式。
     - 锁屏凭证都没设置（启动站）：视为从零重置——根凭证 → POST /api/root-auth { purpose:'lock-reset' }
       （重置锁屏票 by=root）→ 同样去 /settings/security/lock/ 设第一把锁屏凭证，再正常解锁进站。
       根凭证不拥有会话，也不是单独的解锁入口。
     根凭证只存在 reset-flow 的闭包里。 */
  /**
   * @param {HTMLElement} cardEl 方法弹层卡片
   * @param {{passkey:boolean, password:boolean}} cfg
   */
  function openResetInSheet(cardEl, cfg) {
    const bootstrap = !cfg.passkey && !cfg.password;
    const T = resetT(en);
    cardEl.innerHTML =
      '<div class="sheet-handle" aria-hidden="true"></div>' +
      '<h2 class="sgx-sheet-title" id="sgx-reset-title">' + T('title') + '</h2>' +
      '<div class="sgx-sheet-reset" id="sgx-sheet-reset"></div>';
    const sheetEl = /** @type {HTMLElement|null} */ (cardEl.closest('#sgx-method-sheet'));
    if (sheetEl) sheetEl.setAttribute('aria-label', T('title'));
    const host = /** @type {HTMLElement} */ (cardEl.querySelector('#sgx-sheet-reset'));
    /** @param {any} body @returns {Promise<{s:number, j:any}>} */
    const post = function (url, body) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) {
          return r.text().then(function (t) {
            let j = null;
            try { j = JSON.parse(t); } catch (e) {}
            return { s: r.status, j: j };
          });
        });
    };
    const netErr = function () { throw { message: en ? 'Network error' : '网络错误' }; };
    const tooMany = { message: en ? 'Too many attempts' : '尝试次数过多' };
    const failed = { message: en ? 'Verification failed' : '验证失败', clear: true };
    /* 键盘避让：根凭证框、第二步展开的解锁密码框，聚焦时卡片随键盘上移（与其他弹层同一套 followKeyboard） */
    let kbStop = null;
    /** @type {any} */ let kbFor = null;
    on(host, 'focusin', function (/** @type {FocusEvent} */ e) {
      const tg = /** @type {any} */ (e.target);
      if (!tg || tg.tagName !== 'INPUT' || !tg.classList.contains('sgx-pw-input') || tg === kbFor) return;
      if (kbStop) { try { kbStop(); } catch (e2) {} }
      kbFor = tg;
      kbStop = followKeyboard(cardEl, tg);
    });
    flow = mountResetFlow({
      el: host,
      en: en,
      submitRoot: function (key) {
        if (bootstrap) {
          return post('/api/root-auth', { key: key, purpose: 'lock-reset' }).then(function (res) {
            if (res.j && res.j.ok) return {};
            if (res.s === 429) throw tooMany;
            if (res.s === 503 || res.s === 500) throw { message: en ? 'Server error' : '服务器错误' };
            throw { message: en ? 'Wrong root credential' : '根凭证错误', clear: true };
          }, netErr);
        }
        return post('/api/lock-reset', { action: 'verify', rootKey: key }).then(function (res) {
          if (res.s === 200 && res.j && res.j.ok) {
            return res.j.needLock ? { needLock: { passkey: !!res.j.passkey, password: !!res.j.password } } : {};
          }
          if (res.s === 429) throw tooMany;
          throw failed;
        }, netErr);
      },
      lock: function (rootKey) {
        const verify = function (proof) {
          return post('/api/lock-reset', { action: 'verify', rootKey: rootKey, lockProof: proof }).then(function (res) {
            if (res.s === 200 && res.j && res.j.ok && !res.j.needLock) return;
            if (res.s === 429) throw tooMany;
            throw failed;
          }, netErr);
        };
        return {
          password: function (v) { return verify({ type: 'password', password: v }); },
          passkey: function () {
            return post('/api/lock-reset', { action: 'challenge' }).then(function (res) {
              const j = res.j;
              if (!j || !j.ok) throw { message: en ? 'Failed to start' : '启动失败' };
              return getPasskeyAssertion(assertionOptions(j), { hideEl: sheetEl || undefined }).then(function (cred) {
                return verify({ type: 'passkey', cid: j.cid, credential: assertionToJSON(cred) });
              }, function (err) {
                /* 取消 / 没有匹配钥匙（NotAllowedError）：行内提示，留在本页可重新选择 */
                if (err && err.kind === 'cancelled') throw { cancelled: true, message: en ? 'Cancelled, you can select again' : '已取消验证，可重新选择' };
                if (isPasskeyCancel(err)) throw { cancelled: true, message: passkeyErrorText('nokey', en) };
                throw { message: err && err.kind ? passkeyErrorText(err.kind, en) : (en ? 'Passkey failed' : '通行密钥验证失败') };
              });
            }, function (e) {
              if (e && e.message) throw e;
              netErr();
            });
          },
        };
      },
      onDone: function () {
        if (kbStop) { try { kbStop(); } catch (e) {} kbStop = null; }
        closeMethodSheet(true);
        /* 跳转到锁屏凭证管理页（重置锁屏票可开此页，仍进不了主页；启动站同样在这里设第一把锁屏凭证） */
        sgxNavigate(en ? '/en/settings/security/lock/' : '/settings/security/lock/');
      },
    });
  }
  /** @type {{destroy: () => void}|null} */
  let flow = null;

  /* ---------- 通行密钥态（与验证态同一弹层） ---------- */
  function openPk() {
    dlgState = 'passkey';
    setTitle(en ? 'Use passkey' : '使用通行密钥');
    setBody(
      '<div class="sgx-verify-loading"><div class="sgx-spinner" role="progressbar" aria-label="' +
        (en ? 'Verifying' : '正在验证') +
        '"></div><p class="sgx-verify-loading-tx">' +
        (en ? 'Verifying passkey…' : '正在验证通行密钥…') +
        '</p></div>'
    );
    clearErr();
    if (!openDialog()) return;
    pkAuth();
  }

  /* 通行密钥失败 → 同一弹层内给重试 / 用密码 */
  function pkFailed(msg) {
    if (dlgState !== 'passkey') return;
    setBody(
      '<div class="sgx-verify-loading"><p class="sgx-verify-failtx">' +
        (msg || (en ? 'Passkey verification failed' : '通行密钥验证失败')) +
        '</p><div class="sgx-verify-actions">' +
        '<button type="button" class="sgx-verify-skip" id="sgx-pk-retry">' + (en ? 'Retry' : '重试') + '</button>' +
        '<button type="button" class="sgx-verify-ghost" id="sgx-pk-topw">' + (en ? 'Use password' : '使用密码') + '</button>' +
        '</div></div>'
    );
    const retry = document.getElementById('sgx-pk-retry');
    const topw = document.getElementById('sgx-pk-topw');
    if (retry) on(retry, 'click', openPk);
    if (topw) on(topw, 'click', openPw);
    liftAvatar();
  }

  function pkAuth() {
    /* 服务端回 unknown-key 时要告诉密码管理器删哪一把：这里记下 id（以前在下一个 then 里直接用 cred，
       那里没有这个变量，ReferenceError 被吞掉，signalUnknownCredential 从来没发出去） */
    let credId = '';
    fetch('/api/lock-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'challenge', type: 'auth' }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (ch) {
        if (dlgState !== 'passkey') throw { done: true };
        if (!ch || !ch.ok) throw new Error('challenge');
        /* B1-2：用公共函数（隐藏弹层 + 30s 超时 + 4 档错误） */
        return getPasskeyAssertion(assertionOptions(ch), { hideEl: document.querySelector('.sgx-verify-dlg') }).then(function (cred) {
          return { cred: cred, cid: ch.cid };
        });
      })
      .then(function (res) {
        if (dlgState !== 'passkey') throw { done: true };
        const cred = res.cred;
        credId = cred.id;
        return fetch('/api/lock-passkey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'auth',
            cid: res.cid,
            credential: assertionToJSON(cred),
          }),
        });
      })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (dlgState !== 'passkey') return;
        if (j && j.ok) {
          closeDialog('success');
          unlock();
        } else {
          /* 服务端不认识这把密钥 → 通知密码管理器删掉 */
          try {
            if (j && j.error === 'unknown-key' && window.PublicKeyCredential &&
                typeof PublicKeyCredential.signalUnknownCredential === 'function') {
              PublicKeyCredential.signalUnknownCredential({
                rpId: location.hostname,
                credentialId: credId,
              }).catch(function () {});
            }
          } catch (e) {}
          pkFailed();
        }
      })
      .catch(function (e) {
        if (e && e.done) return;
        if (e && e.kind) pkFailed(passkeyErrorText(e.kind, en));
        else pkFailed();
      });
  }

  /* ---------- 入口接线（2.8.0 锁屏重设计） ---------- */
  /* 头像点击 → 解锁方式选择底部弹层 */
  const av = document.getElementById('sgx-lock-avatar');
  if (av) {
    on(av, 'click', function (e) {
      e.stopPropagation();
      openMethodSheet();
    });
    /* 「解锁」按钮 = 点头像（同一个入口，不另走流程） */
    const go = document.getElementById('sgx-lock-go');
    if (go) on(go, 'click', function (e) { e.stopPropagation(); av.click(); });
    try {
      av.focus(/** @type {any} */ ({ preventScroll: true }));
    } catch (e) {
      try {
        av.focus();
      } catch (_) {}
    }
  }
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (done || !document.getElementById('sgx-lock')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (vd.isOpen()) return;
      if (methodSheet) return;
      e.preventDefault();
      /* 键盘也走方式选择弹层 */
      openMethodSheet();
    }
  });

  /* 锁屏显示期间：如果用户在别的标签页解锁了，切回来时自动检测并按服务端的 next 走 */
  bindRecheck();

  /* 首帧对账：页面是 locked 或根本没有会话标记（unknown）时立刻问服务端。
     服务端说有效 → 直接按 next 走，不让用户对着一个本来有效的会话再解一次锁（2026-10-21：
     这是「切到别的标签页再回来就自己解锁」的根因之一——以前只有切回来才对账，首帧不对账 unknown）。 */
  if (!isLocal) {
    askServer().then(function (ans) {
      if (!done && ans.ok) {
        try { console.warn('[sgx-lock] page said ' + pageState() + ' but lock-session-check ok'); } catch (e) {}
        onServerOk(ans);
      }
    });
  }
}
