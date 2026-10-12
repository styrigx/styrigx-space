/**
 * @fileoverview 应用管理页共用：验证身份门 + stepup + 带自动重试的 api()。
 *
 * 两扇门设计：应用页属于「管理凭证门」，进门用 owner 类通行密钥做一次
 * stepup（by=owner, scope=keys）。门内操作（增删应用类通行密钥）走 api()，
 * 服务端报 stepup-required 时自动做一次 stepup 后重试（只重试一次），
 * 与 security-lock.js 的行为一致。
 *
 * 注意：WebAuthn 需要用户手势，页面加载时不自动调起；进门探针只用普通
 * fetch（不自动 stepup），失败则打开验证门。
 */
import { on } from '../lib/events.js';

/** @param {string} s */
export function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** @param {ArrayBuffer} buf */
export function bufToB64url(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/**
 * 执行 stepup 验证（owner 类通行密钥，强制 UV）。
 * 成功后服务端设置 sgx-stepup cookie（by=owner, scope=keys）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function doStepup() {
  if (!window.PublicKeyCredential) {
    return Promise.resolve({ ok: false, error: 'no-support' });
  }
  let lastError = 'server';
  return api('/api/stepup', { action: 'challenge' })
    .then(function (res) {
      const ch = res.json;
      if (!ch || !ch.ok) {
        lastError = (ch && ch.error) || 'server';
        throw { kind: 'server' };
      }
      const allow = (ch.allowCredentials || []).map(function (c) {
        return { id: b64urlToBuf(c.id), type: c.type };
      });
      return navigator.credentials
        .get({ publicKey: { challenge: b64urlToBuf(ch.challenge), rpId: ch.rpId, allowCredentials: allow, userVerification: 'required', timeout: 60000 } })
        .then(function (cred) {
          return { cred: cred, cid: ch.cid };
        }, function (e) {
          lastError = e && e.name === 'NotAllowedError' ? 'cancelled' : 'failed';
          throw { kind: lastError };
        });
    })
    .then(function (r2) {
      const cred = r2.cred;
      return fetch('/api/stepup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify',
          cid: r2.cid,
          credential: {
            id: cred.id,
            rawId: bufToB64url(cred.rawId),
            type: cred.type,
            response: {
              clientDataJSON: bufToB64url(cred.response.clientDataJSON),
              authenticatorData: bufToB64url(cred.response.authenticatorData),
              signature: bufToB64url(cred.response.signature),
              userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
            },
          },
        }),
        credentials: 'include',
      }).then(parseApi);
    })
    .then(function (res) {
      if (res.json && res.json.ok) return { ok: true };
      lastError = (res.json && res.json.error) || 'verify';
      return { ok: false, error: lastError };
    })
    .catch(function () {
      return { ok: false, error: lastError };
    });
}

/**
 * 带 stepup 自动重试的 POST。
 * stepup-required → 自动做一次 stepup 验证后重试（只重试一次）；
 * 自动 stepup 失败时返回带错误码的响应，调用方显示错误并停住。
 * @param {string} url
 * @param {any} body
 * @param {boolean} [retried]
 */
export function api(url, body, retried) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  }).then(parseApi).then(function (res) {
    if (!retried && res.json && res.json.error === 'stepup-required') {
      const serverReason = res.json.reason;
      return doStepup().then(function (r) {
        if (r.ok) {
          return api(url, body, true).then(function (res2) {
            if (res2.json && res2.json.error === 'stepup-required') {
              return { status: res2.status, json: { ok: false, error: 'stepup-retry-failed', reason: res2.json.reason || serverReason } };
            }
            return res2;
          });
        }
        const errCode = r.error || 'stepup-failed';
        return { status: res.status, json: { ok: false, error: errCode, reason: serverReason } };
      });
    }
    return res;
  });
}

/**
 * 初始化验证身份门。
 * - 进门探针：普通 fetch 调 load()（不自动 stepup）；拿到 keys 直接进门，
 *   否则打开验证门。
 * - 验证门：点「使用通行密钥」→ doStepup() → 成功后 load() → 进门。
 * - 验证门不允许直接关闭：点遮罩/返回键回到上一页。
 *
 * @param {object} o
 * @param {string} o.dlg 验证门 dialog 元素 id
 * @param {string} o.pkBtn 通行密钥按钮 id
 * @param {string} o.err 错误文案元素 id
 * @param {string} o.content 管理区元素 id
 * @param {(k:string)=>string} o.t 文案函数
 * @param {()=>Promise<Array|null>} o.load 读钥匙列表；返回 null 表示需验证
 * @param {(keys:Array)=>void} o.onEnter 进门回调
 */
export function initAppGate(o) {
  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  const dlg = $(o.dlg);
  const pkBtn = $(o.pkBtn);
  const errEl = $(o.err);
  const content = $(o.content);

  function showErr(msg) {
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
  }
  function hideErr() {
    if (errEl) errEl.hidden = true;
  }
  function openGate() {
    if (content) content.hidden = true;
    hideErr();
    if (pkBtn && !window.PublicKeyCredential) {
      showErr(o.t('gateNoSupport'));
    }
    try {
      if (dlg) dlg.showModal();
    } catch (e) {}
  }
  function enter(keys) {
    try {
      if (dlg && dlg.open) dlg.close();
    } catch (e) {}
    /* 本页有独立验证门；进管理区时去掉全局锁屏遮罩，避免盖住按钮 */
    try {
      const gl = document.getElementById('sgx-lock');
      if (gl) gl.remove();
      document.body.classList.remove('sgx-locked');
    } catch (e) {}
    if (content) content.hidden = false;
    o.onEnter(keys);
  }
  function enterWithLoad() {
    o.load().then(function (keys) {
      if (keys) {
        enter(keys);
      } else {
        openGate();
      }
    }).catch(function () {
      openGate();
    });
  }

  if (dlg) {
    on(dlg, 'click', function (/** @type {MouseEvent} */ e) {
      const el = /** @type {Element|null} */ (e.target);
      if (el && el.closest && el.closest('[data-gclose]')) {
        /* 验证门不允许直接关闭：返回上一页 */
        history.back();
      }
    });
    on(dlg, 'cancel', function (/** @type {Event} */ e) {
      e.preventDefault();
      history.back();
    });
  }
  if (pkBtn) {
    on(pkBtn, 'click', function () {
      hideErr();
      if (!window.PublicKeyCredential) {
        showErr(o.t('gateNoSupport'));
        return;
      }
      doStepup().then(function (r) {
        if (r.ok) {
          enterWithLoad();
        } else {
          showErr(o.t('gatePkErr') + (r.error ? ' (' + r.error + ')' : ''));
        }
      });
    });
  }

  /* 进门探针：stepup 票据有效时直接进，不过验证门 */
  enterWithLoad();
}
