/**
 * @fileoverview Book 应用详情页（2.11）：安全与隐私 → 应用 → Book。
 * - 进门：页面直接渲染；进门探针（app-gate.js）确认验证有效，
 *   无效则跳验证流程（安全与隐私页），不弹面板。
 * - 进门后：Book 的应用类通行密钥列表（重命名/删除，两步确认），
 *   「添加钥匙」按钮；「退出 Book 会话」清除应用通行证（sgx-app）。
 *   门内操作全部直接调接口，不弹验证（添加钥匙时创建凭据本身除外）。
 * - ?return= 携带应用授权页地址时，显示「返回应用授权」按钮。
 * - 反馈一律 One UI 轻提示（toast）；localStorage 经 storage.js。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { api, enterDoor, apiErrorText, clearStepupThen, b64urlToBuf, bufToB64url } from './app-gate.js';
import { sgxNavigate } from '../lib/diag-jumptrace.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let T = {};
  try {
    T = JSON.parse(document.getElementById('sgx-i18n-bookmgr').textContent || '{}');
  } catch (e) {}
  /** @param {string} k */
  function t(k) {
    const v = T[k];
    if (v && typeof v === 'object') return en ? v.en : v.zh;
    return v || k;
  }
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  const mgr = $('bookmgr');
  const aud = (mgr && mgr.getAttribute('data-aud')) || 'book';

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

  /** 读该 aud 的应用类钥匙；验证无效时返回 null → 跳验证流程 */
  function loadKeys() {
    return fetch('/api/owner-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
      credentials: 'include',
    }).then(function (r) {
      return r.json();
    }).then(function (j) {
      if (!(j && j.ok)) return null;
      return (j.keys || []).filter(function (k) {
        return (k.class || 'lock') === 'app' && k.aud === aud;
      });
    }).catch(function () {
      return null;
    });
  }

  function render(keys) {
    const ul = $('bookmgr-keylist');
    const empty = $('bookmgr-keyempty');
    if (!ul) return;
    ul.innerHTML = '';
    (keys || []).forEach(function (k) {
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
            } else if (jj && jj.error === 'stepup-required') {
              /* 验证失效：已跳验证流程 */
            } else if (jj && jj.error === 'not-found') {
              toast(t('pkRetryLater'));
              nameInput.value = lastSaved;
            } else {
              toast(apiErrorText(t, jj && jj.error));
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
      /* 删除（两步确认） */
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lockmgr-pkdel';
      del.textContent = t('pkDel');
      del.setAttribute('aria-label', t('pkDel') + ' ' + (k.name || t('pkUnnamed')));
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
        api('/api/owner-passkey', { action: 'delete', credId: k.credId }, t)
          .then(function (r2) {
            const jj = r2.json;
            if (jj && jj.ok) {
              toast(t('pkDeleted'));
              refresh();
            } else if (jj && jj.error === 'stepup-required') {
              /* 验证失效：已跳验证流程 */
            } else {
              toast(apiErrorText(t, jj && jj.error));
            }
          })
          .catch(function () {
            toast(t('gateNetErr'));
          });
      });
      li.appendChild(nameWrap);
      li.appendChild(del);
      ul.appendChild(li);
    });
    ul.hidden = (keys || []).length === 0;
    if (empty) empty.hidden = (keys || []).length !== 0;
  }

  function refresh() {
    loadKeys().then(function (keys) {
      if (keys) render(keys);
    });
  }

  /* 添加该应用的钥匙（aud 必须在白名单；服务端再校验） */
  function addKey() {
    if (!window.PublicKeyCredential) {
      toast(t('gateNoSupport'));
      return;
    }
    api('/api/owner-passkey', { action: 'challenge', type: 'register', pkClass: 'app', aud: aud }, t)
      .then(function (res) {
        const ch = res.json;
        if (ch && ch.error === 'stepup-required') throw { kind: 'reverify' };
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
          refresh();
        } else if (res.json && res.json.error === 'stepup-required') {
          /* 验证失效：已跳验证流程 */
        } else {
          toast(apiErrorText(t, res.json && res.json.error));
        }
      })
      .catch(function (e) {
        if (!e) return;
        if (e.kind === 'reverify') return; /* 已跳验证流程 */
        if (e.kind === 'cancelled' || (e && e.name === 'NotAllowedError')) toast(t('errCancelled'));
        else if (e.kind === 'already' || (e && e.name === 'InvalidStateError')) toast(t('pkAlready'));
        else if (e.kind === 'nosupport') toast(t('gateNoSupport'));
        else if (e.kind === 'failed') toast(t('pkFailed'));
        else if (e.kind === 'server') toast(apiErrorText(t, e.code));
        else toast(t('pkFailed'));
      });
  }

  /* 退出该应用会话：清应用通行证（sgx-app，HttpOnly，只能由服务端清） */
  function exitSession() {
    fetch('/api/app-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'revoke' }),
      credentials: 'include',
    }).then(function (r) {
      return r.json().catch(function () {
        return null;
      });
    }).then(function (j) {
      if (j && j.ok) {
        toast(t('sessExited'));
      } else {
        toast(apiErrorText(t, j && j.error));
      }
    }).catch(function () {
      toast(t('gateNetErr'));
    });
  }

  /* ?return=：应用授权页跳过来加钥匙时带，显示「返回应用授权」按钮 */
  function initReturn() {
    let ret = null;
    try {
      const q = new URLSearchParams(location.search).get('return');
      /* 只收站内路径（防 open redirect） */
      if (q && q.charAt(0) === '/' && q.charAt(1) !== '/' && q.charAt(1) !== '\\') ret = q;
    } catch (e) {}
    if (!ret) return;
    const wrap = $('bookmgr-return-wrap');
    const btn = $('bookmgr-return');
    if (!wrap || !btn) return;
    wrap.hidden = false;
    on(btn, 'click', function () {
      sgxNavigate(ret, 'security-apps-book.js:298', 'book-return');
    });
  }

  const keyAdd = $('bookmgr-keyadd');
  if (keyAdd) on(keyAdd, 'click', addKey);
  const exitBtn = $('bookmgr-exitsess');
  if (exitBtn) on(exitBtn, 'click', exitSession);

  /* 进门探针：验证有效直接渲染，无效跳验证流程（安全与隐私页） */
  let cachedKeys = null;
  enterDoor(
    function () {
      return loadKeys().then(function (keys) {
        cachedKeys = keys;
        return !!keys;
      });
    },
    function () {
      if (mgr) mgr.hidden = false;
      render(cachedKeys);
      initReturn();
    },
    t
  );
})();
