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

/* #1 诊断：门内页跳转留痕。跳转前记「谁触发的 + 原因」，
   安全页加载时取出来显示一次（取即清除）。 */
const JUMP_KEY = 'sgx-last-jump';
/**
 * @param {string} who 触发方（如 probe-fail-back、needVerify、clear-stepup、lockout）
 * @param {string} [reason] 原因（服务端 reason 码等，不含密钥或 Cookie 值）
 */
export function recordJump(who, reason) {
  try {
    sessionStorage.setItem(JUMP_KEY, JSON.stringify({ who: who, reason: reason || '', at: Date.now() }));
  } catch (e) {}
}
/** @returns {{who:string, reason:string, at:number}|null} 取出并清除记录 */
export function takeJumpRecord() {
  try {
    const raw = sessionStorage.getItem(JUMP_KEY);
    sessionStorage.removeItem(JUMP_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.who ? o : null;
  } catch (e) {
    return null;
  }
}

/* 跳验证流程只跳一次（门内多个请求并发失败时不重复跳转） */
let verifyJumped = false;

/**
 * 按失败原因取提示文案（定稿 #36：不许一律报「会话过期」）。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} [reason] 失败原因：session|stepup|network|parse
 * @param {string} [detail] 服务端原因码（如 no-pubkey、epoch-changed），拼在文案末尾方便定位
 */
function verifyMessage(t, reason, detail) {
  let msg;
  switch (reason) {
    case 'network':
      msg = t('errNetwork');
      break;
    case 'parse':
      msg = t('errParse');
      break;
    case 'stepup':
      msg = t('errStepupExpired');
      break;
    case 'session':
    default:
      msg = t('sessExp');
      break;
  }
  /* #72 补充：探针失败时 toast 末尾带上服务端原因码，例如「验证已过期（no-pubkey）」 */
  if (detail && typeof detail === 'string' && detail !== 'ok') {
    msg += '（' + detail + '）';
  }
  return msg;
}

/**
 * 验证失效 → 按真实原因提示后跳验证流程（安全与隐私页）。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} [reason] 失败原因，见 verifyMessage
 * @param {string} [detail] 服务端原因码，见 verifyMessage
 */
export function needVerify(t, reason, detail) {
  if (verifyJumped) return;
  verifyJumped = true;
  try {
    toast(verifyMessage(t, reason, detail));
  } catch (e) {}
  recordJump('needVerify', (reason || 'session') + (detail ? ':' + detail : ''));
  window.setTimeout(function () {
    location.href = securityUrl();
  }, 900);
}

/**
 * 门内直调接口：普通 POST，不自动验证、不弹面板。
 * stepup-required → 返回给调用方显示错误，不自动跳验证流程（定稿 #19）。
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
    /* 定稿 #19：不自动跳验证流程，调用方显示错误即可 */
    return res;
  });
}

/**
 * 进管理区时去掉全局锁屏遮罩，避免盖住按钮。
 * （定稿 #1：探针失败留页时也要先移除遮罩，否则原因文字被盖住）
 */
function clearLockOverlay() {
  try {
    const gl = document.getElementById('sgx-lock');
    if (gl) gl.remove();
    document.body.classList.remove('sgx-locked');
  } catch (e) {}
}

/**
 * 带回退的文案：页面没定义该 key 时用中英默认值。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} k key
 * @param {string} zh 中文默认
 * @param {string} en 英文默认
 */
function tx(t, k, zh, en) {
  try {
    const v = t(k);
    if (v && v !== k) return v;
  } catch (e) {}
  return document.documentElement.lang === 'en' ? en : zh;
}

/**
 * 探针失败 → 留在门内页显示原因，不自动跳转（定稿 #1）。
 * 先移除遮罩，在页面上显示：哪个接口、HTTP 状态码、服务端 reason，
 * 再放一个「返回安全与隐私」按钮。不显示任何密钥或 Cookie 值。
 * @param {(k:string)=>string} t 文案函数
 * @param {{reason?:string, detail?:string, api?:string, status?:number}} info 探针结果
 */
function showProbeFailure(t, info) {
  clearLockOverlay();
  const reason = (info && info.reason) || 'session';
  const detail = info && info.detail;
  const api = (info && info.api) || '';
  const status = info && typeof info.status === 'number' ? info.status : null;

  const title = tx(t, 'probeFailTitle', '无法进入', 'Cannot enter');
  const msg = verifyMessage(t, reason, detail);
  const apiLabel = tx(t, 'probeFailApi', '接口', 'API');
  const statusLabel = tx(t, 'probeFailStatus', '状态码', 'Status');
  const reasonLabel = tx(t, 'probeFailReason', '原因', 'Reason');
  const backLabel = tx(t, 'probeFailBack', '返回安全与隐私', 'Back to Security & Privacy');

  /* 隐藏管理区内容，显示失败面板 */
  const layout = document.querySelector('.set-layout');
  const panel = document.createElement('div');
  panel.id = 'sgx-probe-fail';
  panel.setAttribute('role', 'alert');

  const h = document.createElement('h2');
  h.className = 'set-gh';
  h.textContent = title;
  panel.appendChild(h);

  const card = document.createElement('section');
  card.className = 'widget bg-m-container-lowest border border-m-outline mb-2 p-4';

  const pMsg = document.createElement('p');
  pMsg.className = 'text-base font-medium m-0 mb-3';
  pMsg.textContent = msg;
  card.appendChild(pMsg);

  const dl = document.createElement('dl');
  dl.className = 'm-0 text-sm text-m-on-surface-variant';
  function addRow(label, value) {
    if (value === null || value === undefined || value === '') return;
    const dt = document.createElement('dt');
    dt.className = 'inline font-medium';
    dt.textContent = label + '：';
    const dd = document.createElement('dd');
    dd.className = 'inline m-0 mr-4 font-mono break-all';
    dd.textContent = String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
    dl.appendChild(document.createElement('br'));
  }
  addRow(apiLabel, api);
  addRow(statusLabel, status);
  /* 服务端 reason 只显示原因码，不显示任何密钥或 Cookie 值 */
  addRow(reasonLabel, detail && detail !== 'ok' ? detail : reason);
  card.appendChild(dl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sgx-verify-skip mt-4';
  btn.textContent = backLabel;
  btn.addEventListener('click', function () {
    recordJump('probe-fail-back', (detail && detail !== 'ok' ? detail : reason));
    location.href = securityUrl();
  });
  card.appendChild(btn);

  panel.appendChild(card);

  if (layout) {
    /* 隐藏原有管理区内容，失败面板放最前面 */
    Array.prototype.forEach.call(layout.children, function (child) {
      if (child.id !== 'sgx-probe-fail') child.hidden = true;
    });
    layout.insertBefore(panel, layout.firstChild);
  } else {
    document.body.insertBefore(panel, document.body.firstChild);
  }
}

/**
 * 进门探针：页面直接渲染；验证有效 → onEnter() 进管理区；
 * 无效 → 留在门内页显示原因（定稿 #1），不自动跳转、不弹面板。
 * @param {()=>Promise<boolean|{ok:boolean,reason?:string,detail?:string,api?:string,status?:number}>} probe 验证有效时 resolve true
 * @param {()=>void} onEnter 进门回调
 * @param {(k:string)=>string} t 文案函数
 */
export function enterDoor(probe, onEnter, t) {
  probe().then(function (result) {
    const isObj = result && typeof result === 'object';
    const ok = isObj ? !!result.ok : !!result;
    if (ok) {
      clearLockOverlay();
      onEnter();
    } else {
      /* 定稿 #1：探针失败留页显示原因，不自动跳转 */
      showProbeFailure(t, isObj ? result : { reason: 'session' });
    }
  }).catch(function () {
    showProbeFailure(t, { reason: 'network', status: 0 });
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
    recordJump('clear-stepup', targetUrl);
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
