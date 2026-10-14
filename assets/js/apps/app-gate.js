/**
 * @fileoverview 各门管理页共用：进门探针 + 门内直调接口 + 错误码文案 + 倒计时 + 到期弹框。
 *
 * 两扇门设计（2.11）：进门只验一次（安全与隐私页入口），门内（验证有效期内）
 * 查看/添加/重命名/删除/改密码全部直接调接口，不弹验证、不发起 WebAuthn
 * 挑战（添加密钥时创建凭据本身除外）。
 * - enterDoor()：探针确认验证有效才进管理区（onEnter 拿到 expiresAt 后启动倒计时）；
 *   票据/会话失效 → showExpiredDialog 弹框，点了按钮才动作，不自动跳转；
 *   探针网络/解析失败 → showProbeFailure 面板，不算过期。
 * - api()：普通 POST，不自动验证；服务端报 stepup-required 时调用方走 handleDoorError → 弹框。
 * - clearStepupThen()：离开门时调 POST /api/stepup {action:'clear'} 清验证，
 *   再跳转（幂等；失败也不卡住用户）。
 * - startDoorCountdown()：门内页大标题下方胶囊「验证剩余 m:ss」，以服务端 status 的
 *   expiresAt 为准；≤30 秒只变警示色；到 0 停在「已过期」，不自动跳转、不弹框。
 * - apiErrorText()：按服务端 error 码给中文提示，不说笼统的"服务器错误"。
 */
import { sgxNavigate, sgxReload } from '../lib/diag-jumptrace.js';
import { showCenterDialog } from '../lib/dialog-behavior.js';

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

/* 验证失效弹框只弹一次（门内多个请求并发失败时不重复弹框） */
let verifyJumped = false;
/* 到期弹框是否已打开（showExpiredDialog 自身 guard，与 needVerify 的 guard 双保险） */
let expiredDialogOpen = false;
/* 倒计时：timer / 胶囊元素 / 当前过期时刻 */
let countdownTimer = null;
let countdownEl = null;
let countdownExpiresAt = 0;

/**
 * 按失败原因取提示文案（定稿 #36：不许一律报「会话过期」）。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} [reason] 失败原因：session|stepup|network|parse
 * @param {string} [detail] 服务端原因码（如 no-pubkey、epoch-changed），拼在文案末尾方便定位
 */
function verifyMessage(t, reason, detail) {
  /* 批次 A 验收修复 P0：代管中途站长层被配置 → 明确提示，不无提示踢回安全页 */
  if (reason === 'owner-configured' || detail === 'owner-configured') {
    return tx(t, 'errOwnerConfigured', '站长凭证已设置，请用站长凭证重新验证', 'Owner credential is set, please verify with the owner credential again');
  }
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
 * 验证失效 → 按真实原因弹 One UI 框，点了按钮才动作，不自动跳转（A-1，定稿 #22）。
 * kind='stepup'：按钮「返回安全与隐私」→ clearStepupThen('/settings/security/')。
 * kind='session'：按钮「去锁屏」→ sgxReload()（中间件会把失效会话送去锁屏）。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} [reason] 失败原因：'session' 走会话弹框，其余走验证弹框
 * @param {string} [detail] 服务端原因码（如 'owner-configured'，透传进弹框文案）
 */
export function needVerify(t, reason, detail) {
  if (verifyJumped) return;
  verifyJumped = true;
  showExpiredDialog(t, reason === 'session' ? 'session' : 'stepup', detail);
}

/**
 * 到期弹框（A-1，定稿 #22）：居中模态，无 ×，遮罩/返回手势不能关，
 * 并发只弹一个，弹框时停倒计时、收起其他 sheet（showCenterDialog 负责）。
 * @param {(k:string)=>string} t 文案函数
 * @param {'stepup'|'session'} kind 弹框类型
 * @param {string} [detail] 服务端原因码（如 'owner-configured'）
 */
export function showExpiredDialog(t, kind, detail) {
  if (expiredDialogOpen) return;
  expiredDialogOpen = true;
  /* 探针失败也可能弹框：先移除全局锁屏遮罩，避免盖住弹框 */
  clearLockOverlay();
  /* v1.1 §二.2：弹框出现时隐藏倒计时胶囊（避免胶囊「验证剩余 2:55」与弹框「验证已过期」矛盾） */
  hideDoorCountdown();
  const isSession = kind === 'session';
  const isOwnerConfigured = detail === 'owner-configured';
  const title = isSession
    ? tx(t, 'expiredSessionTitle', '会话已失效', 'Session expired')
    : tx(t, 'expiredStepupTitle', '验证已过期', 'Verification expired');
  let desc;
  if (isOwnerConfigured) {
    desc = tx(t, 'errOwnerConfigured', '站长凭证已设置，请用站长凭证重新验证', 'Owner credential is set, please verify with the owner credential again');
  } else if (isSession) {
    desc = tx(t, 'expiredSessionDesc', '请回到锁屏重新解锁', 'Please go back to the lock screen to unlock again.');
  } else {
    desc = tx(t, 'expiredStepupDesc', '请返回安全与隐私重新验证', 'Please go back to Security & Privacy to verify again.');
  }
  const btnLabel = isSession
    ? tx(t, 'expiredSessionBtn', '去锁屏', 'Go to lock screen')
    : tx(t, 'expiredStepupBtn', '返回安全与隐私', 'Back to Security & Privacy');
  /* C4：弹框打开时拦住返回手势。移动端返回手势走 history（非 dialog cancel 事件），
     仅 preventDefault(cancel) 拦不住。用 pushState 占一位，popstate 时等同于
     点按钮（不直接关框），避免退回已过期的门内页。 */
  var backGuardActive = false;
  function cleanupBackGuard() {
    if (!backGuardActive) return;
    backGuardActive = false;
    try { window.removeEventListener('popstate', onBackPopstate); } catch (e) {}
  }
  function goFromDialog() {
    cleanupBackGuard();
    if (isSession) sgxReload('app-gate.js:showExpiredDialog', 'session-expired');
    else clearStepupThen('/settings/security/');
  }
  function onBackPopstate() {
    if (!backGuardActive || !expiredDialogOpen) return;
    /* 返回 = 点按钮：关框并走按钮动作，不留在已过期的门内页 */
    backGuardActive = false;
    try { window.removeEventListener('popstate', onBackPopstate); } catch (e) {}
    try { closeExpiredDialog(); } catch (e) {}
    goFromDialog();
  }
  var closeExpiredDialog = showCenterDialog({
    title: title,
    desc: desc,
    dismissible: false,
    buttons: [{
      label: btnLabel,
      kind: 'primary',
      onClick: goFromDialog,
    }],
    onClose: function () { expiredDialogOpen = false; cleanupBackGuard(); },
  });
  try {
    history.pushState({ sgxExpiredDlg: 1 }, '');
    backGuardActive = true;
    window.addEventListener('popstate', onBackPopstate);
  } catch (e) {}
}

/** m:ss 格式（向上取整，避免 2:59 跳 2:58 时闪 2:57） */

/**
 * C5：门内操作前检查倒计时是否已过期。已过期 → 直接弹到期框，
 * 返回 true（调用方不再继续，不进入「再点一次」）；未过期 → 返回 false。
 * @param {(k:string)=>string} t 文案函数
 * @returns {boolean} 是否已过期（已弹框）
 */
export function guardDoorExpired(t) {
  if (countdownExpiresAt > 0 && Date.now() >= countdownExpiresAt) {
    needVerify(t, 'stepup');
    return true;
  }
  return false;
}function fmtDoorCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** 渲染一帧倒计时：文案 + ≤30 秒警示色；到 0 停在「已过期」，停表不跳转 */
function renderDoorCountdown(t) {
  if (!countdownEl) return;
  const text = countdownEl.querySelector('.sgx-door-countdown-text');
  const left = countdownExpiresAt - Date.now();
  if (left <= 0) {
    stopDoorCountdown();
    countdownEl.classList.add('sgx-countdown-warn');
    if (text) text.textContent = tx(t, 'doorCountdownExpired', '已过期', 'Expired');
    return;
  }
  countdownEl.classList.toggle('sgx-countdown-warn', left <= 30000);
  if (text) text.textContent = tx(t, 'doorCountdown', '验证剩余 {m}', 'Verification remaining {m}').replace('{m}', fmtDoorCountdown(left));
}

/**
 * 等卡片入场动画结束（.animate-fade-up 的 fade-up 动画）。
 * 无动画（非首次进入 / 减动效 / 动画已结束）时立即 resolve；
 * 1500ms 兜底超时，避免异常动画阻塞胶囊。
 * @returns {Promise<void>}
 */
function waitForCardAnimations() {
  try {
    const pending = [];
    const cards = document.querySelectorAll('.animate-fade-up');
    for (let i = 0; i < cards.length; i++) {
      const anims = cards[i].getAnimations();
      for (let j = 0; j < anims.length; j++) {
        pending.push(anims[j].finished);
      }
    }
    if (!pending.length) return Promise.resolve();
    const settled = pending.map(function (p) {
      return p.then(function () {}, function () {});
    });
    return Promise.race([
      Promise.all(settled),
      new Promise(function (resolve) { window.setTimeout(resolve, 1500); }),
    ]);
  } catch (e) {
    return Promise.resolve();
  }
}

/**
 * 启动门内倒计时（A-1）：胶囊在大标题正下方、与标题左对齐。
 * expiresAt 为服务端签发的绝对过期时刻（毫秒）；未传时拉一次 status 取 expiresAt。
 * 已启动时直接换成新的 expiresAt（门内操作重签后刷新用）。
 * @param {(k:string)=>string} t 文案函数
 * @param {number} [expiresAt] 服务端过期时刻（毫秒）
 */
export function startDoorCountdown(t, expiresAt) {
  /* v1.1 §二.2 修复（CI 38506326885 唯一失败）：到期/会话失效弹框已打开时不创建胶囊。
     覆盖两种返回顺序：
     - 弹框先开（锁屏页双列表 403 → needVerify → 弹框），随后 startCapsule 调起时守卫拦截；
     - 胶囊先建，弹框后开时 showExpiredDialog → hideDoorCountdown 已移除。
     异步分支（未传 expiresAt 时拉 status）回调会再次进入本函数，守卫同样生效，
     不会因 stepup 请求在途、弹框中途打开而重建胶囊。 */
  if (expiredDialogOpen) return;
  if (typeof expiresAt === 'number' && isFinite(expiresAt) && expiresAt > 0) {
    /* v1.1 §二.1 补充：等卡片入场动画结束后再建胶囊，胶囊出现时卡片已不透明、无重叠，
       避免「胶囊已显示、卡片还在淡入」。等待期间弹框若打开，守卫重新拦截，不建胶囊。 */
    waitForCardAnimations().then(function () {
        if (expiredDialogOpen) return;
        if (!countdownEl) {
        const el = document.createElement('div');
        el.id = 'sgx-door-countdown';
        el.className = 'sgx-door-countdown';
        el.setAttribute('role', 'timer');
        const icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        /* 时钟图标（与 icon.html 的 clock 同款路径） */
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
        const text = document.createElement('span');
        text.className = 'sgx-door-countdown-text';
        el.appendChild(icon);
        el.appendChild(text);
        const head = document.querySelector('header.subpage-head');
        if (head) {
          /* 放进 header 内部（大标题正下方）：.set-layout 在桌面端是 2 列 grid，
             作为 header 的兄弟元素会被自动放到第 1 行第 2 列，与标题重叠；放进
             header 的 flex 列里则始终在标题下方，且 align-self 左对齐。 */
          head.appendChild(el);
        } else {
          const layout = document.querySelector('.set-layout');
          if (layout) layout.insertBefore(el, layout.firstChild);
          else document.body.insertBefore(el, document.body.firstChild);
        }
        countdownEl = el;
        }
        countdownExpiresAt = expiresAt;
        stopDoorCountdown();
        renderDoorCountdown(t);
        countdownTimer = window.setInterval(function () { renderDoorCountdown(t); }, 1000);
    });
    return;
  }
  /* 未传 expiresAt：拉一次 status 取服务端过期时刻（前端不解析 Cookie） */
  try {
    fetch('/api/stepup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
      credentials: 'include',
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok && j.valid && typeof j.expiresAt === 'number') startDoorCountdown(t, j.expiresAt);
      else stopDoorCountdown();
    }).catch(function () { stopDoorCountdown(); });
  } catch (e) {}
}

/** 门内操作重签后刷新倒计时（重新取 status 的 expiresAt，回到约 3:00 是既有行为） */
export function refreshDoorCountdown(t) {
  startDoorCountdown(t);
}

/** 停倒计时（到 0 / 取 expiresAt 失败时调用；胶囊保留在当前值，不消失） */
export function stopDoorCountdown() {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/**
 * 隐藏倒计时胶囊（v1.1 §二.2：到期/会话失效弹框出现时调用）。
 * 停表 + 把胶囊从 DOM 移除（countdownEl 置空，后续 startDoorCountdown 会重建）。
 * 探针失败时胶囊还没创建，调用安全（直接返回）。
 */
function hideDoorCountdown() {
  stopDoorCountdown();
  try {
    if (countdownEl) countdownEl.remove();
  } catch (e) {}
  countdownEl = null;
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
 * 进门探针：验证有效 → onEnter(result) 进管理区（result 带 expiresAt 时启动倒计时）；
 * 票据/会话失效 → showExpiredDialog 弹框，点了按钮才动作，不自动跳转；
 * 探针网络/解析失败 → showProbeFailure 面板（不算过期，不弹框）。
 * @param {()=>Promise<boolean|{ok:boolean,reason?:string,detail?:string,api?:string,status?:number,expiresAt?:number}>} probe 验证有效时 resolve true
 * @param {(result:any)=>void} onEnter 进门回调
 * @param {(k:string)=>string} t 文案函数
 */
export function enterDoor(probe, onEnter, t) {
  probe().then(function (result) {
    const isObj = result && typeof result === 'object';
    const ok = isObj ? !!result.ok : !!result;
    if (ok) {
      clearLockOverlay();
      onEnter(isObj ? result : null);
    } else {
      /* A-1：按失败原因分流——网络/解析走面板，其余走到期弹框 */
      const info = isObj ? result : { reason: 'session' };
      const reason = info.reason || 'session';
      if (reason === 'network' || reason === 'parse') {
        showProbeFailure(t, info);
      } else if (reason === 'session') {
        needVerify(t, 'session', info.detail);
      } else {
        /* stepup / stepup-required / scope / by-root / owner-configured → 验证弹框 */
        needVerify(t, 'stepup', info.detail || reason);
      }
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
 * B1：未知错误时在后面用小字附上原始错误码和 HTTP 状态码，
 * 例如「未知错误，请稍后重试（scope/403）」。只显示错误码和状态码，
 * 不带任何密钥、Cookie 或票据内容。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} code 服务端 error 码
 * @param {number} [status] HTTP 状态码
 */
export function apiErrorText(t, code, status) {
  const k = ERR_KEY[code];
  if (k) {
    const v = t(k);
    if (!isMissingTranslation(v, k)) return v;
  }
  let msg = t('errUnknown');
  /* 未知码：附上原始错误码和状态码，方便定位 */
  if (code) {
    msg += '（' + code + (typeof status === 'number' && status ? '/' + status : '') + '）';
  }
  return msg;
}

/* D3：门内页收到这 4 个码时走 needVerify（弹框），不显示未知错误。
   按 app-gate.js 原注释本意：它们走 needVerify 弹框，不向用户展示开发用语。 */
const NEED_VERIFY_CODES = ['session', 'stepup-required', 'scope', 'by-root'];
/**
 * 门内页 API 错误分流：session/stepup-required/scope/by-root → needVerify（弹框）；
 * 其他 → 返回 false，调用方按原逻辑显示错误（含 B1 小字错误码）。
 * @param {(k:string)=>string} t 文案函数
 * @param {string} code 服务端 error 码
 * @param {number} [status] HTTP 状态码
 * @param {string} [detail] 服务端 reason（如 'owner-configured'，透传给 needVerify 显示明确文案）
 * @returns {boolean} true = 已走 needVerify，调用方直接 return
 */
export function handleDoorError(t, code, status, detail) {
  if (NEED_VERIFY_CODES.indexOf(code) === -1) return false;
  /* needVerify 按真实原因弹框（点了按钮才动作，不自动跳转） */
  const reason = code === 'session' ? 'session' : 'stepup';
  needVerify(t, reason, detail || code);
  return true;
}
