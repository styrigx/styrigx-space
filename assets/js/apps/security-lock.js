/**
 * @fileoverview 锁定屏幕管理页（2.4.0 安全与隐私，替代 /owner/）。
 * - 进入前底部弹层「验证身份」：使用通行密钥 / 使用根凭证（无通行密钥时只显示根凭证）；
 *   解锁密码不能进入此页。
 * - 验证后：解锁密码（弹层设置/修改，双输入框竖排，显示/隐藏，最少 8 位）；
 *   通行密钥列表（设备名可编辑、注册日期、可删除），底部「添加通行密钥」。
 * - 反馈一律 One UI 轻提示（toast）；localStorage 经 storage.js。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { followKeyboard } from '../shell/vk.js';
import { sgxNavigate } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, bindEyeButton, bindSubmitButton, showCenterDialog } from '../lib/dialog-behavior.js';
import { apiErrorText, needVerify, startDoorCountdown, refreshDoorCountdown } from './app-gate.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /* Phase 2 Item 7：站长凭证/锁屏凭证分模式。
     ?mode=owner → 站长凭证模式（管理 owner-pw + class=owner 通行密钥）；
     默认 → 锁屏凭证模式（管理 lock-pw + class=lock 通行密钥）。 */
  const MODE = (function () {
    try {
      return new URLSearchParams(location.search).get('mode') === 'owner' ? 'owner' : 'lock';
    } catch (e) {
      return 'lock';
    }
  })();
  const isOwnerMode = MODE === 'owner';
  /** 密码 kind：owner 模式用 'owner'，lock 模式用 'lock' */
  const pwKind = isOwnerMode ? 'owner' : 'lock';
  /** 状态接口：owner 模式读 /api/owner-status（lock-status 在 scope=root 不可读） */
  const statusApi = isOwnerMode ? '/api/owner-status' : '/api/lock-status';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-lockmgr').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    if (v) return v;
    /* 批次 A 收尾 #36：兜底不显示内部键名；键名只记诊断 */
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', k);
    return en ? 'Something went wrong, please retry' : '出错了，请重试';
  }
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  let hasPw = false;
  /** 2.10.0：全量通行密钥缓存（含应用类，供应用验证分组渲染） */
  let allKeys = [];
  /** 批次 A 验收修复 P0：本页通行密钥类别由页面决定（owner 模式 → 'owner'，
      默认锁屏模式 → 'lock'），不按票据 scope 推断；服务端按 pkClass + 票据双重校验。
      注：?mode=owner 无任何入口链接（站长凭证页走 door.js），此处仅保留兼容。 */
  const pageClass = isOwnerMode ? 'owner' : 'lock';
  const pkAddClass = pageClass;
  /** 2.10.0：应用白名单（与服务端一致，book 在列） */
  var APPS = [{ aud: 'book', name: 'Book' }];

  /* ---------- 通用 ---------- */
  /** @param {string} id @param {string} msg */
  function showErr(id, msg) {
    const e = $(id);
    if (e) {
      e.textContent = msg;
      e.hidden = false;
    }
  }
  /** @param {string} id */
  function hideErr(id) {
    const e = $(id);
    if (e) e.hidden = true;
  }
  /**
   * 统一解析 API 响应：{ status, json }，区分网络错误/服务器错误/业务错误。
   * @param {Response} r
   */
  function parseApi(r) {
    return r.text().then(function (txt) {
      let j = null;
      try {
        j = JSON.parse(txt);
      } catch (e) {}
      return { status: r.status, json: j };
    });
  }
  /** @param {string} url @param {any} body @param {boolean} [retried] */
  function api(url, body, retried) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    }).then(parseApi).then(function (res) {
      /* 定稿 #19：门内不自动发起验证。stepup-required 直接返回给调用方显示，
         不自动做 stepup 验证后重试。 */
      return res;
    });
  }

  /** @param {string} s */
  function b64urlToBuf(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  /** @param {ArrayBuffer} buf */
  function bufToB64url(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  /** @param {number} ts */
  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      const p = function (n) {
        return String(n).padStart(2, '0');
      };
      return en
        ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    } catch (e) {
      return '';
    }
  }
  /* D3：session/stepup-required/scope/by-root → needReauth，不显示通用错误。
     按 app-gate.js 注释本意：这 4 个码走重新验证流程，不向用户展示开发用语。 */
  function isReauthError(code) {
    return code === 'session' || code === 'stepup-required' || code === 'scope' || code === 'by-root';
  }
  /* 批次 A 收尾 E1：config 错误码映射成「服务器配置有误」，不再显示 gateSrvErr 原文。
     srvErr 改为 apiErrorText（config → errConfig →「服务器配置有误」）。 */
  function srvErr(code, status) {
    return apiErrorText(t, code, status);
  }

  /** 会话/票据失效 → 重新验证（批次 A 验收修复 #7：改走 app-gate.js 的 needVerify，
      和 door.js 一致；detail='owner-configured' 时 needVerify 显示明确文案）。
      A-1：按真实 code 传参（v1.0 §三 1c）——'session' 走会话弹框，
      'stepup-required'/'scope'/'by-root' 走验证弹框；单参调用（仅 reason，如 'owner-configured'）
      视为验证弹框。锁屏页无验证门可开：lockgate-* 元素在任何模板里都不存在，
      旧 openGate() 在 gateOpts 为 null 时会抛 TypeError。 */
  function needReauth(code, detail) {
    /* P2-14：先收起当前所有 sheet 再弹框，禁止弹层叠弹层 */
    closeOpenSheets();
    if (code === 'session') needVerify(t, 'session', detail);
    else needVerify(t, 'stepup', detail || code);
  }

  /**
   * P2-14：收起当前所有打开的 sheet（验证身份/密码/命名弹层）。
   * 切换弹层前调用，保证同一时刻只有一个弹层。
   */
  function closeOpenSheets() {
    ['lockpw-dlg', 'lockpkname-dlg', 'lockpkdel-dlg'].forEach(function (id) {
      const d = $(id);
      try {
        if (d && d.open) d.close();
      } catch (e) {}
    });
  }

  function enterMgr() {
    /* 本页有独立验证门；进管理区时去掉全局锁屏遮罩，避免盖住按钮 */
    try {
      const gl = document.getElementById('sgx-lock');
      if (gl) gl.remove();
      document.body.classList.remove('sgx-locked');
    } catch (e) {}
    $('lockmgr').hidden = false;
    startDoorCountdown(t);
    refreshStatus();
    refreshPkList();
  }

  /* 显示/隐藏眼睛（批次 A 验收修复 P2：bindEyeButton 统一接管图标 + 文案 + 复位） */
  const eyeResets = [];
  function bindEye(btn, input) {
    if (!btn || !input) return;
    eyeResets.push(bindEyeButton(btn, input, { showLabel: t('eyeShow'), hideLabel: t('eyeHide') }));
  }
  document.querySelectorAll('[data-eye]').forEach(function (b) {
    const inp = $(b.getAttribute('data-eye'));
    bindEye(b, inp);
  });

  /* ---------- 管理区 ---------- */
  var hasPk = false;
  function refreshStatus() {
    /* 状态接口按模式选择：owner 模式读 /api/owner-status（owner-pw + class=owner），
       lock 模式读 /api/lock-status（lock-pw + class=lock）。
       注意：lock-status 在 scope=root 票据下不可读，owner 模式必须用 owner-status。 */
    fetch(statusApi, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        /* 失败（401/503）时保持当前显示，不误报「未设置」 */
        if (!(j && j.ok)) return;
        hasPw = !!j.password;
        hasPk = !!j.passkey;
        const sub = $('lockmgr-pwsub');
        if (sub) sub.textContent = hasPw ? t('pwSet') : t('pwUnset');
        const title = $('lockpw-title');
        if (title) title.textContent = hasPw ? t('changeTitle') : t('setTitle');
        const delBtn = $('lockmgr-pwdel');
        if (delBtn) delBtn.hidden = !hasPw;
      })
      .catch(function () {});
  }

  /* 密码弹层 */
  const pwDlg = $('lockpw-dlg');
  /* P2-13：密码输入框聚焦时，密码弹层随键盘上移（双输入框共用同一弹层） */
  followKeyboard(pwDlg, [$('lockpw-1'), $('lockpw-2')]);
  function openPwDlg() {
    hideErr('lockpw-err');
    const a = $('lockpw-1'), b = $('lockpw-2');
    if (a) {
      a.value = '';
      a.type = 'password';
    }
    if (b) {
      b.value = '';
      b.type = 'password';
    }
    /* 重开弹层时眼睛按钮同步回密文态（eye-off + 显示密码） */
    eyeResets.forEach(function (reset) { try { reset(); } catch (e) {} });
    const title = $('lockpw-title');
    if (title) title.textContent = hasPw ? t('changeTitle') : t('setTitle');
    try {
      pwDlg.showModal();
    } catch (e) {}
    if (a) {
      try {
        a.focus({ preventScroll: true });
      } catch (e2) {}
    }
  }
  function closePwDlg(reason) {
    recordDialogClose('lockpw', reason || 'unknown');
    try {
      if (pwDlg.open) pwDlg.close();
    } catch (e) {}
  }
  if (pwDlg) {
    /* 批次 A 收尾 A1/A2：点遮罩只失焦不关闭；返回手势键盘开着先收键盘 */
    on(pwDlg, 'click', function (/** @type {MouseEvent} */ e) {
      onDialogBackdrop(e, pwDlg);
    });
    on(pwDlg, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, pwDlg, function (reason) { closePwDlg(reason); });
    });
    /* 批次 A 收尾 A3：右上角 × 关闭按钮 */
    const pwClose = pwDlg.querySelector('[data-dlg-close]');
    if (pwClose) on(pwClose, 'click', function () { closePwDlg('close-btn'); });
  }
  const pwRow = $('lockmgr-pwrow');
  if (pwRow) {
    const go = function () {
      openPwDlg();
    };
    on(pwRow, 'click', go);
    on(pwRow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }
  /* 删除解锁密码（两步确认） */
  const pwDel = $('lockmgr-pwdel');
  if (pwDel) {
    let armed = false;
    let armTimer = 0;
    const origText = pwDel.textContent;
    on(pwDel, 'click', function () {
      /* v1.1 §二.4：删最后一把锁屏密码 → 跳过「再点一次」，点「删除」直接弹确认框 */
      if (pwKind === 'lock' && !hasPk) {
        var resetArmed = function () { armed = false; pwDel.textContent = origText; pwDel.classList.remove('armed'); };
        showCenterDialog({
          title: t('lastKeyConfirmTitle'),
          desc: t('lastKeyConfirmDesc'),
          dismissible: true,
          onCancel: resetArmed,
          buttons: [
            { label: t('lastKeyConfirmCancel'), kind: 'ghost', onClick: resetArmed },
            { label: t('lastKeyConfirmDelete'), kind: 'primary', onClick: function () { doRemovePw(); } },
          ],
        });
        return;
      }
      if (!armed) {
        armed = true;
        /* 如果删完后密码和通行密钥都没了：lock 模式 → 锁屏只能通过重置锁屏重新设置；
           owner 模式 → 只能用根凭证进入。 */
        if (!hasPk) {
          pwDel.textContent = pwKind === 'lock' ? t('pwDelWarnLock') : t('pwDelWarn');
        } else {
          pwDel.textContent = t('pwDelAsk');
        }
        pwDel.classList.add('armed');
        armTimer = window.setTimeout(function () {
          armed = false;
          pwDel.textContent = origText;
          pwDel.classList.remove('armed');
        }, 5000);
        return;
      }
      window.clearTimeout(armTimer);
      doRemovePw();
      function doRemovePw() {
      api('/api/owner-password', { action: 'remove', kind: pwKind })
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pwDeleted'));
            /* 服务端删除成功后重新读状态刷新（KV 最终一致，边缘节点最多约 60 秒） */
            refreshStatus();
            refreshPkList();
            refreshDoorCountdown(t);
          } else if (j && isReauthError(j.error)) {
            needReauth(j && j.error, j && j.reason);
          } else {
            toast(srvErr(j && j.error, r.status));
          }
        })
        .catch(function () {
          toast(t('gateNetErr'));
        })
        .finally(function () {
          armed = false;
          pwDel.textContent = origText;
          pwDel.classList.remove('armed');
        });
      }
    });
  }
  /* Phase 2 Item 11：退出站长凭证（吊销 stepup 票据，回安全页）。
     说明：只清 sgx-stepup cookie，站长会话（sgx-verified）不变；
     再进需重新输根凭证。不影响锁屏解锁状态。 */
  const lockoutBtn = $('lockmgr-lockout');
  if (lockoutBtn) {
    on(lockoutBtn, 'click', function () {
      try {
        /* 清掉 stepup cookie（Path=/，与签发时一致） */
        document.cookie = 'sgx-stepup=; Path=/; Max-Age=0; SameSite=Lax';
        document.cookie = 'sgx-stepup=; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax';
      } catch (e) {}
      /* 回安全页 */
      sgxNavigate(document.documentElement.lang === 'en' ? '/en/settings/security/' : '/settings/security/', 'security-lock.js:544', 'lockout');
    });
  }
  function submitPw() {
    const a = $('lockpw-1'), b = $('lockpw-2');
    const va = a ? a.value : '', vb = b ? b.value : '';
    hideErr('lockpw-err');
    if (va.length < 8) {
      showErr('lockpw-err', t('pwMin8'));
      return;
    }
    if (va !== vb) {
      showErr('lockpw-err', t('pwMismatch'));
      return;
    }
    const action = hasPw ? 'change' : 'set';
    const body = action === 'set'
      ? { action: 'set', kind: pwKind, password: va }
      : { action: 'change', kind: pwKind, newPassword: va };
    api('/api/owner-password', body)
      .then(function (res) {
        const j = res.json;
        if (!j) {
          showErr('lockpw-err', srvErr(null, res.status));
          return;
        }
        if (j.ok) {
          closePwDlg('success');
          hasPw = true;
          refreshStatus();
          refreshDoorCountdown(t);
          toast(hasPw && action === 'change' ? t('pwChanged') : t('pwSaved'));
        } else if (isReauthError(j.error)) {
          closePwDlg('success');
          needReauth(j && j.error, j && j.reason);
        } else if (j.error === 'exists' && action === 'set') {
          /* 并发已设置 → 改走 change */
          hasPw = true;
          refreshStatus();
          showErr('lockpw-err', t('pwMin8'));
        } else {
          showErr('lockpw-err', srvErr(j.error, res.status));
        }
      })
      .catch(function () {
        showErr('lockpw-err', t('gateNetErr'));
      });
  }
  const pwGo = $('lockpw-go');
  /* 批次 A 收尾：pointerup（要求 pointerdown 也在按钮）+ click 兜底，去重只提交一次 */
  if (pwGo) bindSubmitButton(pwGo, submitPw);

  /* 通行密钥命名弹层 */
  let pkNameCredId = null;
  let pkNamePrefill = '';
  /* 生成预填名：<密码管理器> · <设备>（注册前调用，随 register 一起提交） */
  function genPkPrefillName() {
    let device = '';
    try {
      if (navigator.userAgentData && navigator.userAgentData.platform) {
        device = navigator.userAgentData.platform;
      }
    } catch (e) {}
    /* provider 此时未知（服务端识别 AAGUID 后才知道），先只用设备名 */
    return device || '通行密钥';
  }
  function openPkNameDlg(credId, prefill) {
    pkNameCredId = credId;
    pkNamePrefill = prefill || '';
    const dlg = $('lockpkname-dlg');
    const input = $('lockpkname-input');
    if (!dlg || !input) return;
    input.value = pkNamePrefill;
    /* 异步补设备型号（userAgentData 高熵值） */
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        navigator.userAgentData.getHighEntropyValues(['model']).then(function (ua) {
          if (ua && ua.model && input && !input.value) {
            input.value = ua.model;
            pkNamePrefill = ua.model;
          }
        }).catch(function () {});
      }
    } catch (e) {}
    hideErr('lockpkname-err');
    try { dlg.showModal(); } catch (e) {}
    try { input.focus({ preventScroll: true }); } catch (e2) {}
  }
  function closePkNameDlg(reason) {
    recordDialogClose('lockpkname', reason || 'unknown');
    const dlg = $('lockpkname-dlg');
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
    pkNameCredId = null;
    pkNamePrefill = '';
  }
  /* 批次 A 收尾 A1/A2/A3：命名弹层遮罩不关、返回先收键盘、× 关闭 */
  const pkNameDlg = $('lockpkname-dlg');
  if (pkNameDlg) {
    on(pkNameDlg, 'click', function (/** @type {MouseEvent} */ e) {
      onDialogBackdrop(e, pkNameDlg);
    });
    on(pkNameDlg, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, pkNameDlg, function (reason) { closePkNameDlg(reason); });
    });
    const pkNameClose = pkNameDlg.querySelector('[data-dlg-close]');
    if (pkNameClose) on(pkNameClose, 'click', function () { closePkNameDlg('close-btn'); });
  }
  const pkNameSave = $('lockpkname-save');
  if (pkNameSave) {
    on(pkNameSave, 'click', function () {
      const input = $('lockpkname-input');
      let name = input ? input.value : '';
      /* 清理：去首尾空格和控制字符 */
      name = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
      if (!name) {
        showErr('lockpkname-err', t('pkNameEmpty'));
        return;
      }
      if (!pkNameCredId) {
        closePkNameDlg('success');
        return;
      }
      /* 没改名就不调 rename（注册时已带预填名） */
      if (name === pkNamePrefill) {
        toast(t('pkRegistered'));
        closePkNameDlg('success');
        refreshPkList();
        return;
      }
      api('/api/owner-passkey', { action: 'rename', credId: pkNameCredId, name: name })
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pkRegistered'));
            closePkNameDlg('success');
            refreshPkList();
            refreshDoorCountdown(t);
          } else if (j && isReauthError(j.error)) {
            needReauth(j && j.error, j && j.reason);
          } else if (j && j.error === 'not-found') {
            /* KV 最终一致：刚注册的 key 可能暂时读不到 */
            showErr('lockpkname-err', t('pkRetryLater'));
          } else if (!j) {
            showErr('lockpkname-err', t('gateNetErr'));
          } else {
            showErr('lockpkname-err', srvErr(j.error, r.status));
          }
        })
        .catch(function () {
          showErr('lockpkname-err', t('gateNetErr'));
        });
    });
  }
  const pkNameSkip = $('lockpkname-skip');
  if (pkNameSkip) {
    on(pkNameSkip, 'click', function () {
      /* 跳过：用预填名（已在注册时设为默认值） */
      closePkNameDlg('success');
      toast(t('pkRegistered'));
      refreshPkList();
    });
  }
  /* P2-13：命名输入框聚焦时，命名弹层随键盘上移 */
  followKeyboard($('lockpkname-dlg'), $('lockpkname-input'));

  /* 应用钥匙删除确认弹层（站内确认，替代原生 confirm；返回 Promise<boolean>） */
  let pkDelResolve = null;
  function openPkDelDlg() {
    return new Promise(function (resolve) {
      pkDelResolve = resolve;
      const desc = $('lockpkdel-desc');
      if (desc) desc.textContent = t('pkDelConfirm');
      const dlg = $('lockpkdel-dlg');
      if (!dlg) { resolve(false); return; }
      try { dlg.showModal(); } catch (e) {}
    });
  }
  function closePkDelDlg(ok, reason) {
    recordDialogClose('lockpkdel', reason || 'unknown');
    const dlg = $('lockpkdel-dlg');
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
    if (pkDelResolve) { pkDelResolve(!!ok); pkDelResolve = null; }
  }
  const pkDelCancel = $('lockpkdel-cancel');
  if (pkDelCancel) on(pkDelCancel, 'click', function () { closePkDelDlg(false, 'cancel-btn'); });
  const pkDelOk = $('lockpkdel-ok');
  if (pkDelOk) on(pkDelOk, 'click', function () { closePkDelDlg(true, 'success'); });
  const pkDelDlg = $('lockpkdel-dlg');
  if (pkDelDlg) {
    /* 批次 A 收尾 A1/A2/A3：删除确认遮罩不关、返回先收键盘、× 关闭 */
    on(pkDelDlg, 'click', function (/** @type {MouseEvent} */ e) {
      onDialogBackdrop(e, pkDelDlg);
    });
    on(pkDelDlg, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, pkDelDlg, function (reason) { closePkDelDlg(false, reason); });
    });
    const pkDelClose = pkDelDlg.querySelector('[data-dlg-close]');
    if (pkDelClose) on(pkDelClose, 'click', function () { closePkDelDlg(false, 'close-btn'); });
  }

  /* 应用验证分组：list 只返回本页类别，app 类需单独发一次 list（否则分组误显示「未添加」） */
  function refreshAppKeys() {
    if (!$('lockmgr-applist')) return;
    api('/api/owner-passkey', { action: 'list', pkClass: 'app' })
      .then(function (res) {
        const j = res.json;
        if (!j) return;
        if (j.error && isReauthError(j.error)) {
          needReauth(j.error, j.reason);
          return;
        }
        allKeys = allKeys.concat((j.ok && j.keys) || []);
        renderAppList();
      })
      .catch(function () {});
  }

  /* 通行密钥列表（批次 A 验收修复 P0：list 带页面类别，只显示本页类） */
  function refreshPkList() {
    const ul = $('lockmgr-pklist');
    const empty = $('lockmgr-pkempty');
    api('/api/owner-passkey', { action: 'list', pkClass: pageClass })
      .then(function (res) {
        const j = res.json;
        if (!j) return;
        if (j.error && isReauthError(j.error)) {
          needReauth(j && j.error, j && j.reason);
          return;
        }
        const keys = ((j.ok && j.keys) || []).filter(function (k) {
          return (k.class || 'lock') === pageClass;
        });
        if (!ul) return;
        ul.innerHTML = '';
        // 缓存本页类 keys；应用类由 refreshAppKeys 单独拉取后合并
        allKeys = (j.ok && j.keys) || [];
        refreshAppKeys();
        keys.forEach(function (k) {
          const li = document.createElement('li');
          li.className = 'lockmgr-pkitem';
          const nameWrap = document.createElement('div');
          nameWrap.className = 'lockmgr-pkname';
          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.value = k.name || '';
          nameInput.placeholder = t('pkUnnamed');
          nameInput.maxLength = 40;
          nameInput.setAttribute('aria-label', t('pkUnnamed'));
          let lastSaved = k.name || '';
          const saveName = function () {
            const v = nameInput.value.trim();
            if (v === lastSaved) return;
            api('/api/owner-passkey', { action: 'rename', credId: k.credId, name: v })
              .then(function (r2) {
                const jj = r2.json;
                if (jj && jj.ok) {
                  lastSaved = v;
                  toast(t('pkRenamed'));
                } else if (jj && isReauthError(jj.error)) {
                  needReauth(jj.error, jj.reason);
                } else {
                  nameInput.value = lastSaved;
                }
              })
              .catch(function () {
                nameInput.value = lastSaved;
              });
          };
          on(nameInput, 'change', saveName);
          on(nameInput, 'keydown', function (/** @type {KeyboardEvent} */ e) {
            if (e.key === 'Enter') {
              e.preventDefault();
              nameInput.blur();
            }
            e.stopPropagation();
          });
          on(nameInput, 'click', function (e) {
            e.stopPropagation();
          });
          const meta = document.createElement('span');
          meta.className = 'lockmgr-pkdate';
          /* 副标题：provider + 创建于 + 最近使用（lastUsedAt 为 0 显示“尚未使用”） */
          let metaText = '创建于 ' + fmtDate(k.createdAt);
          if (k.lastUsedAt) {
            metaText += ' · 最近使用 ' + fmtDate(k.lastUsedAt);
          } else {
            metaText += ' · ' + t('pkNeverUsed');
          }
          /* provider 显示（如果有） */
          if (k.provider) {
            metaText = k.provider + ' · ' + metaText;
          }
          meta.textContent = metaText;
          nameWrap.appendChild(nameInput);
          nameWrap.appendChild(meta);
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'lockmgr-pkdel';
          del.textContent = t('pkDel');
          let armed = false;
          let armTimer = 0;
          on(del, 'click', function (e) {
            e.stopPropagation();
            /* v1.1 §二.4：删最后一把锁屏钥匙 → 跳过「再点一次」，点「删除」直接弹确认框 */
            if (pageClass === 'lock' && keys.length <= 1 && !hasPw) {
              var resetPkArmed = function () { armed = false; del.textContent = t('pkDel'); del.classList.remove('armed'); };
              showCenterDialog({
                title: t('lastKeyConfirmTitle'),
                desc: t('lastKeyConfirmDesc'),
                dismissible: true,
                onCancel: resetPkArmed,
                buttons: [
                  { label: t('lastKeyConfirmCancel'), kind: 'ghost', onClick: resetPkArmed },
                  { label: t('lastKeyConfirmDelete'), kind: 'primary', onClick: function () { doDeleteKey(); } },
                ],
              });
              return;
            }
            if (!armed) {
              armed = true;
              del.textContent = t('pkDelAsk');
              del.classList.add('armed');
              armTimer = window.setTimeout(function () {
                armed = false;
                del.textContent = t('pkDel');
                del.classList.remove('armed');
              }, 3000);
              return;
            }
            window.clearTimeout(armTimer);
            doDeleteKey();
            function doDeleteKey() {
            api('/api/owner-passkey', { action: 'delete', credId: k.credId })
              .then(function (r2) {
                const jj = r2.json;
                if (jj && jj.ok) {
                  toast(t('pkDeleted'));
                  /* Samsung Pass 同步：通知密码管理器删掉这把密钥 */
                  try {
                    if (window.PublicKeyCredential && typeof PublicKeyCredential.signalUnknownCredential === 'function') {
                      PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: k.credId }).catch(function () {});
                    } else {
                      toast(t('pkDelManual'));
                    }
                  } catch (e) {}
                  /* 服务端删除成功后重新读列表刷新（KV 最终一致，边缘节点最多约 60 秒） */
                  refreshPkList();
                  refreshStatus();
                  refreshDoorCountdown(t);
                } else if (jj && isReauthError(jj.error)) {
                  needReauth(jj.error, jj.reason);
                } else if (jj && jj.error === 'not-found') {
                  toast(t('pkRetryLater'));
                } else if (!jj) {
                  toast(t('gateNetErr'));
                } else {
                  toast(srvErr(jj.error, r2.status));
                }
              })
              .catch(function () {
                toast(t('gateNetErr'));
              });
            }
          });
          li.appendChild(nameWrap);
          li.appendChild(del);
          ul.appendChild(li);
        });
        ul.hidden = keys.length === 0;
        if (empty) empty.hidden = keys.length !== 0;
      })
      .catch(function () {});
  }

  /* 2.10.0：应用验证分组（每应用一行，可单独添加/删除钥匙；增删先过 stepup） */
  function renderAppList() {
    const ul = $('lockmgr-applist');
    if (!ul) return;
    ul.innerHTML = '';
    APPS.forEach(function (app) {
      const appKeys = allKeys.filter(function (k) {
        return (k.class || 'lock') === 'app' && k.aud === app.aud;
      });
      const li = document.createElement('li');
      li.className = 'lockmgr-pkitem';
      const nameWrap = document.createElement('div');
      nameWrap.className = 'lockmgr-pkname';
      const label = document.createElement('span');
      label.textContent = app.name + (appKeys.length ? '（' + appKeys.length + '）' : '（未添加）');
      nameWrap.appendChild(label);
      li.appendChild(nameWrap);
      const btnWrap = document.createElement('div');
      if (appKeys.length === 0) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'lockmgr-add';
        add.textContent = '＋ 添加' + app.name + '的钥匙';
        on(add, 'click', function () {
          addAppKey(app.aud);
        });
        btnWrap.appendChild(add);
      } else {
        appKeys.forEach(function (k) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'lockmgr-del';
          del.textContent = '删除';
          del.setAttribute('aria-label', '删除' + app.name + '的钥匙');
          on(del, 'click', function () {
            openPkDelDlg().then(function (confirmed) {
              if (!confirmed) return;
              api('/api/owner-passkey', { action: 'delete', credId: k.credId })
                .then(function (r2) {
                  const jj = r2.json;
                  if (jj && jj.ok) {
                    toast(t('pkDeleted') || '已删除');
                    refreshPkList();
                    refreshDoorCountdown(t);
                  } else if (jj && isReauthError(jj.error)) {
                    needReauth(jj.error, jj.reason);
                  } else if (jj && jj.error === 'not-found') {
                    /* KV 最终一致：刚注册的 key 可能暂时读不到 */
                    toast(t('pkRetryLater'));
                  } else if (!jj) {
                    toast(t('gateNetErr'));
                  } else {
                    toast(srvErr(jj.error, r2.status));
                  }
                })
                .catch(function () {
                  toast(t('gateNetErr'));
                });
            });
          });
          btnWrap.appendChild(del);
        });
      }
      li.appendChild(btnWrap);
      ul.appendChild(li);
    });
  }

  /* 2.10.0：添加应用类通行密钥（aud 必须在白名单；服务端再校验） */
  function addAppKey(aud) {
    if (!window.PublicKeyCredential) {
      toast(t('pkNoSupport'));
      return;
    }
    api('/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'app', aud: aud })
      .then(function (res) {
        const ch = res.json;
        if (!ch || !ch.ok) throw new Error((ch && ch.error) || 'challenge');
        return navigator.credentials.create({
          publicKey: {
            challenge: b64urlToBuf(ch.challenge),
            rp: { id: ch.rpId, name: ch.rp.name },
            user: {
              id: b64urlToBuf(ch.user.id),
              name: ch.user.name,
              displayName: ch.user.displayName,
            },
            pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
            excludeCredentials: (ch.excludeCredentials || []).map(function (c) {
              return { id: b64urlToBuf(c.id), type: c.type };
            }),
            timeout: 60000,
          },
        }).then(function (cred) {
          return { cred: cred, cid: ch.cid };
        });
      })
      .then(function (r2) {
        const cred = r2.cred;
        return api('/api/owner-passkey', {
          action: 'register',
          cid: r2.cid,
          credential: {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            response: {
              clientDataJSON: bufToB64url(cred.response.clientDataJSON),
              attestationObject: bufToB64url(cred.response.attestationObject),
            },
          },
        });
      })
      .then(function (res) {
        if (res.json && res.json.ok) {
          toast(t('pkRegistered') || '已添加');
          refreshPkList();
          refreshDoorCountdown(t);
        } else if (res.json && isReauthError(res.json.error)) {
          needReauth(res.json.error, res.json.reason);
        } else {
          const code = (res.json && res.json.error) || 'failed';
          toast((t('gateSrvErr') || '失败') + ': ' + code);
        }
      })
      .catch(function (e) {
        const code = e && e.code ? e.code : null;
        toast((t('gateNetErr') || '网络错误') + (code ? ': ' + code : ''));
      });
  }

  /* 添加通行密钥 */
  const pkAdd = $('lockmgr-pkadd');
  if (pkAdd) {
    on(pkAdd, 'click', function () {
      if (!window.PublicKeyCredential) {
        toast(t('pkNoSupport'));
        return;
      }
      /* 2.10.0：无 token 检查；api() 在 stepup-required 时自动验证后重试。
         pkClass 按当前管理区决定：scope=root 时为 owner（站长通行密钥），
         否则为 lock。服务端会按 stepup scope 校验类别。 */
      api('/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: pkAddClass })
        .then(function (res) {
          const ch = res.json;
          if (!ch) throw { kind: 'server' };
          if (!ch.ok) {
            if (isReauthError(ch.error)) throw { kind: 'reauth', code: ch.error, reason: ch.reason };
            throw { kind: 'server' };
          }
          /* 服务端下发 rp.id、用户信息、excludeCredentials；前端不硬编码、不回落 */
          const rpId = ch.rpId;
          const user = ch.user || {};
          const rp = ch.rp || {};
          const exclude = (ch.excludeCredentials || []).map(function (c) {
            return { id: b64urlToBuf(c.id), type: c.type };
          });
          return navigator.credentials
            .create({
              publicKey: {
                challenge: b64urlToBuf(ch.challenge),
                rp: { name: rp.name || 'Styrigx', id: rpId },
                user: {
                  id: b64urlToBuf(user.id),
                  name: user.name || 'lockkey',
                  displayName: user.displayName || 'Sloan Gray',
                },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
                excludeCredentials: exclude,
                attestation: 'none',
                timeout: 60000,
              },
            })
            .then(function (cred) {
              return { cred: cred, cid: ch.cid };
            }, function (e) {
              if (e && e.name === 'NotAllowedError') throw { kind: 'cancelled' };
              if (e && e.name === 'InvalidStateError') throw { kind: 'already' };
              if (e && e.name === 'NotSupportedError') throw { kind: 'nosupport' };
              throw { kind: 'failed' };
            });
        })
        .then(function (r2) {
          const cred = r2.cred;
          /* 注册时直接带预填名（服务端已支持 body.name） */
          const prefill = genPkPrefillName();
          return api('/api/owner-passkey', {
            action: 'register',
            cid: r2.cid,
            name: prefill,
            credential: {
              id: cred.id,
              rawId: bufToB64url(cred.rawId),
              response: {
                clientDataJSON: bufToB64url(cred.response.clientDataJSON),
                attestationObject: bufToB64url(cred.response.attestationObject),
              },
              type: cred.type,
            },
          }).then(function (res) {
            return { res: res, prefill: prefill };
          });
        })
        .then(function (r3) {
          const j = r3.res.json;
          if (j && j.ok) {
            /* 注册成功 → 弹出命名弹层（预填名已提交，用户改名才调 rename） */
            openPkNameDlg(j.credId, r3.prefill);
            refreshPkList();
            refreshDoorCountdown(t);
          } else if (j && isReauthError(j.error)) {
            needReauth(j && j.error, j && j.reason);
          } else {
            toast(srvErr(j && j.error, r.status));
          }
        })
        .catch(function (e) {
          if (!e) return;
          if (e.kind === 'cancelled') toast(t('gateCancelled'));
          else if (e.kind === 'already') toast(t('pkAlready'));
          else if (e.kind === 'nosupport') toast(t('pkNoSupport'));
          else if (e.kind === 'reauth') needReauth(e.code, e.reason);
          else if (e.kind === 'server') toast(srvErr(e.code));
          else if (e.kind === 'failed') toast(t('pkFailed'));
          else toast(t('gateNetErr'));
        });
    });
  }

  /* Phase 2 Item 7：owner 模式的 UI 调整 */
  if (isOwnerMode) {
    /* 标题：站长凭证 */
    try {
      document.title = (en ? 'Owner credential' : '站长凭证') + ' - ' + document.title.split(' - ').slice(1).join(' - ');
    } catch (e) {}
    /* 隐藏应用验证分组（应用门独立，站长模式只管 owner 凭证） */
    const appSec = $('lockmgr-appsec');
    if (appSec) {
      appSec.hidden = true;
      const appTitle = appSec.previousElementSibling;
      if (appTitle && appTitle.classList.contains('set-gh')) appTitle.hidden = true;
      const appNote = appSec.nextElementSibling;
      if (appNote && appNote.classList.contains('sec-note')) appNote.hidden = true;
    }
  }

  /* Phase 2 Item 8：进入时先试状态接口（需有效 stepup/会话）。
     成功 → 直接进管理区（跳过验证门，避免第 3 次根凭证）；
     401 → 显示验证门（只剩通行密钥入口）。 */
  fetch(statusApi, { method: 'GET', credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.ok) {
        enterMgr();
      } else {
        /* 批次 A 验收修复 #7：探针失败走 needVerify，不开已删除的验证门 */
        needReauth(j && j.error, j && j.reason);
      }
    })
    .catch(function () {
      /* A-1：探针网络失败 ≠ 过期：提示网络错误，留页不弹框、不自动跳 */
      toast(t('gateNetErr'));
    });
})();
