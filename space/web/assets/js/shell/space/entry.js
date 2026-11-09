/**
 * @fileoverview 锁屏（进站）界面：全屏终端，提示符 entry@space:~$（进站 v3 L1，SPACE-V3 §2.2 A）。由 shell/space/guard.js 在 locked / unknown 时 import()。
 *
 * 锁屏上没有任何弹层 / 底部弹层 / 快捷键按钮（Gray C「NO popups」）：进站就是在终端里敲
 * - `sudo styrigx` → [pick] 只列设了的 [1] passkey [2] password，tempkey 一直在；`sudo styrigx passkey|password|tempkey` 直达（session.js）
 * - `sudo styrigx reset` → `[sudo] recovery key:` → reset 终端 reset@space:~#（reset.js）
 * - help / man styrigx / clear；不认识 → `command not found: x · try help`
 * 旧别名（password / pk / tempkey / reset / forgot / sudo spacekey … / cd ..）都删了。
 *
 * 分层规范 L4：只按页面状态画锁屏、把凭证交给后端（api.js），不自己判断会话；唯一状态源是服务端签发的进站会话 cookie。
 * DOM / 类名是 entry（#sgx-entry*、.sgx-entry-*、body.sgx-entry；Q20：lock 只剩动作）。文案在外壳字符串表 space.*（sgx-shell-i18n）。
 * 本地开发（localhost）sudo styrigx tempkey 直接进站（不输临时钥匙）。
 */
import { reducedMotion, esc } from '../../lib/util.js';
import { onKeyboardHeight } from '../vk.js';
import { tapFeedback } from '../../lib/dialog-behavior.js';
import { profileDefaults, readCache, effectiveProfile } from '../../lib/profile.js';
import { langs } from '../../lib/lang-path.js';
import { setLang } from '../../lib/prefs.js';
import { pageLang } from '../../lib/i18n.js';
import * as api from './api.js';
import { createTerm, shellTable } from './term.js';
import { CMD, PS_ENTRY, PS_RESET, ADMIN_COMMAND, normCmd, parseEntryCmd } from './commands.js';
import { mountVerify } from './session.js';
import { mountReset } from './reset.js';
import { isLocalDev, pageState, askServer, proceed, bindAutoLock } from './guard.js';

/** 锁屏头像的替代文字 / 欢迎名 = 个人资料的姓名（构建期默认值 ← 本机缓存里改过的）；只是显示用的文字，和会话判断无关 */
function entryName() {
  return effectiveProfile(readCache(), profileDefaults()).name;
}

/** 状态胶囊：locked · sudo · verifying · denied · unlocked */
const CHIP = { locked: 'LOCKED', sudo: 'SUDO', verifying: 'VERIFYING', denied: 'DENIED', unlocked: 'UNLOCKED', reset: 'RESET' };

/**
 * 显示锁屏。
 */
export function showEntryScreen() {
  const isLocal = isLocalDev();
  const t = shellTable(document, 'space');
  /** @param {string} k @param {Record<string, string|number>} v */
  const tf = function (k, v) { let s = t(k); for (const n in v) s = s.split('{' + n + '}').join(String(v[n])); return s; };

  /* 头像：复用顶栏头像图片 .sgx-tb-avatar */
  const navImg = /** @type {HTMLImageElement|null} */ (document.querySelector('#site-nav .sgx-tb-avatar'));
  const avatarSrc = navImg ? navImg.src.replace(/\/avatar\/\d+\.webp/, '/avatar/192.webp') : '';
  /* 顶栏外观照抄页面顶栏（只是外观：span、不可点、不进读屏） */
  const tbLogoEl = document.querySelector('#site-nav .sgx-tb-logo');
  const tbLogo = tbLogoEl ? tbLogoEl.innerHTML : '';
  const tbActs = Array.from(document.querySelectorAll('#site-nav .sgx-tb-acts .sgx-tb-btn')).map(function (b) {
    return '<span class="' + b.className + '">' + b.innerHTML + '</span>';
  }).join('');
  /* 底部语言（`~/styrigx_ · zh · en`）：点了和导航面板语言行同一个写法 */
  const curLang = pageLang();
  const langBtns = langs().slice().reverse().map(function (l) {
    return '<span class="sgx-entry-tsep" aria-hidden="true"> · </span>' +
      '<button type="button" class="sgx-entry-lang" data-lang="' + l + '" lang="' + l + '"' +
      (l === curLang ? ' aria-current="true"' : '') + '>' + l + '</button>';
  }).join('');
  const name = entryName();
  const termUser = (String(name || '').trim().split(/\s+/)[0] || ADMIN_COMMAND).toLowerCase();

  const ov = document.createElement('div');
  ov.id = 'sgx-entry';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', t('entry.aria'));
  ov.innerHTML =
    '<div class="sgx-glass-bg" aria-hidden="true"></div>' +
    '<div class="sgx-entry-tb"><div class="sgx-topbar">' +
    '<span class="sgx-tb-logo" aria-hidden="true">' + tbLogo + '</span>' +
    '<div class="sgx-tb-pill"><span class="sgx-tb-title" id="sgx-entry-title">' + esc(t('entry.title')) + '</span></div>' +
    '<span class="sgx-tb-acts" aria-hidden="true">' + tbActs + '</span>' +
    '</div></div>' +
    '<div class="sgx-entry-stage" id="sgx-entry-stage">' +
    '<div class="sgx-entry-user">' +
    '<div class="sgx-entry-av" id="sgx-entry-avatar">' +
    (avatarSrc
      ? '<img src="' + avatarSrc + '" alt="' + esc(name) + '" translate="no" data-sgx-personal width="120" height="120">'
      : '<span class="sgx-entry-fb" aria-hidden="true">S</span>') +
    '</div>' +
    '<p class="sgx-entry-st" id="sgx-entry-st" data-st="locked" aria-hidden="true"><i></i><span id="sgx-entry-st-tx">$ STATUS: LOCKED</span></p>' +
    '<p class="sgx-entry-nm" aria-hidden="true" translate="no" data-sgx-personal>' + esc(name) + '</p>' +
    '<p class="sgx-entry-greet"><span class="sgx-entry-welcome">' + esc(t('entry.welcome')) + '</span>' +
    '<span class="sgx-entry-gsep" aria-hidden="true"> · </span>' +
    '<span class="sgx-entry-sub">' + esc(t('entry.goodToSee')) + '</span></p>' +
    '<div class="sgx-entry-term" id="sgx-entry-term">' +
    '<div class="sgx-entry-term-bar" aria-hidden="true"><span translate="no"><b>$</b> ENTRY · tty1</span><span id="sgx-entry-tty" translate="no">entry</span></div>' +
    '<div class="sgx-entry-tbody" id="sgx-entry-tbody">' +
    '<div class="sgx-entry-log" id="sgx-entry-log" data-term-log aria-hidden="true"></div>' +
    /* 命令输入行：真的 <input>。输凭证时 type=password（不回显），隐藏用户名给密码管理器 */
    '<form class="sgx-entry-line" id="sgx-entry-form" data-mode="cmd" novalidate>' +
    '<input type="text" class="sgx-entry-pmu" id="sgx-entry-pmu" name="username" autocomplete="username" value="' + esc(api.PM_USER.password) + '" aria-hidden="true" tabindex="-1" readonly>' +
    '<label class="sgx-entry-ps" id="sgx-entry-ps" for="sgx-entry-cmd" translate="no"></label>' +
    '<input type="text" class="sgx-entry-in" id="sgx-entry-cmd" name="cmd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" maxlength="256">' +
    '</form>' +
    '<p class="sgx-entry-hint" id="sgx-entry-hint" hidden></p>' +
    '<p class="sgx-kh sgx-entry-kh" id="sgx-entry-kh" hidden></p>' +
    '</div>' +
    '</div>' +
    '<p class="sgx-entry-sr" id="sgx-entry-live" role="status" aria-live="polite"></p>' +
    '</div>' +
    '<p class="sgx-entry-tail" translate="no"><span aria-hidden="true">~/styrigx<span class="sgx-entry-tcur"></span></span>' + langBtns + '</p>' +
    '</div>';
  document.body.appendChild(ov);
  document.body.classList.add('sgx-entry');
  /* 守卫先盖的遮罩（guard.js showEntryCover）：锁屏已经画上，撤掉 */
  const cover = document.getElementById('sgx-entry-cover');
  if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const $ = function (/** @type {string} */ id) { return /** @type {HTMLElement} */ (document.getElementById(id)); };
  const termEl = $('sgx-entry-term');
  const stage = $('sgx-entry-stage');
  const logEl = $('sgx-entry-log');
  const input = /** @type {HTMLInputElement} */ ($('sgx-entry-cmd'));

  /* ---------- 状态胶囊 / 标题 / 右上角 ---------- */
  let chipSt = 'locked';
  /** @param {string} st */
  function chip(st) {
    chipSt = st;
    const c = $('sgx-entry-st');
    const tx = $('sgx-entry-st-tx');
    if (c) c.setAttribute('data-st', st);
    if (tx) tx.textContent = '$ STATUS: ' + (/** @type {any} */ (CHIP)[st] || 'LOCKED');
  }
  /** @param {string} m */
  function onMode(m) {
    const title = $('sgx-entry-title');
    if (title) title.textContent = m === 'cmd' || m === 'done' ? t('entry.title') : t('entry.titleBusy');
    if (m === 'busy') chip('verifying');
    else if (m === 'done') chip('unlocked');
    else if (m === 'cmd') { if (chipSt !== 'denied') chip(C && C.inReset ? 'reset' : 'locked'); }
    else chip('sudo');
  }

  /* ---------- 终端 ---------- */
  /** @type {any} */
  let C = null;
  C = createTerm({
    dom: {
      root: termEl,
      log: logEl,
      form: /** @type {HTMLFormElement} */ ($('sgx-entry-form')),
      input: input,
      ps: $('sgx-entry-ps'),
      pmu: /** @type {HTMLInputElement} */ ($('sgx-entry-pmu')),
      hint: $('sgx-entry-hint'),
      live: $('sgx-entry-live'),
      kh: $('sgx-entry-kh'),
    },
    p: 'sgx-entry',
    /* 按键提示行：锁屏命令行（进站之前没别处可去）没有「‹ 返回」；reset 层的命令行 esc / ‹ 返回 = 离开 reset */
    kh: {
      cmdKey: function () { return C && C.inReset ? 'cmdLayer' : 'cmdEntry'; },
      canBackCmd: function () { return !!(C && C.inReset); },
      onBack: function () { C.refocus = true; C.interrupt(); },
    },
    t: t,
    ps: function () { return C && C.inReset ? PS_RESET : PS_ENTRY; },
    ariaCmd: t('entry.cmdAria'),
    maxLines: 120,
    onMode: onMode,
    onCmd: function (raw) { if (C.inReset) C.runResetCmd(raw); else runCmd(raw); },
    onCmdInterrupt: function () {
      if (!C.inReset) return false;
      C.out('^C', 'd');
      C.leaveReset();
      return true;
    },
    onReveal: function (el) {
      /* 输出区最多 40vh、自己滚：新行滚进来（不用 scrollIntoView，三星「桌面版网站」放大时整页会平移） */
      try { logEl.scrollTop = logEl.scrollHeight; } catch (e) {}
      void el;
    },
  });
  C.api = api;
  C.tf = tf;
  C.localDev = isLocal;
  C.who = function () { return name; };
  /** 进站凭证配置（/api/lock-entry；读不到按都设了）；null = 还没回来 */
  C.cfg = null;
  const cfgReady = api.entryConfig().then(function (c) { C.cfg = c; return c; });
  C.authErr = function () { return false; };
  C.setBar = function (/** @type {string} */ s) { const el = $('sgx-entry-tty'); if (el) el.textContent = s || 'entry'; };
  C.setStatus = function (/** @type {string} */ s) { chip(s === 'reset' ? 'reset' : 'locked'); };
  const baseErr = C.err;
  C.err = function (/** @type {string} */ txt, /** @type {string} */ x) { chip('denied'); return baseErr(txt, x); };
  mountVerify(C);
  mountReset(C);

  function boot() {
    C.clearLog();
    C.out('styrigx space os 1.0 tty1', 'd');
    C.note(t('entry.typeHelp'), CMD.session);
  }

  function help() {
    C.out('<span class="sgx-entry-w">' + esc(CMD.session) + '</span> — ' + esc(t('help.session')) + ' · <span class="sgx-entry-dim">passkey / password / tempkey</span>');
    C.out('<span class="sgx-entry-w">' + esc(CMD.reset) + '</span> — ' + esc(t('help.reset')) + ' · <span class="sgx-entry-dim">recovery key</span>');
    C.out('<span class="sgx-entry-w">man ' + ADMIN_COMMAND + '</span> — ' + esc(t('help.man')) + ' · <span class="sgx-entry-w">clear</span> — ' + esc(t('help.clear')));
    C.note(t('help.entryNote'));
  }
  function man() {
    C.out(ADMIN_COMMAND.toUpperCase() + '(1)', 'd');
    C.out('NAME');
    C.out('    ' + esc(ADMIN_COMMAND + ' — ' + t('help.manName')));
    C.out('SYNOPSIS');
    C.out('    ' + esc(CMD.session + ' [passkey | password | tempkey]'));
    C.out('    ' + esc(CMD.reset));
    C.out('    ' + esc(CMD.reauth + ' [passkey | password]') + ' <span class="sgx-entry-dim">· ' + esc(t('help.manReauth')) + '</span>');
    C.out('(END)', 'd');
  }

  /** @param {string} raw */
  function runCmd(raw) {
    const line = normCmd(raw);
    C.echo(raw.replace(/\s+/g, ' ').trim());
    if (!line) return;
    const c = parseEntryCmd(line);
    if (c.cmd !== 'unknown') chip('locked');
    switch (c.cmd) {
      case 'help': help(); return;
      case 'man': man(); return;
      case 'clear': boot(); return;
      case 'session':
        C.setMode('busy');
        cfgReady.then(function () {
          C.toCmd();
          C.verify({ only: c.arg || '', lead: c.arg ? '' : t('session.lead'), done: unlock });
        });
        return;
      case 'reset': C.cmdReset(); return;
      default: C.err(tf('common.notFound', { x: raw.trim().split(' ')[0] }));
    }
  }

  /* 点终端任何地方 = 聚焦输入行（选项 / ^C 按钮由 term.js 接） */
  termEl.addEventListener('click', function (e) {
    const tg = /** @type {HTMLElement|null} */ (e.target);
    if (tg && tg.closest && tg.closest('button, input')) return;
    C.focusIn(true);
  });
  /* esc：退出当前命令（reset 里 = 离开 reset） */
  ov.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (C.interrupt()) e.preventDefault();
  });
  /* 焦点不在输入框时直接打字：转进输入行 */
  document.addEventListener('keydown', function (e) {
    if (done || !document.getElementById('sgx-entry') || C.mode === 'busy' || C.mode === 'done') return;
    const tg = /** @type {HTMLElement|null} */ (e.target);
    if (tg === input || (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (tg && tg.closest && tg.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      C.focusIn(true);
      if (!input.readOnly) input.value += e.key;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      C.focusIn(true);
    }
  });
  termEl.addEventListener('pointerup', function (e) {
    const tg = /** @type {HTMLElement|null} */ (e.target);
    if (tg && tg.closest && tg.closest('[data-term-cc], [data-term-pick]')) tapFeedback();
  });

  /* 底部语言：写偏好（同导航面板），换到另一种语言的同一页（查询串原样） */
  ov.querySelectorAll('.sgx-entry-lang').forEach(function (b) {
    b.addEventListener('click', function () {
      const l = b.getAttribute('data-lang') || '';
      const url = setLang(/** @type {any} */ (l));
      if (url && url !== location.pathname + location.search + location.hash) location.replace(url);
    });
  });

  /* 手机软键盘：输入行被键盘盖住时整组上移刚好够的距离（头像可以被顶出去） */
  /** @type {(() => void)|null} */ let kbStop = null;
  input.addEventListener('focus', function () {
    if (kbStop) return;
    try {
      kbStop = onKeyboardHeight(function (h) {
        try {
          stage.style.transform = '';
          if (!(h > 0)) return;
          const r = termEl.getBoundingClientRect();
          const over = r.bottom + 12 - (window.innerHeight - h);
          if (over > 0) stage.style.transform = 'translateY(' + Math.round(-over) + 'px)';
        } catch (e) {}
      });
    } catch (e) { kbStop = null; }
  });
  input.addEventListener('blur', function () {
    /* 整个页面失焦（Samsung Pass 自动填充 / 指纹窗口盖上来）不算离开输入框 */
    try { if (!document.hasFocus()) return; } catch (e) {}
    stage.style.transform = '';
    if (kbStop) { try { kbStop(); } catch (e) {} kbStop = null; }
  });

  /* ---------- 进站 / 会话 ---------- */
  let done = false;
  function cleanup() {
    if (kbStop) { try { kbStop(); } catch (e) {} kbStop = null; }
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.classList.remove('sgx-entry');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    bindAutoLock();
  }
  let granted = false;
  function grantedLines() {
    if (granted) return;
    granted = true;
    C.ok('✓ access granted');
    C.out('› booting space…', 'd');
    C.setMode('done');
  }
  /** @param {any} ans */
  function onServerOk(ans) {
    done = true;
    grantedLines();
    /* 这次是在锁屏上亲手进的（via 有值）→ 先放开机动画，放完（或被跳过）再交给 proceed；首帧对账 / 别的标签页进站不放 */
    if (via && !reducedMotion()) bootSequence(ans, function () { proceed(ans, doUnlockAnimation); });
    else proceed(ans, doUnlockAnimation);
  }
  /* 进站成功（密码 / 通行密钥 / 临时钥匙）：先向服务端确认会话真的生效，再按服务端给的 next 走；没确认到 → 停在锁屏报错，绝不跳转 */
  let via = '';
  /** @param {string} by */
  function unlock(by) {
    if (done) return;
    done = true;
    via = by || '';
    C.out('› ' + esc(t('entry.verifying')) + '…', 'd');
    C.setMode('busy');
    if (isLocal) {
      grantedLines();
      if (!reducedMotion()) bootSequence({ ok: true, by: via }, doUnlockAnimation);
      else doUnlockAnimation();
      return;
    }
    askServer().then(function (ans) {
      if (ans.ok) onServerOk(ans);
      else { done = false; C.err(t('entry.notRecognized')); C.toCmd(); }
    });
  }

  /* 锁屏显示期间（可能在别的标签页进站了）：回到前台 / 聚焦 / bfcache 恢复时对账，节流 1 秒；ok → proceed，否则保持锁屏 */
  let lastRecheck = 0;
  function recheckSession() {
    if (done || isLocal) return;
    const now = Date.now();
    if (now - lastRecheck < 1000) return;
    lastRecheck = now;
    askServer().then(function (ans) { if (!done && ans.ok) onServerOk(ans); });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') recheckSession(); });
  window.addEventListener('focus', recheckSession);
  window.addEventListener('pageshow', function (e) { if (e && e.persisted) recheckSession(); });

  /* ---------- 开机动画（解锁后一段加载动画；设计稿 entry-v2/boot.html?from=1）：逐行打印，任意键 / 点击跳过；减少动态效果时不放 ---------- */
  /** @type {HTMLElement|null} */ let bootEl = null;
  /** @param {{by?:string, exp?:number}} ans @param {() => void} then */
  function bootSequence(ans, then) {
    const by = String(ans.by || via || '');
    let sess = '';
    const left = Number(ans.exp || 0) - Date.now();
    if (left > 0 && left < 31 * 864e5) sess = left >= 36e5 ? Math.round(left / 36e5) + 'h' : Math.max(1, Math.ceil(left / 6e4)) + 'm';
    const ver = (by ? by + ' verified' : 'verified') + (sess ? ' · session ' + sess : '');
    const OK = ' <span class="sgx-entry-bok">ok</span>';
    const lines = [
      '<span class="sgx-entry-bh">&gt; styrigx space os — ' + esc(ADMIN_COMMAND) + '@space</span>',
      '<span class="sgx-entry-bok">&gt; ' + esc(ver) + '</span>',
      '&gt; mounting /space/blog ...' + OK,
      '&gt; mounting /space/curio ...' + OK,
      '&gt; mounting /space/daymark ...' + OK,
      '&gt; mounting /space/wild ...' + OK,
      '&gt; loading gray-ai ...' + OK,
      '&gt; welcome back, ' + esc(termUser) + '_',
    ];
    const el = document.createElement('div');
    el.id = 'sgx-entry-boot';
    el.className = 'sgx-entry-boot';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="sgx-entry-bout"><span class="sgx-entry-cur"></span></div>';
    ov.appendChild(el);
    bootEl = el;
    const outEl = /** @type {HTMLElement} */ (el.firstChild);
    try { if (document.activeElement && ov.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur(); } catch (e) {}
    requestAnimationFrame(function () { el.classList.add('is-on'); });
    let n = 0;
    let timer = 0;
    let finished = false;
    /** @param {number} k */
    function render(k) {
      outEl.innerHTML = lines.slice(0, k).map(function (l) { return '<div>' + l + '</div>'; }).join('') + '<span class="sgx-entry-cur"></span>';
      el.setAttribute('data-lines', String(k));
    }
    function finish() {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      document.removeEventListener('keydown', skip, true);
      document.removeEventListener('pointerdown', skip, true);
      then();
    }
    /** @param {Event} e */
    function skip(e) {
      if (finished) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (x) {}
      window.clearTimeout(timer);
      render(lines.length);
      finish();
    }
    document.addEventListener('keydown', skip, true);
    document.addEventListener('pointerdown', skip, true);
    function step() {
      render(++n);
      timer = window.setTimeout(n < lines.length ? step : finish, n < lines.length ? 190 : 520);
    }
    timer = window.setTimeout(step, 260);
  }

  /* 开锁动画：显示桌面 */
  function doUnlockAnimation() {
    grantedLines();
    if (bootEl && !reducedMotion()) {
      document.body.classList.remove('sgx-entry');
      ov.classList.add('sgx-entry-booted');
      window.setTimeout(cleanup, 520);
      return;
    }
    if (reducedMotion()) {
      ov.style.transition = 'opacity .25s ease';
      ov.style.opacity = '0';
      window.setTimeout(cleanup, 280);
    } else {
      document.body.classList.remove('sgx-entry');
      requestAnimationFrame(function () { requestAnimationFrame(function () { ov.classList.add('sgx-entry-out'); }); });
      window.setTimeout(cleanup, 450);
    }
  }

  /* ---------- 开机 ---------- */
  boot();
  C.setMode('cmd');
  /* 电脑上直接把光标放进命令行；触屏不自动聚焦（不一进来就弹键盘） */
  try { if (!window.matchMedia('(pointer: coarse)').matches) input.focus({ preventScroll: true }); } catch (e) {}

  /* 首帧对账：页面是 locked 或没有会话标记（unknown）时立刻问服务端；有效 → 直接按 next 走 */
  if (!isLocal) {
    askServer().then(function (ans) {
      if (!done && ans.ok) {
        try { console.warn('[sgx-entry] page said ' + pageState() + ' but session check ok'); } catch (e) {}
        onServerOk(ans);
      }
    });
  }
  return { _term: C };
}
