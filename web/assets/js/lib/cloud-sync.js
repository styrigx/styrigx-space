/**
 * @fileoverview 账号云同步（设置 › 账号 › 云同步）：登录账号后，设置项跨设备同步。
 *
 * - 同步哪些：data/features.yaml 里有 localStorage key 的设置（外观 / Good Lock / 时区天气 / 搜索引擎 / 文件），
 *   加自定义主题色 sgx-accent 和天气城市；不同步语言（跟随各设备系统）、布局（每台屏幕不同）、
 *   精确定位、锁屏 / 凭证类（本来就不在 localStorage）。
 * - 每项记一个本机修改时间（localStorage sgx-sync-meta），和云端（/api/prefs）逐项比，新的赢。
 * - 时机：主站每页加载拉一次（只限站长；没登录账号 401 → 记下来，之后不再请求，直到账号页重新登录）；
 *   本页改了设置（sgx-settings-changed）→ 记时间、1.5 秒防抖后推上去；离开页面前也比一次。
 * - 拉下来的值和本机不同 → 写进 localStorage、刷新 sgx-ui cookie 镜像，再刷新页面一次让外观生效
 *   （sessionStorage 防循环，一分钟内最多刷一次）。
 * - 开关：localStorage sgx-cloud-sync = '0' 关闭（默认开）；账号页「云同步」一行切换。
 */
import { defs } from './features.js';
import { get as sget, set as sset, getJSON, setJSON } from './storage.js';
import { syncUiCookie } from './ui-cookie.js';

export const PREFS_API = '/api/prefs';
export const SWITCH_KEY = 'sgx-cloud-sync';
export const META_KEY = 'sgx-sync-meta';
/** 上次成功同步的时刻（账号页副标题用） */
export const LAST_KEY = 'sgx-sync-last';
/** 账号会话状态：'out' = 服务端说没登录账号（停止请求）；其他 = 正常 */
export const AUTH_KEY = 'sgx-sync-auth';
const RELOAD_FLAG = 'sgx-sync-reloaded';

/** 不同步的 key（设备相关） */
const EXCLUDE = new Set(['sgx-lang', 'sgx-layout']);
/** features.yaml 之外也要同步的 key */
const EXTRA = ['sgx-accent', 'sgx-weather-loc', 'sgx-weather-city'];

/** @returns {string[]} 要同步的 localStorage key */
export function syncKeys() {
  const out = [];
  for (const d of defs()) {
    if (d && d.key && /^sgx-/.test(d.key) && !EXCLUDE.has(d.key) && out.indexOf(d.key) === -1) out.push(d.key);
  }
  for (const k of EXTRA) if (out.indexOf(k) === -1) out.push(k);
  return out;
}

/** @returns {boolean} 云同步开关（默认开） */
export function syncEnabled() {
  return sget(SWITCH_KEY) !== '0';
}

/**
 * 合并：本机 vs 云端，逐项新的赢。
 * @param {string[]} keys
 * @param {Record<string,string|null>} local 当前本机值（null = 没设，即默认值）
 * @param {Record<string,number>} meta 本机每项修改时间（没有 = 0，从没在本机改过）
 * @param {Record<string,{v:string|null,t:number}>} remote
 * @param {number} now
 * @returns {{apply: Record<string,string|null>, push: Record<string,{v:string|null,t:number}>, meta: Record<string,number>}}
 */
export function plan(keys, local, meta, remote, now) {
  /** @type {Record<string,string|null>} */
  const apply = {};
  /** @type {Record<string,{v:string|null,t:number}>} */
  const push = {};
  const m = Object.assign({}, meta);
  for (const k of keys) {
    const lv = local[k] === undefined ? null : local[k];
    const lt = m[k] || 0;
    const r = remote && remote[k];
    if (r && r.t > lt) {
      if (r.v !== lv) apply[k] = r.v;
      m[k] = r.t;
    } else if (r && lt > r.t) {
      if (r.v !== lv) push[k] = { v: lv, t: lt };
    } else if (!r && lv !== null) {
      /* 云端没有、本机设过（第一次开同步的设备）：用本机时间，没有就现在 */
      const t = lt || now;
      push[k] = { v: lv, t: t };
      m[k] = t;
    }
  }
  return { apply: apply, push: push, meta: m };
}

/** @param {string[]} keys @returns {Record<string,string|null>} */
function snapshot(keys) {
  /** @type {Record<string,string|null>} */
  const o = {};
  for (const k of keys) o[k] = sget(k);
  return o;
}

/** @param {string} method @param {any} [body] */
function call(method, body) {
  return fetch(PREFS_API, {
    method: method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) { return { s: r.status, j: j }; });
  });
}

let started = false;

/**
 * 主站每页调用一次（shell/core.js）。站长 + 开关开 + 没被标「没登录账号」才动。
 * @param {{force?: boolean}} [opts] force：账号页刚登录 / 打开开关时，忽略 'out' 标记
 * @returns {Promise<string>} 'off' | 'skip' | 'out' | 'ok' | 'error'
 */
export function initCloudSync(opts) {
  const force = !!(opts && opts.force);
  if (document.documentElement.getAttribute('data-sgx-role') !== 'owner') return Promise.resolve('skip');
  if (!syncEnabled()) return Promise.resolve('off');
  if (!force && sget(AUTH_KEY) === 'out') return Promise.resolve('out');
  const keys = syncKeys();
  let last = snapshot(keys);
  /** @type {Record<string,number>} */
  let meta = getJSON(META_KEY, {}) || {};
  /** @type {Record<string,{v:string|null,t:number}>} */
  let pending = {};
  let timer = 0;

  function flush() {
    window.clearTimeout(timer);
    timer = 0;
    const changes = pending;
    pending = {};
    if (!Object.keys(changes).length || !syncEnabled()) return;
    call('POST', { changes: changes }).then(function (res) {
      if (res.s === 401) { sset(AUTH_KEY, 'out'); return; }
      if (res.j && res.j.ok) sset(LAST_KEY, String(Date.now()));
    }, function () {
      /* 网络失败：放回去，下次改动或离开页面时再推 */
      pending = Object.assign(changes, pending);
    });
  }

  /** 本页改了设置：比快照，改了的记时间排队推 */
  function diff() {
    const now = Date.now();
    const cur = snapshot(keys);
    let any = false;
    for (const k of keys) {
      if (cur[k] !== last[k]) {
        meta[k] = now;
        pending[k] = { v: cur[k], t: now };
        any = true;
      }
    }
    last = cur;
    if (!any) return;
    setJSON(META_KEY, meta);
    if (!timer) timer = window.setTimeout(flush, 1500);
  }

  if (!started) {
    started = true;
    window.addEventListener('sgx-settings-changed', diff);
    window.addEventListener('pagehide', function () { diff(); flush(); });
  }

  return call('GET').then(function (res) {
    if (res.s === 401) {
      sset(AUTH_KEY, 'out');
      return 'out';
    }
    if (!(res.j && res.j.ok)) return 'error';
    sset(AUTH_KEY, 'in');
    const p = plan(keys, last, meta, res.j.items || {}, Date.now());
    meta = p.meta;
    setJSON(META_KEY, meta);
    const applyKeys = Object.keys(p.apply);
    for (const k of applyKeys) sset(k, p.apply[k]);
    if (Object.keys(p.push).length) {
      pending = Object.assign(p.push, pending);
      flush();
    } else {
      sset(LAST_KEY, String(Date.now()));
    }
    if (applyKeys.length) {
      last = snapshot(keys);
      try { syncUiCookie(); } catch (e) {}
      let recently = 0;
      try { recently = parseInt(sessionStorage.getItem(RELOAD_FLAG) || '0', 10) || 0; } catch (e) {}
      if (Date.now() - recently > 60000) {
        try { sessionStorage.setItem(RELOAD_FLAG, String(Date.now())); } catch (e) {}
        window.location.reload();
      }
    }
    return 'ok';
  }, function () {
    return 'error';
  });
}
