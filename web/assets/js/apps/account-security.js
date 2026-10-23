/**
 * @fileoverview 账号 → 安全与隐私（/account/security/）：管理账号凭证（AccountKey）。
 *
 * - 账号密码：设置 / 修改（根凭证登录时为「重置」，恢复路径）
 * - 账号通行密钥：添加（注册成功弹命名弹层，预填设备名；改了名才调 rename）、
 *   列表内点名字直接改名（失焦 / 回车保存）、两步确认删除
 * - 命名弹层与锁屏页同一套行为：A1 遮罩不关、A2 返回先收键盘、A3 × 关闭，弹层随键盘上移
 * - 门（安全操作）：进页 GET /api/account —— 没有账号会话 → 跳账号页 ?return=<本页> 登录后回来；
 *   有账号会话但没有有效门票 → 显示验证行（账号通行密钥 / 账号密码 / 根凭证，设了哪个显示哪个，
 *   都没设只显示根凭证；door:true 换 3 分钟账号门票），通过后显示管理区 + 倒计时胶囊；
 *   到点 / 改动返回 403 door → 回到验证行（提示「验证已过期」）。
 *   离开本页（pagehide）→ door-clear 立即作废门票；从历史返回（bfcache）重新读状态，需要再验证。
 * - list 返回账号 handle → signalCurrentUserDetails（account-common.js）让密码管理器把旧条目改名 AccountKey
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { followKeyboard } from '../shell/vk.js';
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { bindDataEyes, createSetPwDialog, newPwError } from '../lib/auth-flow.js';
import { bindSubmitButton, onDialogBackdrop, onDialogCancel, recordDialogClose } from '../lib/dialog-behavior.js';
import { accountUrl, createT, signalAccountName } from './account-common.js';
import { ACCOUNT_API, postJSON, errText as errTextT } from '../lib/account-api.js';
import { accountSubmitters, renderAccountMethods, visibleKinds } from '../lib/account-methods.js';

(function () {
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  const root = $('acct-sec');
  if (!root) return;
  /** @param {string} [code] @param {number} [status] */
  function errText(code, status) {
    return errTextT(t, code, status);
  }

  /** 回账号页登录，登录后回本页 */
  function goLogin() {
    sgxReplace(accountUrl(en) + '?return=' + encodeURIComponent(location.pathname));
  }

  /* ================= 门：验证行 + 倒计时 ================= */
  const doorEl = $('acct-door');
  const doorMethodsEl = $('acct-door-methods');
  const doorNotice = $('acct-door-notice');
  const doorSubmit = accountSubmitters(t, { door: true });
  /** GET /api/account 最近一次结果 */
  let status = null;
  let doorMethods = null;
  let cdEl = null;
  let cdTimer = 0;
  let cdExp = 0;

  function stopCountdown() {
    if (cdTimer) window.clearInterval(cdTimer);
    cdTimer = 0;
    if (cdEl) {
      try { cdEl.remove(); } catch (e) {}
      cdEl = null;
    }
  }
  /** @param {number} ms */
  function fmtLeft(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function tickCountdown() {
    if (!cdEl) return;
    const left = cdExp - Date.now();
    if (left <= 0) {
      /* 到点：回到门口重新验证 */
      showDoor(t('doorExpired'));
      return;
    }
    cdEl.classList.toggle('sgx-countdown-warn', left <= 30000);
    const tx = cdEl.querySelector('.sgx-door-countdown-text');
    if (tx) tx.textContent = t('doorCountdown').replace('{m}', fmtLeft(left));
  }
  /** 门内倒计时胶囊（与锁屏凭证门同一套样式），以服务端 expiresAt 为准 @param {number} expiresAt */
  function startCountdown(expiresAt) {
    stopCountdown();
    cdExp = expiresAt;
    const el = document.createElement('div');
    el.id = 'sgx-door-countdown';
    el.className = 'sgx-door-countdown';
    el.setAttribute('role', 'timer');
    el.innerHTML = '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span><span class="sgx-door-countdown-text"></span>';
    const layout = document.querySelector('.acct-layout');
    if (layout) layout.insertBefore(el, layout.firstChild);
    cdEl = el;
    tickCountdown();
    cdTimer = window.setInterval(tickCountdown, 1000);
  }

  /** 显示门口（验证行）。@param {string} [notice] */
  function showDoor(notice) {
    stopCountdown();
    root.hidden = true;
    if (!doorEl || !doorMethodsEl) return;
    if (doorMethods) doorMethods.collapse();
    doorMethods = renderAccountMethods({
      el: doorMethodsEl,
      t: function (k) { return k === 'verifyBtn' ? t('doorVerifyBtn') : t(k); },
      en: en,
      kinds: visibleKinds(status),
      submit: doorSubmit,
      onSuccess: function () { loadStatus(); },
    });
    if (doorNotice) {
      doorNotice.textContent = notice || '';
      doorNotice.hidden = !notice;
    }
    doorEl.hidden = false;
  }

  /** 进门：显示管理区 + 倒计时 @param {any} j */
  function enterRoom(j) {
    if (doorEl) doorEl.hidden = true;
    sessBy = j.session.by || '';
    hasPw = !!j.password;
    renderPwRow();
    root.hidden = false;
    startCountdown(j.door.expiresAt);
    refreshKeys();
  }

  /**
   * 管理接口统一错误处理：账号会话失效 → 回账号页登录；门票没了/过期 → 回门口；lock 会话失效 → 去锁屏。
   * @returns {boolean} 已处理
   */
  function handleAuthError(res) {
    const code = res && res.j && res.j.error;
    if (code === 'account') {
      goLogin();
      return true;
    }
    if (code === 'door') {
      showDoor(t('doorExpired'));
      return true;
    }
    if (code === 'session') {
      toast(t('sessExp'));
      sgxReplace('/?lock=1&return=' + encodeURIComponent(location.pathname));
      return true;
    }
    return false;
  }

  /** @param {number} ts */
  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      const p = function (n) { return String(n).padStart(2, '0'); };
      return en
        ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    } catch (e) {
      return '';
    }
  }

  /** 名字规则与服务端一致：去控制字符、去首尾空格、限 40 字 */
  function cleanName(v) {
    return String(v || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
  }

  /* ================= 账号密码 ================= */
  let hasPw = false;
  let sessBy = '';
  const eyeResets = bindDataEyes(t);
  const pwDialog = createSetPwDialog({
    $: $,
    t: function (k) {
      /* 根凭证登录时标题为「重置账号密码」（恢复路径） */
      if (k === 'changeTitle' && sessBy === 'root') return t('resetTitle');
      return t(k);
    },
    hideErr: function (id) { const e = $(id); if (e) e.hidden = true; },
    followKeyboard: followKeyboard,
    eyeResets: eyeResets,
    hasPw: function () { return hasPw; },
  });

  function renderPwRow() {
    const sub = $('lockmgr-pwsub');
    if (sub) sub.textContent = hasPw ? t('pwSet') : t('pwUnset');
  }

  function submitPw() {
    const a = /** @type {HTMLInputElement|null} */ ($('lockpw-1'));
    const b = /** @type {HTMLInputElement|null} */ ($('lockpw-2'));
    const va = a ? a.value : '';
    const vb = b ? b.value : '';
    const errEl = $('lockpw-err');
    if (errEl) errEl.hidden = true;
    const showErr = function (msg) {
      if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
      }
    };
    const pe = newPwError(va, vb);
    if (pe) {
      showErr(t(pe));
      return;
    }
    postJSON(ACCOUNT_API, { action: 'password', password: va }).then(function (res) {
      if (res.j && res.j.ok) {
        pwDialog.close('success');
        toast(res.j.changed ? t('pwChanged') : t('pwSaved'));
        hasPw = true;
        renderPwRow();
        return;
      }
      if (handleAuthError(res)) {
        pwDialog.close('reverify');
        return;
      }
      showErr(errText(res.j && res.j.error, res.s));
    }, function () {
      showErr(t('errNetwork'));
    });
  }
  const pwGo = $('lockpw-go');
  if (pwGo) bindSubmitButton(pwGo, submitPw);

  /* ================= 账号通行密钥 ================= */
  function refreshKeys() {
    return postJSON(ACCOUNT_API, { action: 'list' }).then(function (res) {
      if (handleAuthError(res)) return;
      if (!(res.j && res.j.ok)) return;
      signalAccountName(res.j);
      const ul = $('lockmgr-pklist');
      const empty = $('lockmgr-pkempty');
      const keys = res.j.keys || [];
      if (ul) {
        ul.innerHTML = '';
        keys.forEach(function (k) { ul.appendChild(keyItem(k)); });
        ul.hidden = keys.length === 0;
      }
      if (empty) empty.hidden = keys.length !== 0;
    }, function () {});
  }

  function keyItem(k) {
    const li = document.createElement('li');
    li.className = 'lockmgr-pkitem';
    const nameWrap = document.createElement('div');
    nameWrap.className = 'lockmgr-pkname';
    /* 与锁屏页一致：名字是输入框，点开直接改，失焦/回车保存 */
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = k.name || '';
    nameInput.placeholder = t('pkUnnamed');
    nameInput.maxLength = 40;
    nameInput.setAttribute('aria-label', t('pkNameAria'));
    let lastSaved = k.name || '';
    const saveName = function () {
      const v = cleanName(nameInput.value);
      if (v === lastSaved) {
        nameInput.value = lastSaved;
        return;
      }
      if (!v) {
        nameInput.value = lastSaved;
        toast(t('pkNameEmpty'));
        return;
      }
      postJSON(ACCOUNT_API, { action: 'rename', credId: k.credId, name: v }).then(function (res) {
        if (res.j && res.j.ok) {
          lastSaved = v;
          nameInput.value = v;
          toast(t('pkRenamed'));
          return;
        }
        nameInput.value = lastSaved;
        if (handleAuthError(res)) return;
        toast(res.j && res.j.error === 'params' ? t('pkNameEmpty') : errText(res.j && res.j.error, res.s));
      }, function () {
        nameInput.value = lastSaved;
        toast(t('errNetwork'));
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
    on(nameInput, 'click', function (e) { e.stopPropagation(); });
    const meta = document.createElement('span');
    meta.className = 'lockmgr-pkdate';
    let metaText = t('created') + fmtDate(k.createdAt);
    metaText += ' · ' + (k.lastUsedAt ? t('lastUsed') + fmtDate(k.lastUsedAt) : t('pkNeverUsed'));
    if (k.provider) metaText = k.provider + ' · ' + metaText;
    meta.textContent = metaText;
    nameWrap.appendChild(nameInput);
    nameWrap.appendChild(meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lockmgr-pkdel';
    del.textContent = t('pkDel');
    del.setAttribute('aria-label', t('pkDel') + ' ' + (k.name || t('pkUnnamed')));
    /* 两步确认删除 */
    let armed = false;
    let armTimer = 0;
    on(del, 'click', function (e) {
      e.stopPropagation();
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
      armed = false;
      postJSON(ACCOUNT_API, { action: 'delete', credId: k.credId }).then(function (res) {
        if (handleAuthError(res)) return;
        if (res.j && res.j.ok) {
          toast(t('pkDeleted'));
          try {
            const PKC = /** @type {any} */ (window.PublicKeyCredential);
            if (PKC && typeof PKC.signalUnknownCredential === 'function') {
              PKC.signalUnknownCredential({ rpId: location.hostname, credentialId: k.credId }).catch(function () {});
            } else {
              toast(t('pkDelManual'));
            }
          } catch (e2) {}
          refreshKeys();
        } else {
          toast(errText(res.j && res.j.error, res.s));
          del.textContent = t('pkDel');
          del.classList.remove('armed');
        }
      }, function () {
        toast(t('errNetwork'));
      });
    });
    li.appendChild(nameWrap);
    li.appendChild(del);
    return li;
  }

  /* ---------- 命名弹层（注册成功后弹出；与锁屏页 security-lock.js 同一套） ---------- */
  let pkNameCredId = null;
  let pkNamePrefill = '';
  /** 预填名：设备平台（provider 要等服务端识别 AAGUID，注册前未知） */
  function genPkPrefillName() {
    let device = '';
    try {
      const uad = /** @type {any} */ (navigator).userAgentData;
      if (uad && uad.platform) device = uad.platform;
    } catch (e) {}
    return device || t('pkUnnamed');
  }
  function openPkNameDlg(credId, prefill) {
    pkNameCredId = credId;
    pkNamePrefill = prefill || '';
    const dlg = /** @type {HTMLDialogElement|null} */ ($('lockpkname-dlg'));
    const input = /** @type {HTMLInputElement|null} */ ($('lockpkname-input'));
    if (!dlg || !input) return;
    input.value = pkNamePrefill;
    /* 异步补设备型号（userAgentData 高熵值） */
    try {
      const uad = /** @type {any} */ (navigator).userAgentData;
      if (uad && uad.getHighEntropyValues) {
        uad.getHighEntropyValues(['model']).then(function (ua) {
          if (ua && ua.model && input && input.value === pkNamePrefill) {
            input.value = ua.model;
          }
        }).catch(function () {});
      }
    } catch (e) {}
    const err = $('lockpkname-err');
    if (err) err.hidden = true;
    try { dlg.showModal(); } catch (e) {}
    try { input.focus({ preventScroll: true }); } catch (e2) {}
  }
  function closePkNameDlg(reason) {
    recordDialogClose('lockpkname', reason || 'unknown');
    const dlg = /** @type {HTMLDialogElement|null} */ ($('lockpkname-dlg'));
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
    pkNameCredId = null;
    pkNamePrefill = '';
  }
  function showNameErr(msg) {
    const err = $('lockpkname-err');
    if (err) {
      err.textContent = msg;
      err.hidden = false;
    }
  }
  /* A1/A2/A3：遮罩不关、返回先收键盘、× 关闭（关闭 = 保留注册时的预填名） */
  const pkNameDlg = $('lockpkname-dlg');
  if (pkNameDlg) {
    on(pkNameDlg, 'click', function (/** @type {MouseEvent} */ e) {
      onDialogBackdrop(e, pkNameDlg);
    });
    on(pkNameDlg, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, pkNameDlg, function (reason) { closePkNameDlg(reason); refreshKeys(); });
    });
    const pkNameClose = pkNameDlg.querySelector('[data-dlg-close]');
    if (pkNameClose) on(pkNameClose, 'click', function () { closePkNameDlg('close-btn'); refreshKeys(); });
  }
  const pkNameSave = $('lockpkname-save');
  if (pkNameSave) {
    bindSubmitButton(pkNameSave, function () {
      const input = /** @type {HTMLInputElement|null} */ ($('lockpkname-input'));
      const name = cleanName(input ? input.value : '');
      if (!name) {
        showNameErr(t('pkNameEmpty'));
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
        refreshKeys();
        return;
      }
      postJSON(ACCOUNT_API, { action: 'rename', credId: pkNameCredId, name: name }).then(function (res) {
        if (res.j && res.j.ok) {
          toast(t('pkRegistered'));
          closePkNameDlg('success');
          refreshKeys();
          return;
        }
        if (handleAuthError(res)) {
          closePkNameDlg('reverify');
          return;
        }
        /* KV 最终一致：刚注册的 key 可能暂时读不到 */
        if (res.j && res.j.error === 'not-found') showNameErr(t('pkRetryLater'));
        else if (res.j && res.j.error === 'params') showNameErr(t('pkNameEmpty'));
        else showNameErr(errText(res.j && res.j.error, res.s));
      }, function () {
        showNameErr(t('errNetwork'));
      });
    });
  }
  const pkNameSkip = $('lockpkname-skip');
  if (pkNameSkip) {
    on(pkNameSkip, 'click', function () {
      closePkNameDlg('success');
      toast(t('pkRegistered'));
      refreshKeys();
    });
  }
  /* 命名输入框聚焦时，弹层随键盘上移 */
  followKeyboard($('lockpkname-dlg'), $('lockpkname-input'));

  /* 添加账号通行密钥 */
  const pkAdd = $('lockmgr-pkadd');
  if (pkAdd) {
    on(pkAdd, 'click', function () {
      if (!window.PublicKeyCredential) {
        toast(t('pkNoSupport'));
        return;
      }
      postJSON(ACCOUNT_API, { action: 'register-challenge' }).then(function (res) {
        if (handleAuthError(res)) throw { kind: 'handled' };
        const ch = res.j;
        if (!ch || !ch.ok) throw { kind: 'server', code: ch && ch.error, status: res.s };
        return navigator.credentials.create({
          publicKey: {
            challenge: b64urlToBuf(ch.challenge),
            rp: { name: (ch.rp && ch.rp.name) || 'Styrigx', id: ch.rpId },
            user: { id: b64urlToBuf(ch.user.id), name: ch.user.name, displayName: ch.user.displayName },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
            excludeCredentials: (ch.excludeCredentials || []).map(function (c) {
              return { id: b64urlToBuf(c.id), type: c.type };
            }),
            attestation: 'none',
            timeout: 60000,
          },
        }).then(function (cred) {
          return { cred: /** @type {any} */ (cred), cid: ch.cid };
        }, function (e) {
          if (e && e.name === 'NotAllowedError') throw { kind: 'cancelled' };
          if (e && e.name === 'InvalidStateError') throw { kind: 'already' };
          if (e && e.name === 'NotSupportedError') throw { kind: 'nosupport' };
          throw { kind: 'failed' };
        });
      }).then(function (r) {
        const prefill = genPkPrefillName();
        return postJSON(ACCOUNT_API, {
          action: 'register',
          cid: r.cid,
          name: prefill,
          credential: {
            id: r.cred.id,
            rawId: bufToB64url(r.cred.rawId),
            type: r.cred.type,
            response: {
              clientDataJSON: bufToB64url(r.cred.response.clientDataJSON),
              attestationObject: bufToB64url(r.cred.response.attestationObject),
            },
          },
        }).then(function (res) {
          return { res: res, prefill: prefill };
        });
      }).then(function (r2) {
        const res = r2.res;
        if (handleAuthError(res)) return;
        if (res.j && res.j.ok) {
          /* 注册成功 → 命名弹层（预填名已随 register 提交，用户改了名才调 rename） */
          openPkNameDlg(res.j.credId, r2.prefill);
          refreshKeys();
        } else {
          toast(errText(res.j && res.j.error, res.s));
        }
      }).catch(function (e) {
        if (!e || e.kind === 'handled') return;
        if (e.kind === 'cancelled') toast(t('errCancelled'));
        else if (e.kind === 'already') toast(t('pkAlready'));
        else if (e.kind === 'nosupport') toast(t('pkNoSupport'));
        else if (e.kind === 'failed') toast(t('pkFailed'));
        else if (e.kind === 'server') toast(errText(e.code, e.status));
        else toast(t('errNetwork'));
      });
    });
  }

  /* 进页：读状态。没有账号会话（访客 / 只有锁屏会话 / 读失败）→ 回账号页登录；没有门票 → 门口 */
  function loadStatus() {
    return fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok && j.session && j.ready !== false)) {
          goLogin();
          return;
        }
        status = j;
        if (j.door && typeof j.door.expiresAt === 'number' && j.door.expiresAt > Date.now()) enterRoom(j);
        else showDoor();
      })
      .catch(function () { goLogin(); });
  }

  /* 离开本页：门票立即作废（keepalive，页面卸载也能发出）。从历史返回（bfcache 恢复）重新读状态 → 门口。 */
  window.addEventListener('pagehide', function () {
    stopCountdown();
    try {
      fetch(ACCOUNT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'door-clear' }),
        credentials: 'same-origin',
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  });
  window.addEventListener('pageshow', function (e) {
    if (e && /** @type {PageTransitionEvent} */ (e).persisted) loadStatus();
  });

  loadStatus();
})();
