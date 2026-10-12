/**
 * @fileoverview 各门管理页共用：进门探针 + 门内直调接口 + 错误码文案。
 *
 * 两扇门设计（2.11）：进门只验一次（安全与隐私页入口），门内（验证有效期内）
 * 查看/添加/重命名/删除/改密码全部直接调接口，不弹验证、不发起 WebAuthn
 * 挑战（添加密钥时创建凭据本身除外）。
 * - enterDoor()：页面直接渲染；进门探针确认验证有效才进管理区，
 *   无效则跳验证流程（安全与隐私页），不弹任何面板。
 * - api()：普通 POST，不自动验证；服务端报 stepup-required 时提示后
 *   跳验证流程，调用方直接 return 即可。
 * - clearStepup()：离开门时调 POST /api/stepup {action:'clear'} 清验证，
 *   再跳转（幂等；失败也不卡住用户）。
 * - apiErrorText()：按服务端 error 码给中文提示，不说笼统的"服务器错误"。
 */
import { toast } from '../lib/toast.js';

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
 * 统一解析 API 响应：{ status, json }，区分网络错误/业务错误。
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

/** @returns {string} 安全与隐私页地址（验证流程入口，语言跟随） */
export function securityUrl() {
  return document.documentElement.lang === 'en' ? '/en/settings/security/' : '/settings/security/';
}

/* 跳验证流程只跳一次（门内多个请求并发失败时不重复跳转） */
let verifyJumped = false;

/**
 * 验证失效 → 提示后跳验证流程（安全与隐私页）。
 * @param {(k:string)=>string} t 文案函数
 */
export function needVerify(t) {
  if (verifyJumped) return;
  verifyJumped = true;
  try {
    toast(t('sessExp'));
  } catch (e) {}
  window.setTimeout(function () {
    location.href = securityUrl();
  }, 900);
}

/**
 * 门内直调接口：普通 POST，不自动验证、不弹面板。
 * stepup-required → needVerify() 跳验证流程；调用方在 then 里见到该
 * error 码直接 return 即可（跳转已安排）。
 * @param {string} url
 * @param {any} body
 * @param {(k:string)=>string} t 文案函数
 */
export function api(url, body, t) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  }).then(parseApi).then(function (res) {
    if (res.json && res.json.error === 'stepup-required') {
      needVerify(t);
    }
    return res;
  });
}

/**
 * 进门探针：页面直接渲染；验证有效 → onEnter() 进管理区；
 * 无效 → 跳验证流程（安全与隐私页），不弹面板。
 * @param {()=>Promise<boolean>} probe 验证有效时 resolve true
 * @param {()=>void} onEnter 进门回调
 * @param {(k:string)=>string} t 文案函数
 */
export function enterDoor(probe, onEnter, t) {
  /* 进管理区时去掉全局锁屏遮罩，避免盖住按钮 */
  function clearLockOverlay() {
    try {
      const gl = document.getElementById('sgx-lock');
      if (gl) gl.remove();
      document.body.classList.remove('sgx-locked');
    } catch (e) {}
  }
  probe().then(function (ok) {
    if (ok) {
      clearLockOverlay();
      onEnter();
    } else {
      needVerify(t);
    }
  }).catch(function () {
    needVerify(t);
  });
}

/**
 * 离开门时清验证：POST /api/stepup {action:'clear'}（幂等），
 * 完成后（或失败/超时）再跳转，不卡住用户。
 * @param {string} targetUrl 跳转目标
 */
export function clearStepupThen(targetUrl) {
  let done = false;
  function go() {
    if (done) return;
    done = true;
    location.href = targetUrl;
  }
  /* 兜底：3 秒还没回来也走，不把用户晾在门里 */
  window.setTimeout(go, 3000);
  try {
    fetch('/api/stepup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
      credentials: 'include',
    }).then(go, go);
  } catch (e) {
    go();
  }
}

/* 服务端 error 码 → 模板 i18n key（中英在模板里）。
   stepup-required/session/scope/by-root 不在这里：它们走 needVerify 跳转，
   不向用户展示开发用语。 */
var ERR_KEY = {
  'params': 'errParams',
  'body': 'errParams',
  'method': 'errParams',
  'action': 'errParams',
  'not-found': 'errNotFound',
  'last-key': 'errLastKey',
  'epoch': 'errRetry',
  'server': 'errServer',
  'origin': 'errServer',
  'sign-failed': 'errServer',
  'no-stepup-key': 'errServer',
  'challenge': 'errChallenge',
  'verify': 'errVerify',
  'class': 'errVerify',
  'class-mismatch': 'errVerify',
  'aud-mismatch': 'errVerify',
  'unknown-key': 'errVerify',
  'uv-required': 'errUvRequired',
  'wrong': 'errWrongPw',
  'short': 'errShort',
  'exists': 'errExists',
  'not-set': 'errNotSet',
  'locked': 'errLocked',
  'config': 'errConfig',
  'aud': 'errAud',
  'cancelled': 'errCancelled',
  'forbidden': 'errServer',
  'role': 'errServer',
  'app-auth-required': 'errVerify',
  'no-app-key': 'errNotSet',
  'return': 'errParams',
  'content-type': 'errParams',
};

/**
 * 按 error 码取用户文案；未知码给通用提示，不说"服务器错误"。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} code 服务端 error 码
 */
export function apiErrorText(t, code) {
  const k = ERR_KEY[code];
  if (k) {
    const v = t(k);
    if (v && v !== k) return v;
  }
  return t('errUnknown');
}
