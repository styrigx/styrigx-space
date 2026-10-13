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
import { sgxNavigate, sgxReload } from '../lib/diag-jumptrace.js';
import { showAlertDialog } from '../lib/dialog-behavior.js';

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

/* #1 诊断：门内页跳转留痕（实现已移至 lib/diag-jumptrace.js，此处 re-export 保持兼容）。
   跳转前记「谁触发的 + 原因」，安全页加载时取出来显示一次（取即清除）。 */
export { recordJump, takeJumpRecord, takeJumpRecords } from '../lib/diag-jumptrace.js';

/* 跳验证流程只跳一次（门内多个请求并发失败时不重复跳转） */
let verifyJumped = false;

/**
 * 验证/会话失效 → 弹共用单按钮提示框（批次 B #13），不再 toast + 自动跳转。
 * - 验证过期（stepup）：文案「验证已过期，请重新验证」，按钮「返回安全与隐私」，
 *   点后清 stepup 票据再跳安全页。
 * - 会话失效（session）：文案说明原因，按钮「去锁屏」，点后重载回锁屏。
 * 模态阻塞，无 ×、无遮罩关闭、返回手势不关闭；防重复；弹框时停掉倒计时。
 * 与 #8、#10、#16 的弹框共用 dialog-behavior.js 的 helper。
 * @param {(k:string)=>string} t 文案函数
 * @param {'stepup'|'session'} kind 失效种类
 * @param {string} [detail] 服务端 reason（如 'owner-configured'，显示明确文案）
 * @returns {Promise<void>}
 */
let expiredShown = false;
export function showExpiredDialog(t, kind, detail) {
  if (expiredShown) return Promise.resolve();
  expiredShown = true;
  stopDoorCountdown();
  let title;
  let desc;
  let btn;
  if (kind === 'session') {
    title = tx(t, 'expiredSessionTitle', '会话已失效', 'Session expired');
    desc = tx(t, 'expiredSessionDesc', '当前会话已失效，请重新解锁后继续。', 'Your session has expired. Please unlock again to continue.');
    btn = tx(t, 'expiredSessionBtn', '去锁屏', 'Go to lock screen');
  } else if (detail === 'owner-configured') {
    /* 批次 A 验收修复 P0：代管中途站长层被配置 → 明确提示，不无提示踢回安全页 */
    title = tx(t, 'expiredStepupTitle', '验证已过期', 'Verification expired');
    desc = tx(t, 'errOwnerConfigured', '站长凭证已设置，请用站长凭证重新验证', 'Owner credential is set, please verify with the owner credential again');
    btn = tx(t, 'expiredStepupBtn', '返回安全与隐私', 'Back to Security & privacy');
  } else {
    title = tx(t, 'expiredStepupTitle', '验证已过期', 'Verification expired');
    desc = tx(t, 'expiredStepupDesc', '验证已过期，请重新验证。', 'Verification has expired. Please verify again.');
    btn = tx(t, 'expiredStepupBtn', '返回安全与隐私', 'Back to Security & privacy');
  }
  return showAlertDialog({ title: title, desc: desc, buttonLabel: btn }).then(function () {
    if (kind === 'session') {
      sgxReload('app-gate.js:showExpiredDialog', 'session-expired');
    } else {
      clearStepupThen(securityUrl());
    }
  });
}

/**
 * 验证失效 → 按真实原因弹共用提示框（批次 B #13），不再 toast + 自动跳转。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} [reason] 失败原因：session | stepup | 其他（按 stepup 处理）
 * @param {string} [detail] 服务端原因码（如 'owner-configured'）
 */
export function needVerify(t, reason, detail) {
  if (verifyJumped) return;
  verifyJumped = true;
  const kind = reason === 'session' ? 'session' : 'stepup';
  showExpiredDialog(t, kind, detail).catch(function () {});
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
 * t() 兜底文案（批次 A 收尾 #36）：缺键返回通用文案而非键名。
 * 下面的两处“键是否已定义”判断必须把通用文案也视为缺键，
 * 否则会把兜底文案当成已定义的翻译用掉（探针面板标题/标签/按钮
 * 会全变成“出错了，请重试”，且 apiErrorText 会丢掉错误码小字）。
 * @param {string} v t() 返回值
 * @param {string} k key
 */
function isMissingTranslation(v, k) {
  return !v || v === k || v === '出错了，请重试' || v === 'Something went wrong, please retry';
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
    if (!isMissingTranslation(v, k)) return v;
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
    sgxNavigate(securityUrl(), 'app-gate.js:probe-fail-btn', (detail && detail !== 'ok' ? detail : reason));
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
    sgxNavigate(targetUrl, 'app-gate.js:clear-stepup', 'clear-stepup');
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
  /* 批次 A 验收修复 P1：双向相同密码（owner-password.js 双向检查），不再落 errUnknown + 小字 */
  'same-as-lock': 'errSameAsLock',
  'same-as-owner': 'errSameAsOwner',
  /* 空密码 400（前端已拦长度，兜底映射，避免未知错误） */
  'password': 'errParams',
  'app-auth-required': 'errVerify',
  'no-app-key': 'errNotSet',
  'return': 'errParams',
  'content-type': 'errParams',
};

/**
 * 按 error 码取用户文案；未知码给通用提示，不说"服务器错误"。
 * 批次 B #6：删掉 B1 后缀（不再附原始错误码和 HTTP 状态码），界面不出现内部名和错误码。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} code 服务端 error 码
 * @param {number} [status] HTTP 状态码（保留入参兼容调用方，不再显示）
 */
export function apiErrorText(t, code, status) {
  const k = ERR_KEY[code];
  if (k) {
    const v = t(k);
    if (!isMissingTranslation(v, k)) return v;
  }
  return t('errUnknown');
}

/* D3：门内页收到这 4 个码时走 needVerify，不显示未知错误。
   按 app-gate.js 原注释本意：它们走 needVerify 弹框，不向用户展示开发用语。 */
const NEED_VERIFY_CODES = ['session', 'stepup-required', 'scope', 'by-root'];
/**
 * 门内页 API 错误分流：session/stepup-required/scope/by-root → needVerify；
 * 其他 → 返回 false，调用方按原逻辑显示错误。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} code 服务端 error 码
 * @param {number} [status] HTTP 状态码
 * @param {string} [detail] 服务端 reason（如 'owner-configured'，透传给 needVerify 显示明确文案）
 * @returns {boolean} true = 已走 needVerify，调用方直接 return
 */
export function handleDoorError(t, code, status, detail) {
  if (NEED_VERIFY_CODES.indexOf(code) === -1) return false;
  /* needVerify 按真实原因弹共用提示框（批次 B #13） */
  const reason = code === 'session' ? 'session' : 'stepup';
  needVerify(t, reason, detail || code);
  return true;
}

/**
 * 倒计时格式化（批次 B #12）：毫秒 → 'm:ss'。纯函数，可单元测试。
 * @param {number} ms 剩余毫秒
 * @returns {string} 如 '2:59'；<=0 时返回 '0:00'
 */
export function formatDoorRemaining(ms) {
  const left = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m + ':' + (s < 10 ? '0' + s : '' + s);
}

/* 门内页倒计时（批次 B #12）：顶部 sticky 条，每秒渲染一次。 */
let countdownTimer = null;
let countdownBar = null;

/** 停掉倒计时并移除顶部条（到期弹框时调用；到 0 时自动停，不自动跳转）。 */
export function stopDoorCountdown() {
  if (countdownTimer !== null) {
    try { window.clearInterval(countdownTimer); } catch (e) {}
    countdownTimer = null;
  }
  if (countdownBar) {
    try { countdownBar.remove(); } catch (e) {}
    countdownBar = null;
  }
}

/**
 * 启动门内页验证剩余时间倒计时（批次 B #12，door.js / security-mgmt.js /
 * security-apps-book.js / security-apps.js / security-lock.js 进门成功后调用）。
 * @param {(k:string)=>string} t 文案函数
 * @param {number} [expiresAt] 绝对时间戳（毫秒；未传时拉一次 status 取 expiresAt）
 */
export function startDoorCountdown(t, expiresAt) {
  stopDoorCountdown();
  function start(exp) {
    if (!exp || exp <= Date.now()) return;
    let bar = document.getElementById('sgx-door-countdown');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'sgx-door-countdown';
      bar.className = 'sgx-countdown-bar';
      bar.setAttribute('role', 'status');
      if (document.body) document.body.prepend(bar);
      else return;
    }
    countdownBar = bar;
    const prefix = tx(t, 'doorCountdown', '验证剩余 ', 'Verification expires in ');
    function render() {
      const left = exp - Date.now();
      if (left <= 0) {
        stopDoorCountdown();
        return;
      }
      bar.textContent = prefix + formatDoorRemaining(left);
      if (left <= 30000) bar.classList.add('sgx-countdown-warn');
      else bar.classList.remove('sgx-countdown-warn');
    }
    render();
    countdownTimer = window.setInterval(render, 1000);
  }
  if (typeof expiresAt === 'number' && expiresAt > 0) {
    start(expiresAt);
    return;
  }
  /* 未传 expiresAt：拉一次 status 取（探针成功后调用，失败时不显示条） */
  try {
    fetch('/api/stepup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
      credentials: 'include',
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.valid && typeof j.expiresAt === 'number') start(j.expiresAt);
    }).catch(function () {});
  } catch (e) {}
}
