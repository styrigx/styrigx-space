/**
 * @fileoverview B2-7 网站数字健康计时器（主站 / 书站 / 博客共用同一份，零依赖，可原样复制）。
 *
 * 只在「页面可见」且「最近有操作」时计时（默认 60 秒，阅读页可放宽到几分钟）；挂着不动、切到后台都不算。
 * 时长先攒在 localStorage（sgx-wb-pending），最多 5 分钟、或页面隐藏/离开时，
 * 用 sendBeacon 以 text/plain 发到主站 /api/wellbeing（同站子域自动带 cookie，免 CORS 预检）。
 * 服务器只记站长（owner），访客上报会被丢弃。
 *
 * 上报格式：{"d":"YYYY-MM-DD(本机日期)","s":[{"k":"home","sec":42},{"k":"book:id","t":"书名","sec":300}]}
 */

const IDLE_MS = 60000; /* 默认超过 60 秒没操作就停表 */
const TICK_MS = 5000;
const FLUSH_MS = 300000; /* 最多 5 分钟上报一次 */
const MAX_SEC = 900; /* 服务器单条上限 */
const LS_KEY = 'sgx-wb-pending';

/** @returns {string} 本机日期 YYYY-MM-DD */
export function localDay(d = new Date()) {
  const m = d.getMonth() + 1,
    day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

/**
 * @typedef {{d: string, s: Record<string, {t: string, sec: number}>}} Pending
 */

/** @returns {Pending|null} */
function load() {
  try {
    const v = JSON.parse(window.localStorage.getItem(LS_KEY) || 'null');
    if (v && typeof v.d === 'string' && v.s && typeof v.s === 'object') return v;
  } catch (e) {}
  return null;
}

/** @param {Pending|null} v */
function save(v) {
  try {
    if (v && Object.keys(v.s).length) window.localStorage.setItem(LS_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(LS_KEY);
  } catch (e) {}
}

/**
 * 把待上报数据拆成一个请求体（每条不超过 MAX_SEC，超出部分留到下次）。
 * @param {Pending} p
 * @returns {{body: string, rest: Pending}}
 */
export function buildBody(p) {
  const s = [];
  /** @type {Pending} */
  const rest = { d: p.d, s: {} };
  for (const k of Object.keys(p.s)) {
    const e = p.s[k];
    const sec = Math.floor(e.sec);
    if (sec < 1) {
      rest.s[k] = e;
      continue;
    }
    const send = Math.min(sec, MAX_SEC);
    const item = /** @type {{k:string,sec:number,t?:string}} */ ({ k, sec: send });
    if (e.t) item.t = e.t;
    s.push(item);
    const left = e.sec - send;
    if (left > 0) rest.s[k] = { t: e.t, sec: left };
  }
  return { body: s.length ? JSON.stringify({ d: p.d, s: s.slice(0, 12) }) : '', rest };
}

/**
 * 启动计时（每页调用一次）。
 * @param {{key: string|null, title?: string|(() => string), endpoint?: string, idleMs?: number}} opt
 *   key：区域键（home/files/browser/settings/book/book:<id>/blog/post:<slug>），null 不计时
 *   title：书名 / 文章名，可传函数（阅读器加载完才知道书名时用 () => document.title）
 *   idleMs：多久没操作停表；阅读页建议 300000（看一页书可能几分钟不碰屏幕）
 *   endpoint：主站用相对地址 /api/wellbeing，子站用 https://styrigx.com/api/wellbeing
 * @returns {{stop: () => void, flush: () => void}|null}
 */
export function initWbTrack(opt) {
  if (!opt || !opt.key || typeof window === 'undefined') return null;
  const key = opt.key;
  const titleOf = () => String((typeof opt.title === 'function' ? opt.title() : opt.title) || '').slice(0, 60);
  const endpoint = opt.endpoint || '/api/wellbeing';
  const idleMs = opt.idleMs && opt.idleMs > 0 ? opt.idleMs : IDLE_MS;
  let lastInput = Date.now();
  let lastTick = Date.now();
  let lastFlush = Date.now();

  function active() {
    return document.visibilityState === 'visible' && Date.now() - lastInput < idleMs;
  }

  function add(sec) {
    if (sec <= 0) return;
    const today = localDay();
    let p = load();
    if (p && p.d !== today) {
      send(p); /* 跨天：先把昨天的发掉 */
      p = null;
    }
    if (!p) p = { d: today, s: {} };
    const title = titleOf();
    const e = p.s[key] || { t: title, sec: 0 };
    e.sec += sec;
    if (title) e.t = title;
    p.s[key] = e;
    save(p);
  }

  function tick() {
    const now = Date.now();
    const dt = Math.min(now - lastTick, TICK_MS * 2);
    if (active()) add(dt / 1000);
    lastTick = now;
    if (now - lastFlush >= FLUSH_MS) flush();
  }

  /** @param {Pending} p @returns {Pending} 没发出去的部分 */
  function send(p) {
    const { body, rest } = buildBody(p);
    if (!body) return p;
    let ok = false;
    try {
      ok = !!(navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' })));
    } catch (e) {}
    if (!ok) {
      try {
        fetch(endpoint, { method: 'POST', body, credentials: 'include', keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } });
        ok = true;
      } catch (e) {}
    }
    return ok ? rest : p;
  }

  function flush() {
    lastFlush = Date.now();
    const p = load();
    if (!p) return;
    const left = send(p);
    /* 跨天的旧数据发不出去就丢掉，避免一直积压 */
    save(left.d === localDay() ? left : null);
  }

  function onInput() {
    const now = Date.now();
    /* 从闲置恢复：闲置期间不计时 */
    if (now - lastInput >= idleMs) lastTick = now;
    lastInput = now;
  }

  const opts = { passive: true, capture: true };
  const inputs = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  inputs.forEach((t) => window.addEventListener(t, onInput, opts));
  function onVis() {
    if (document.visibilityState === 'hidden') {
      tick();
      flush();
    } else {
      lastTick = Date.now();
      lastInput = Date.now();
    }
  }
  function onHide() {
    tick();
    flush();
  }
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);
  const timer = window.setInterval(tick, TICK_MS);

  return {
    flush,
    stop() {
      window.clearInterval(timer);
      inputs.forEach((t) => window.removeEventListener(t, onInput, opts));
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
    },
  };
}
