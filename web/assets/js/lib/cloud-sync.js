/**
 * @fileoverview 账号云同步（设置 › 账号 › 云同步）：登录账号后，设置项跨设备同步。
 *
 * - 同步哪些：data/features.yaml 里有 localStorage key 的设置（外观 / Good Lock / 时区天气 / 搜索引擎 / 文件），
 *   加自定义主题色 sgx-accent 和天气城市；不同步语言（跟随各设备系统）、布局（每台屏幕不同）、
 *   精确定位、锁屏 / 凭证类（本来就不在 localStorage）。
 * - 每项记一个本机修改时间（localStorage sgx-sync-meta），和云端（/api/prefs）逐项比，新的赢。
 * - 时机（2026-10-24 拉取节流）：只限站长；没登录账号 401 → 记下来，之后不再请求，直到账号页重新登录。
 *   - 普通拉取（每页加载 shell/core.js、页面回到前台）最多每 5 分钟一次：上次成功拉取 / 推送的时刻按账号记在
 *     localStorage sgx-sync-pull（{ <账号>: 毫秒 }），没过 5 分钟就不发 GET /api/prefs。
 *   - 强制拉取不受节流（force）：刚登录、打开总开关、进账号页 /account/ 和云同步页 /account/sync/。
 *   - 登出 / 401 清掉这个时刻（clearPullStamp），重新登录后第一次一定拉。
 *   本页改了设置（sgx-settings-changed）→ 记时间、1.5 秒防抖后推上去（不受节流）；推送成功也刷新上面的时刻；
 *   离开页面前也比一次。
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
/** 上次成功拉取（或推送）的时刻，按账号：{ <账号>: 毫秒 }。普通拉取的节流依据 */
export const PULL_KEY = 'sgx-sync-pull';
/** 普通拉取最短间隔 */
export const PULL_INTERVAL = 5 * 60 * 1000;
/** 推送防抖 */
export const PUSH_DEBOUNCE = 1500;
/** 强制拉取时，本页刚成功拉过（这么久以内）就复用那次结果，不重复请求（账号页 core.js + account.js 同时触发） */
const FORCE_REUSE_MS = 3000;

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

/**
 * 节流按哪个账号记。站点只有一个账号（站长账号，handle owner-user-id:owner），页面上也拿不到账号 id，
 * 所以目前就是 'owner'；登出 / 401 / 换账号登录都会清掉或强制刷新这个时刻。
 * @returns {string}
 */
function accountScope() {
  return 'owner';
}

/** @returns {number} 当前账号上次成功拉取 / 推送的时刻（没有 = 0） */
export function lastPullAt() {
  const m = getJSON(PULL_KEY, {}) || {};
  const t = Number(m[accountScope()]);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** @param {number} t */
function markPulled(t) {
  const m = getJSON(PULL_KEY, {}) || {};
  m[accountScope()] = t;
  setJSON(PULL_KEY, m);
}

/** 登出 / 401：清掉节流时刻（下次登录后第一次一定拉） */
export function clearPullStamp() {
  sset(PULL_KEY, null);
}

/**
 * 普通拉取要不要发：从没拉过、超过间隔、或本机时钟被往回拨（t 在未来）→ 要。
 * @param {number} last @param {number} now
 */
export function pullDue(last, now) {
  return !last || now - last >= PULL_INTERVAL || now < last;
}

/** 本页的同步状态（每页一份，第一次 initCloudSync 通过门槛时建立） */
/** @type {null|{keys:string[], last:Record<string,string|null>, meta:Record<string,number>, pending:Record<string,{v:string|null,t:number}>, timer:number}} */
let st = null;
/** @type {Promise<string>|null} 正在进行的拉取 */
let inflight = null;
/** 本页上次成功拉取的时刻 */
let okAt = 0;

function onAuthOut() {
  sset(AUTH_KEY, 'out');
  clearPullStamp();
}

function flush() {
  if (!st) return;
  const s = st;
  window.clearTimeout(s.timer);
  s.timer = 0;
  const changes = s.pending;
  s.pending = {};
  if (!Object.keys(changes).length || !syncEnabled()) return;
  call('POST', { changes: changes }).then(function (res) {
    if (res.s === 401) { onAuthOut(); return; }
    if (res.j && res.j.ok) {
      const now = Date.now();
      sset(LAST_KEY, String(now));
      /* 推上去时服务端已合并：算一次同步，紧接着的页面不必再拉 */
      markPulled(now);
    }
  }, function () {
    /* 网络失败：放回去，下次改动或离开页面时再推 */
    s.pending = Object.assign(changes, s.pending);
  });
}

/** 本页改了设置：比快照，改了的记时间排队推（1.5 秒防抖） */
function diff() {
  if (!st) return;
  const s = st;
  const now = Date.now();
  const cur = snapshot(s.keys);
  let any = false;
  for (const k of s.keys) {
    if (cur[k] !== s.last[k]) {
      s.meta[k] = now;
      s.pending[k] = { v: cur[k], t: now };
      any = true;
    }
  }
  s.last = cur;
  if (!any) return;
  setJSON(META_KEY, s.meta);
  if (!s.timer) s.timer = window.setTimeout(flush, PUSH_DEBOUNCE);
}

/** 页面回到前台（切回标签页 / 从后台恢复 / bfcache 恢复）：按节流补拉一次 */
function onForeground() {
  if (document.visibilityState && document.visibilityState !== 'visible') return;
  initCloudSync().catch(function () {});
}

function pull() {
  const s = /** @type {NonNullable<typeof st>} */ (st);
  /* 再拉一次前对齐本机：别的标签页可能改过设置 / 修改时间（这页自己的改动已在 pending 里） */
  s.last = snapshot(s.keys);
  const stored = getJSON(META_KEY, {}) || {};
  for (const k of Object.keys(stored)) if ((Number(stored[k]) || 0) > (s.meta[k] || 0)) s.meta[k] = Number(stored[k]);
  return call('GET').then(function (res) {
    if (res.s === 401) {
      onAuthOut();
      return 'out';
    }
    if (!(res.j && res.j.ok)) return 'error';
    sset(AUTH_KEY, 'in');
    const now = Date.now();
    okAt = now;
    markPulled(now);
    const p = plan(s.keys, s.last, s.meta, res.j.items || {}, now);
    s.meta = p.meta;
    setJSON(META_KEY, s.meta);
    const applyKeys = Object.keys(p.apply);
    for (const k of applyKeys) sset(k, p.apply[k]);
    if (Object.keys(p.push).length) {
      s.pending = Object.assign(p.push, s.pending);
      flush();
    } else {
      sset(LAST_KEY, String(now));
    }
    if (applyKeys.length) {
      s.last = snapshot(s.keys);
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

/**
 * 主站每页调用一次（shell/core.js），页面回到前台再调；账号页 / 云同步页 / 登录 / 打开开关时 force。
 * 站长 + 开关开 + 没被标「没登录账号」才动；普通调用 5 分钟内拉过就不拉（'fresh'）。
 * @param {{force?: boolean}} [opts] force：忽略节流和 'out' 标记（刚登录 / 打开开关 / 进账号页、云同步页）
 * @returns {Promise<string>} 'off' | 'skip' | 'out' | 'fresh' | 'ok' | 'error'
 */
export function initCloudSync(opts) {
  const force = !!(opts && opts.force);
  if (document.documentElement.getAttribute('data-sgx-role') !== 'owner') return Promise.resolve('skip');
  if (!syncEnabled()) return Promise.resolve('off');
  if (!force && sget(AUTH_KEY) === 'out') return Promise.resolve('out');

  if (!st) {
    const keys = syncKeys();
    st = { keys: keys, last: snapshot(keys), meta: getJSON(META_KEY, {}) || {}, pending: {}, timer: 0 };
    window.addEventListener('sgx-settings-changed', diff);
    window.addEventListener('pagehide', function () { diff(); flush(); });
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', function (e) {
      if (e && /** @type {PageTransitionEvent} */ (e).persisted) onForeground();
    });
  }

  /* 已有一次拉取在路上：一起等它（不管 force 与否，结果就是最新的） */
  if (inflight) return inflight;
  const now = Date.now();
  if (force) {
    if (okAt && now - okAt >= 0 && now - okAt < FORCE_REUSE_MS) return Promise.resolve('ok');
  } else if (!pullDue(lastPullAt(), now)) {
    return Promise.resolve('fresh');
  }
  const p = pull();
  inflight = p;
  const done = function () { if (inflight === p) inflight = null; };
  p.then(done, done);
  return p;
}

/** 只供测试：清掉本页同步状态（模块是单例，测试之间要重来） */
export function _resetForTest() {
  if (st) window.clearTimeout(st.timer);
  st = null;
  inflight = null;
  okAt = 0;
}
