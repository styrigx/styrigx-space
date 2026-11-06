/**
 * @fileoverview 通行密钥注册 + 命名弹层（frontend-js #8，2026-10-26）：锁屏凭证页（apps/security-lock.js）和
 * 账号安全页（apps/account-security.js）共用一份。以前两页各抄一遍，已经走样：
 * - 锁屏页预填名兜底写死「通行密钥」（英文页也是中文），账号页用 i18n 的 pkUnnamed → 统一由调用方给兜底文案
 * - 锁屏页补设备型号只在输入框为空时（预填名几乎从不为空，等于不补），而且补了以后把「预填名」也改成型号，
 *   用户直接点保存时不调 rename，服务端仍是旧名；账号页「用户没改过才补、预填名不变」是对的 → 统一用账号页的
 * - 锁屏页注册失败分支读了不存在的 r.status（ReferenceError），任何服务端拒绝都被 catch 成「网络错误」
 *
 * 只管 WebAuthn 仪式、请求体格式、结果分派和命名弹层的开关；接口调用、鉴权失败的处理（重新验证 / 回登录）、
 * 文案都由调用方传进来。
 */
import { b64urlToBuf, bufToB64url } from '../lib/b64.js';
import { on } from '../lib/events.js';
import { bindSubmitButton, onDialogBackdrop, onDialogCancel, recordDialogClose } from '../lib/dialog-behavior.js';

/**
 * 统一的接口结果：{ status: HTTP 状态（网络层失败时由调用方 reject），json: 正文或 null }
 * @typedef {{status: number, json: any}} ApiResult
 */

/** 通行密钥名：去控制字符、首尾空白，最多 40 字 @param {any} v */
export function cleanPasskeyName(v) {
  return String(v == null ? '' : v).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
}

/**
 * 注册前的预填名：设备平台（provider 要等服务端识别 AAGUID，注册前未知）；拿不到用 fallback
 * @param {string} fallback
 */
export function genPkPrefillName(fallback) {
  let device = '';
  try {
    const uad = /** @type {any} */ (navigator).userAgentData;
    if (uad && uad.platform) device = uad.platform;
  } catch (e) {}
  return device || fallback;
}

/**
 * 服务端下发的注册 challenge → navigator.credentials.create 的 publicKey 选项。
 * rp.id / 用户 / excludeCredentials 都以服务端为准，前端不硬编码；userFallback 只在服务端没给时用。
 * @param {any} ch
 * @param {{name?: string, displayName?: string}} [userFallback]
 */
export function creationOptions(ch, userFallback) {
  const user = ch.user || {};
  const fb = userFallback || {};
  return {
    challenge: b64urlToBuf(ch.challenge),
    rp: { name: (ch.rp && ch.rp.name) || 'Styrigx', id: ch.rpId },
    user: { id: b64urlToBuf(user.id), name: user.name || fb.name, displayName: user.displayName || fb.displayName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
    excludeCredentials: (ch.excludeCredentials || []).map(function (/** @type {any} */ c) {
      return { id: b64urlToBuf(c.id), type: c.type };
    }),
    attestation: 'none',
    timeout: 60000,
  };
}

/** 注册结果（PublicKeyCredential + AttestationResponse）→ 提交给服务端的 JSON @param {any} cred */
export function attestationToJSON(cred) {
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      attestationObject: bufToB64url(cred.response.attestationObject),
    },
  };
}

/**
 * 完整注册流程：challenge → 系统注册窗口 → register（带预填名）→ 成功打开命名弹层。
 * 失败只走 o.toast（一条提示），鉴权类失败交给 o.onAuthError（返回 true 表示已处理，不再提示）。
 * @param {{
 *   challenge: () => Promise<ApiResult>,
 *   register: (body: {cid: any, name: string, credential: any}) => Promise<ApiResult>,
 *   onAuthError: (res: ApiResult) => boolean,
 *   onRegistered: (credId: string, prefill: string) => void,
 *   prefill: () => string,
 *   errText: (code: any, status?: number) => string,
 *   toast: (msg: string) => void,
 *   msg: {cancelled: string, already: string, noSupport: string, failed: string, network: string},
 *   userFallback?: {name?: string, displayName?: string},
 * }} o
 * @returns {Promise<void>}
 */
export function registerPasskey(o) {
  if (typeof window === 'undefined' || !(/** @type {any} */ (window)).PublicKeyCredential) {
    o.toast(o.msg.noSupport);
    return Promise.resolve();
  }
  return o.challenge()
    .then(function (res) {
      if (o.onAuthError(res)) throw { kind: 'handled' };
      const ch = res.json;
      if (!ch || !ch.ok) throw { kind: 'server', code: ch && ch.error, status: res.status };
      return navigator.credentials.create({ publicKey: /** @type {any} */ (creationOptions(ch, o.userFallback)) }).then(
        function (cred) { return { cred: cred, cid: ch.cid }; },
        function (e) {
          if (e && e.name === 'NotAllowedError') throw { kind: 'cancelled' };
          if (e && e.name === 'InvalidStateError') throw { kind: 'already' };
          if (e && e.name === 'NotSupportedError') throw { kind: 'nosupport' };
          throw { kind: 'failed' };
        }
      );
    })
    .then(function (r) {
      const prefill = o.prefill();
      return o.register({ cid: r.cid, name: prefill, credential: attestationToJSON(r.cred) }).then(function (res) {
        return { res: res, prefill: prefill };
      });
    })
    .then(function (r2) {
      const res = r2.res;
      if (o.onAuthError(res)) return;
      if (res.json && res.json.ok) {
        /* 注册成功 → 命名弹层（预填名已随 register 提交，用户改了名才调 rename） */
        o.onRegistered(res.json.credId, r2.prefill);
      } else {
        o.toast(o.errText(res.json && res.json.error, res.status));
      }
    })
    .catch(function (e) {
      if (!e || e.kind === 'handled') return;
      if (e.kind === 'cancelled') o.toast(o.msg.cancelled);
      else if (e.kind === 'already') o.toast(o.msg.already);
      else if (e.kind === 'nosupport') o.toast(o.msg.noSupport);
      else if (e.kind === 'failed') o.toast(o.msg.failed);
      else if (e.kind === 'server') o.toast(o.errText(e.code, e.status));
      else o.toast(o.msg.network);
    });
}

/**
 * 命名弹层（模板里的 #lockpkname-dlg / -input / -err / -save / -skip，两页同一份 partial）。
 * - 打开：填预填名，异步补设备型号（只在用户还没改过时替换；「预填名」仍是注册时提交的那个）
 * - 保存：名字没变 → 不调接口直接算成功；变了 → o.rename(credId, name)：
 *     resolve 'ok' → 成功；'close' → 只关弹层（调用方已转去重新验证等）；字符串 → 行内错误；null → 什么都不做
 * - 跳过：用预填名，算成功；遮罩不关、返回键 / × 关闭（= 保留预填名）后调 o.onDismiss
 * 成功统一：toast(o.registeredText) → 关弹层 → o.onDone()
 * @param {{
 *   rename: (credId: string, name: string) => Promise<string|null>,
 *   onDone: () => void,
 *   onDismiss?: () => void,
 *   toast: (msg: string) => void,
 *   registeredText: string,
 *   emptyText: string,
 *   networkText: string,
 * }} o
 */
export function createPkNameDialog(o) {
  const $ = function (/** @type {string} */ id) { return document.getElementById(id); };
  const dlg = /** @type {HTMLDialogElement|null} */ ($('lockpkname-dlg'));
  /** @type {string|null} */ let credId = null;
  let prefill = '';

  function showErr(/** @type {string} */ msg) {
    const err = $('lockpkname-err');
    if (err) {
      err.textContent = msg;
      err.hidden = false;
    }
  }
  function close(/** @type {string} */ reason) {
    recordDialogClose('lockpkname', reason || 'unknown');
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
    credId = null;
    prefill = '';
  }
  function done() {
    o.toast(o.registeredText);
    close('success');
    o.onDone();
  }
  function dismiss(/** @type {string} */ reason) {
    close(reason);
    if (o.onDismiss) o.onDismiss();
  }

  if (dlg) {
    on(dlg, 'click', function (/** @type {MouseEvent} */ e) { onDialogBackdrop(e, dlg); });
    on(dlg, 'cancel', function (/** @type {Event} */ e) { onDialogCancel(e, dlg, dismiss); });
    const x = dlg.querySelector('[data-dlg-close]');
    if (x) on(x, 'click', function () { dismiss('close-btn'); });
  }
  const save = $('lockpkname-save');
  if (save) {
    bindSubmitButton(save, function () {
      const input = /** @type {HTMLInputElement|null} */ ($('lockpkname-input'));
      const name = cleanPasskeyName(input ? input.value : '');
      if (!name) {
        showErr(o.emptyText);
        return;
      }
      if (!credId) {
        close('success');
        return;
      }
      /* 没改名就不调 rename（注册时已带预填名） */
      if (name === prefill) {
        done();
        return;
      }
      o.rename(credId, name).then(function (r) {
        if (r === 'ok') done();
        else if (r === 'close') close('reverify');
        else if (typeof r === 'string') showErr(r);
      }, function () {
        showErr(o.networkText);
      });
    });
  }
  const skip = $('lockpkname-skip');
  if (skip) on(skip, 'click', function () { done(); });

  return {
    /** @param {string} id 刚注册的 credId @param {string} name 注册时提交的预填名 */
    open: function (id, name) {
      credId = id;
      prefill = name || '';
      const input = /** @type {HTMLInputElement|null} */ ($('lockpkname-input'));
      if (!dlg || !input) return;
      input.value = prefill;
      /* 异步补设备型号（userAgentData 高熵值）：用户还没改过才替换 */
      try {
        const uad = /** @type {any} */ (navigator).userAgentData;
        if (uad && uad.getHighEntropyValues) {
          uad.getHighEntropyValues(['model']).then(function (/** @type {any} */ ua) {
            if (ua && ua.model && input.value === prefill) input.value = ua.model;
          }).catch(function () {});
        }
      } catch (e) {}
      const err = $('lockpkname-err');
      if (err) err.hidden = true;
      try { dlg.showModal(); } catch (e) {}
      try { input.focus({ preventScroll: true }); } catch (e2) {}
    },
    close: close,
  };
}
