/**
 * @fileoverview 门内管理逻辑（两扇门共用）。
 *
 * - 「站长凭证」门（security-owner.js）：管理 ownerkey（站长密码、站长通行密钥）。
 * - 「管理凭证 → 锁屏」门（security-lock.js）：管理 lockkey（解锁密码、
 *   锁屏通行密钥）与 <app>key（应用验证分组）。
 * 钥匙命名规范见 functions/_kernel/key-names.js（rootkey/ownerkey/lockkey/<aud>key）。
 *
 * 两扇门设计（2.11）：进门只验一次（安全与隐私页入口）；本页直接渲染管理区，
 * 进门探针确认验证有效，无效则跳验证流程（安全与隐私页），不弹面板。
 * 门内（验证有效期内）查看/添加/重命名/删除/改密码全部直接调接口，
 * 不弹验证、不发起 WebAuthn 挑战（添加钥匙时创建凭据本身除外）。
 * 返回离开即退出：返回键先清验证再跳转。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { followKeyboard } from '../shell/vk.js';
import { KEY_LOCK } from '../lib/key-names.js';
import {
  api,
  enterDoor,
  apiErrorText,
  handleDoorError,
  clearStepupThen,
  b64urlToBuf,
  bufToB64url,
} from './app-gate.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose, bindEyeButton, bindSubmitButton } from '../lib/dialog-behavior.js';

/**
 * 初始化一扇门。
 * @param {object} o
 * @param {(k:string)=>string} o.t 文案函数
 * @param {boolean} o.en 是否英文
 * @param {string} o.statusApi 状态接口（/api/owner-status 或 /api/lock-status）
 * @param {string} o.pwKind 密码 kind（'owner' 或 'lock'）
 * @param {string} o.keyClass 通行密钥类别（'owner' 或 'lock'）
 * @param {boolean} o.withApps 是否含应用验证分组（仅锁屏门）
 * @param {string} o.homeUrl 返回键目标（安全与隐私页，C1：从哪里进门回哪里）
 */
export function initDoor(o) {
  const t = o.t;
  const en = o.en;
  const statusApi = o.statusApi;
  const pwKind = o.pwKind;
  const withApps = !!o.withApps;
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  let hasPw = false;
  let hasPk = false;
  /** 全量钥匙缓存（含应用类，供应用验证分组渲染） */
  let allKeys = [];
  /** 批次 A 验收修复 P0："添加通行密钥"的钥匙类别由页面决定（o.keyClass），
      不按票据 scope 推断；服务端按 pkClass + 票据双重校验。 */
  const pkAddClass = o.keyClass;
  /** 应用白名单（与服务端一致，book 在列） */
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

  /**
   * 收起当前所有打开的 sheet（密码/命名/删除确认弹层），
   * 保证同一时刻只有一个弹层。
   */
  function closeOpenSheets() {
    ['lockpw-dlg', 'lockpkname-dlg', 'lockpkdel-dlg'].forEach(function (id) {
      const d = $(id);
      try {
        if (d && d.open) d.close();
      } catch (e) {}
    });
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

  /* ---------- 状态 ---------- */
  function refreshStatus() {
    fetch(statusApi, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        /* 失败时保持当前显示，不误报「未设置」 */
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

  /* ---------- 密码弹层 ---------- */
  const pwDlg = $('lockpw-dlg');
  followKeyboard(pwDlg, [$('lockpw-1'), $('lockpw-2')]);
  function openPwDlg() {
    hideErr('lockpw-err');
    closeOpenSheets();
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
  /* 删除密码（两步确认；门内直接调接口） */
  const pwDel = $('lockmgr-pwdel');
  if (pwDel) {
    let armed = false;
    let armTimer = 0;
    const origText = pwDel.textContent;
    const go = function () {
      if (!armed) {
        armed = true;
        /* 如果删完后密码和钥匙都没了，提示只能用 rootkey 进入 */
        pwDel.textContent = hasPk ? t('pwDelAsk') : t('pwDelWarn');
        pwDel.classList.add('armed');
        armTimer = window.setTimeout(function () {
          armed = false;
          pwDel.textContent = origText;
          pwDel.classList.remove('armed');
        }, 5000);
        return;
      }
      window.clearTimeout(armTimer);
      api('/api/owner-password', { action: 'remove', kind: pwKind }, t)
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pwDeleted'));
            refreshStatus();
            refreshPkList();
          } else if (j && handleDoorError(t, j.error, r.status, j.reason)) {
            /* D3：session/stepup-required/scope/by-root 已走 needVerify */
          } else {
            toast(apiErrorText(t, j && j.error, r.status));
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
    };
    on(pwDel, 'click', go);
    on(pwDel, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  }

  /* 返回离开即退出：返回键先清验证，再走原返回逻辑 */
  window.addEventListener('click', function (e) {
    let el = null;
    try {
      el = e.target && e.target.closest ? e.target.closest('[data-go-back]') : null;
    } catch (_) {}
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    clearStepupThen(o.homeUrl);
  }, true);

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
    api('/api/owner-password', body, t)
      .then(function (res) {
        const j = res.json;
        if (!j) {
          showErr('lockpw-err', t('gateNetErr'));
          return;
        }
        if (j.ok) {
          closePwDlg('success');
          hasPw = true;
          refreshStatus();
          toast(action === 'change' ? t('pwChanged') : t('pwSaved'));
        } else if (handleDoorError(t, j.error, res.status, j.reason)) {
          /* D3：session/stepup-required/scope/by-root 已走 needVerify */
          closePwDlg('success');
        } else if (j.error === 'exists' && action === 'set') {
          /* 并发已设置 → 按已设置处理 */
          hasPw = true;
          refreshStatus();
          showErr('lockpw-err', apiErrorText(t, 'exists', res.status));
        } else {
          showErr('lockpw-err', apiErrorText(t, j.error, res.status));
        }
      })
      .catch(function () {
        showErr('lockpw-err', t('gateNetErr'));
      });
  }
  const pwGo = $('lockpw-go');
  /* 批次 A 收尾：pointerup（要求 pointerdown 也在按钮）+ click 兜底，去重只提交一次 */
  if (pwGo) bindSubmitButton(pwGo, submitPw);

  /* ---------- 钥匙命名弹层 ---------- */
  let pkNameCredId = null;
  let pkNamePrefill = '';
  function genPkPrefillName() {
    let device = '';
    try {
      if (navigator.userAgentData && navigator.userAgentData.platform) {
        device = navigator.userAgentData.platform;
      }
    } catch (e) {}
    return device || t('pkUnnamed');
  }
  function openPkNameDlg(credId, prefill) {
    pkNameCredId = credId;
    pkNamePrefill = prefill || '';
    const dlg = $('lockpkname-dlg');
    const input = $('lockpkname-input');
    if (!dlg || !input) return;
    closeOpenSheets();
    input.value = pkNamePrefill;
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
      api('/api/owner-passkey', { action: 'rename', credId: pkNameCredId, name: name }, t)
        .then(function (r) {
          const j = r.json;
          if (j && j.ok) {
            toast(t('pkRegistered'));
            closePkNameDlg('success');
            refreshPkList();
          } else if (j && handleDoorError(t, j.error, r.status, j.reason)) {
            /* D3：已走 needVerify */
          } else if (j && j.error === 'not-found') {
            /* KV 最终一致：刚注册的钥匙可能暂时读不到 */
            showErr('lockpkname-err', t('pkRetryLater'));
          } else if (!j) {
            showErr('lockpkname-err', t('gateNetErr'));
          } else {
            showErr('lockpkname-err', apiErrorText(t, j.error, r.status));
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
      closePkNameDlg('success');
      toast(t('pkRegistered'));
      refreshPkList();
    });
  }
  followKeyboard($('lockpkname-dlg'), $('lockpkname-input'));

  /* ---------- 应用钥匙删除确认弹层（仅锁屏门；站内确认） ---------- */
  let pkDelResolve = null;
  function openPkDelDlg() {
    return new Promise(function (resolve) {
      pkDelResolve = resolve;
      closeOpenSheets();
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
  if (withApps) {
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
  }

  /* ---------- 钥匙列表 ---------- */
  function keyItem(k, keyClass) {
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
      api('/api/owner-passkey', { action: 'rename', credId: k.credId, name: v }, t)
        .then(function (r2) {
          const jj = r2.json;
          if (jj && jj.ok) {
            lastSaved = v;
            toast(t('pkRenamed'));
          } else if (jj && handleDoorError(t, jj.error, r2.status, jj.reason)) {
            /* D3：已走 needVerify */
          } else if (jj && jj.error === 'not-found') {
            toast(t('pkRetryLater'));
            nameInput.value = lastSaved;
          } else {
            toast(apiErrorText(t, jj && jj.error, r2.status));
            nameInput.value = lastSaved;
          }
        })
        .catch(function () {
          toast(t('gateNetErr'));
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
    let metaText = (en ? 'Created ' : '创建于 ') + fmtDate(k.createdAt);
    if (k.lastUsedAt) {
      metaText += ' · ' + (en ? 'Last used ' : '最近使用 ') + fmtDate(k.lastUsedAt);
    } else {
      metaText += ' · ' + t('pkNeverUsed');
    }
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
    del.setAttribute('aria-label', t('pkDel') + ' ' + (k.name || t('pkUnnamed')));
    armDelete(del, function () {
      return api('/api/owner-passkey', { action: 'delete', credId: k.credId }, t)
        .then(function (r2) {
          const jj = r2.json;
          if (jj && jj.ok) {
            toast(t('pkDeleted'));
            /* Samsung Pass 同步：通知密码管理器删掉这把钥匙 */
            try {
              if (window.PublicKeyCredential && typeof PublicKeyCredential.signalUnknownCredential === 'function') {
                PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: k.credId }).catch(function () {});
              } else {
                toast(t('pkDelManual'));
              }
            } catch (e) {}
            refreshPkList();
            refreshStatus();
          } else if (jj && handleDoorError(t, jj.error, r2.status, jj.reason)) {
            /* D3：已走 needVerify */
          } else {
            toast(apiErrorText(t, jj && jj.error, r2.status));
          }
        })
        .catch(function () {
          toast(t('gateNetErr'));
        });
    });
    li.appendChild(nameWrap);
    li.appendChild(del);
    return li;
  }

  /* 两步确认删除（按钮文案两段式） */
  function armDelete(del, doDelete) {
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
      doDelete();
    });
  }

  /* 应用验证分组：list 只返回本页类别，app 类需单独发一次 list（否则分组误显示「未添加」） */
  function refreshAppKeys() {
    if (!$('lockmgr-applist')) return;
    api('/api/owner-passkey', { action: 'list', pkClass: 'app' }, t)
      .then(function (res) {
        const j = res.json;
        if (!j) return;
        if (j.error && handleDoorError(t, j.error, res.status, j.reason)) return;
        allKeys = allKeys.concat((j.ok && j.keys) || []);
        renderAppList();
      })
      .catch(function () {});
  }

  function refreshPkList() {
    const ul = $('lockmgr-pklist');
    const empty = $('lockmgr-pkempty');
    /* 批次 A 验收修复 P0：list 带页面类别，服务端只返回该类 */
    api('/api/owner-passkey', { action: 'list', pkClass: o.keyClass }, t)
      .then(function (res) {
        const j = res.json;
        if (!j) return;
        if (j.error && handleDoorError(t, j.error, res.status, j.reason)) return; /* D3：已走 needVerify */
        const keys = ((j.ok && j.keys) || []).filter(function (k) {
          return (k.class || 'lock') === o.keyClass;
        });
        if (!ul) return;
        ul.innerHTML = '';
        allKeys = (j.ok && j.keys) || [];
        if (withApps) refreshAppKeys(); else renderAppList();
        keys.forEach(function (k) {
          ul.appendChild(keyItem(k));
        });
        ul.hidden = keys.length === 0;
        if (empty) empty.hidden = keys.length !== 0;
      })
      .catch(function () {});
  }

  /* 应用验证分组（仅锁屏门：每应用一行，可单独添加/删除钥匙） */
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
      label.textContent = app.name + (appKeys.length ? '（' + appKeys.length + '）' : t('appKeyNone'));
      nameWrap.appendChild(label);
      li.appendChild(nameWrap);
      const btnWrap = document.createElement('div');
      if (appKeys.length === 0) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'lockmgr-add';
        add.textContent = t('appAddKey').replace('{app}', app.name);
        on(add, 'click', function () {
          addAppKey(app.aud);
        });
        btnWrap.appendChild(add);
      } else {
        appKeys.forEach(function (k) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'lockmgr-del';
          del.textContent = t('pkDel');
          del.setAttribute('aria-label', t('appDelKey').replace('{app}', app.name));
          on(del, 'click', function () {
            openPkDelDlg().then(function (confirmed) {
              if (!confirmed) return;
              api('/api/owner-passkey', { action: 'delete', credId: k.credId }, t)
                .then(function (r2) {
                  const jj = r2.json;
                  if (jj && jj.ok) {
                    toast(t('pkDeleted'));
                    refreshPkList();
                  } else if (jj && jj.error === 'stepup-required') {
                    /* 验证失效：已跳验证流程 */
                  } else {
                    toast(apiErrorText(t, jj && jj.error, r2.status));
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

  /* 添加应用类钥匙（aud 必须在白名单；服务端再校验） */
  function addAppKey(aud) {
    if (!window.PublicKeyCredential) {
      toast(t('pkNoSupport'));
      return;
    }
    api('/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'app', aud: aud }, t)
      .then(function (res) {
        const ch = res.json;
        if (ch && ch.error && handleDoorError(t, ch.error, res.status, ch.reason)) throw { kind: 'reverify' };
        if (!ch || !ch.ok) throw { kind: 'server', code: ch && ch.error };
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
        }, function (e) {
          if (e && e.name === 'NotAllowedError') throw { kind: 'cancelled' };
          if (e && e.name === 'InvalidStateError') throw { kind: 'already' };
          if (e && e.name === 'NotSupportedError') throw { kind: 'nosupport' };
          throw { kind: 'failed' };
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
        }, t);
      })
      .then(function (res) {
        if (res.json && res.json.ok) {
          toast(t('pkRegistered'));
          refreshPkList();
        } else if (res.json && res.json.error && handleDoorError(t, res.json.error, res.status, res.json.reason)) {
          /* D3：已走 needVerify */
        } else {
          toast(apiErrorText(t, res.json && res.json.error, res.status));
        }
      })
      .catch(function (e) {
        if (!e) return;
        if (e.kind === 'reverify') return; /* 已跳验证流程 */
        if (e.kind === 'cancelled') toast(t('errCancelled'));
        else if (e.kind === 'already') toast(t('pkAlready'));
        else if (e.kind === 'nosupport') toast(t('pkNoSupport'));
        else if (e.kind === 'failed') toast(t('pkFailed'));
        else if (e.kind === 'server') toast(apiErrorText(t, e.code));
        else toast(t('gateNetErr'));
      });
  }

  /* 添加钥匙 */
  const pkAdd = $('lockmgr-pkadd');
  if (pkAdd) {
    on(pkAdd, 'click', function () {
      if (!window.PublicKeyCredential) {
        toast(t('pkNoSupport'));
        return;
      }
      /* 门内直接调接口，不自动验证。pkClass 按当前管理区决定，
         服务端会按 stepup scope 校验类别。 */
      api('/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: pkAddClass }, t)
        .then(function (res) {
          const ch = res.json;
          if (ch && ch.error && handleDoorError(t, ch.error, res.status, ch.reason)) throw { kind: 'reverify' };
          if (!ch || !ch.ok) throw { kind: 'server', code: ch && ch.error };
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
                  name: user.name || KEY_LOCK,
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
          }, t).then(function (res) {
            return { res: res, prefill: prefill };
          });
        })
        .then(function (r3) {
          const j = r3.res.json;
          if (j && j.ok) {
            /* 注册成功 → 弹出命名弹层（预填名已提交，用户改名才调 rename） */
            openPkNameDlg(j.credId, r3.prefill);
            refreshPkList();
          } else if (j && handleDoorError(t, j.error, r3.res.status, j.reason)) {
            /* D3：已走 needVerify */
          } else {
            toast(apiErrorText(t, j && j.error, r3.res.status));
          }
        })
        .catch(function (e) {
          if (!e) return;
          if (e.kind === 'reverify') return; /* 已跳验证流程 */
          if (e.kind === 'cancelled') toast(t('errCancelled'));
          else if (e.kind === 'already') toast(t('pkAlready'));
          else if (e.kind === 'nosupport') toast(t('pkNoSupport'));
          else if (e.kind === 'server') toast(apiErrorText(t, e.code));
          else if (e.kind === 'failed') toast(t('pkFailed'));
          else toast(t('gateNetErr'));
        });
    });
  }

  /* ---------- 进门 ---------- */
  /* 定稿 #1：探针确认「会话 + 门票据」都有效才进门。
     只验会话不验票据会导致：会话有效但票据无效时进门，
     门内首个 API 即 403 stepup-required，用户被动等待。
     返回 {ok, reason, api, status, detail}，失败时留页显示（定稿 #1）。 */
  function probe() {
    return fetch(statusApi, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!(j && j.ok)) {
            return { ok: false, reason: (j && j.error) || 'session', status: r.status, api: 'GET ' + statusApi, detail: j && j.reason };
          }
          /* 会话有效 → 再验门票据（/api/stepup status 不验会话，只验票据） */
          return fetch('/api/stepup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'status' }),
            credentials: 'same-origin',
          }).then(function (r2) {
            return r2.json().then(function (j2) {
              if (j2 && j2.ok && j2.valid) return { ok: true };
              return { ok: false, reason: 'stepup', status: r2.status, api: 'POST /api/stepup', detail: j2 && j2.reason };
            }).catch(function () {
              return { ok: false, reason: 'parse', status: r2.status, api: 'POST /api/stepup' };
            });
          }).catch(function () {
            return { ok: false, reason: 'network', status: 0, api: 'POST /api/stepup' };
          });
        }).catch(function () {
          return { ok: false, reason: 'parse', status: r.status, api: 'GET ' + statusApi };
        });
      })
      .catch(function () { return { ok: false, reason: 'network', status: 0, api: 'GET ' + statusApi }; });
  }
  enterDoor(probe, function () {
    refreshStatus();
    refreshPkList();
  }, t);
}
