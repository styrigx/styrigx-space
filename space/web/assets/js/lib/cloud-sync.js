/**
 * @fileoverview 账号云同步（设置 › 账号 › 云同步）：登录账号后，设置项跨设备同步。
 *
 * - 同步哪些：data/features.yaml 里有 localStorage key 的设置（外观 / Good Lock / 时区天气 / 搜索引擎 / 文件），
 *   加自定义主题色 sgx-accent 和账号页选的 AI 模型 sgx-ai-model（P4-2d）；不同步语言（跟随各设备系统）、布局（每台屏幕不同）、
 *   精确定位、锁屏 / 凭证类（本来就不在 localStorage）。
 * - 每项记一个本机修改时间（localStorage sgx-sync-meta），和云端（/api/prefs）逐项比，新的赢。
 * - 时机（2026-10-24 拉取节流）：只在锁屏已解锁的页面（<html data-sgx-lock-session="valid">）请求；不看锁屏进门方式，
 *   2b 起纯 v6 登录（su styrigx / su root）的页面网关也标 valid，数据按 v6 会话的 uid 归属（服务端 dataUid）；
 *   能不能同步直接按 /api/prefs 的结果：401 account（没登录账号）→ 记下来，之后不再请求，直到账号页重新登录；
 *   其他 401 / 403（锁屏会话过期、没有 prefs.sync 作用域）→ 这次不同步，不记 out。
 *   403 scope（P3-1：在 账号 › 应用授权 取消了「设置同步」）→ 另记一个本页内的标记（scopeDenied()），设置照常只存本机；
 *   账号页「云同步」一行和云同步页显示「设置同步未获账号授权，只存本机」。下一次拉取成功就清掉。
 *   - 普通拉取（每页加载 shell/core.js、页面回到前台）最多每 5 分钟一次：上次成功拉取 / 推送的时刻按账号记在
 *     localStorage sgx-sync-pull（{ <账号>: 毫秒 }），没过 5 分钟就不发 GET /api/prefs。
 *   - 强制拉取不受节流（force）：刚登录、进账号页 /account/（云同步子页和总开关 2026-11-08 删除，只留后台自动同步）。
 *   - 登出 / 401 清掉这个时刻（clearPullStamp），重新登录后第一次一定拉。
 *   本页改了设置（sgx-settings-changed）→ 记时间、1.5 秒防抖后推上去（不受节流）；推送成功也刷新上面的时刻；
 *   离开页面前也比一次。
 * - 拉下来的值和本机不同 → 写进 localStorage、刷新 sgx-ui cookie 镜像，就地生效（2026-10-28 起不再刷新页面）：
 *   features.js notifyExternal 通知订阅者（主题 / 色板 / 时钟 / 快捷面板等，和跨标签页同步同一条路），
 *   自定义主题色 sgx-accent 另外重算角色（applyAccent，按需加载）或清掉（clearAccent）。
 *   先更新本页快照再通知，所以随之而来的 sgx-settings-changed 不会被 diff() 当成本机改动又推回去。
 * - 开关：localStorage sgx-cloud-sync = '0' 关闭（默认开）；账号页「云同步」一行切换。
 */
import { defs, notifyExternal } from './features.js';
import { ACCENT_KEY, clearAccent } from './accent.js';
import { get as sget, set as sset, getJSON, setJSON } from './storage.js';
import { syncUiCookie } from './ui-cookie.js';

export const PREFS_API = '/api/prefs';
export const SWITCH_KEY = 'sgx-cloud-sync';
export const META_KEY = 'sgx-sync-meta';
/** 上次成功同步的时刻（账号页副标题用） */
export const LAST_KEY = 'sgx-sync-last';
/** 账号会话状态：'out' = 服务端说没登录账号（停止请求）；其他 = 正常 */
export const AUTH_KEY = 'sgx-sync-auth';
/** 以前「同步后刷新一次」的防循环标记（2026-10-28 起不再刷新）；开机顺手清掉旧值 */
const OLD_RELOAD_FLAG = 'sgx-sync-reloaded';
/** 上次成功拉取（或推送）的时刻，按账号：{ <账号>: 毫秒 }。普通拉取的节流依据 */
export const PULL_KEY = 'sgx-sync-pull';
/** 本页最近一次拉取是不是 403 scope（没有 prefs.sync：只存本机）。只在内存里，不进 localStorage（sgx- 键会被同步） */
let noScope = false;
/** 设置同步是不是被取消了授权（本页最近一次拉取回 403 scope） */
export function scopeDenied() {
  return noScope;
}
/** 普通拉取最短间隔 */
export const PULL_INTERVAL = 5 * 60 * 1000;
/** 推送防抖 */
export const PUSH_DEBOUNCE = 1500;
/** 强制拉取时，本页刚成功拉过（这么久以内）就复用那次结果，不重复请求（账号页 core.js + account.js 同时触发） */
const FORCE_REUSE_MS = 3000;

/** 不同步的 key（设备相关） */
const EXCLUDE = new Set(['sgx-lang', 'sgx-layout']);
/** features.yaml 之外也要同步的 key */
/* P4-2c：sgx-weather-loc / sgx-weather-city 随天气删除。
   P4-2d：sgx-ai-model（账号页选的 AI 模型 id，shell/ai-panel.js MODEL_KEY）；AI 窗口的对话历史仍只存本地、不同步 */
const EXTRA = ['sgx-accent', 'sgx-ai-model'];

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
 * 有没有 v6 登录标记（2b：服务端随 sgx-session 写的 sgx-id=1；非 HttpOnly、不含秘密，只用来决定行为，身份 / uid 仍只由服务端会话定）。
 * @returns {boolean}
 */
export function v6Marked() {
  try { return /(?:^|;\s*)sgx-id=1(?:;|$)/.test(document.cookie || ''); } catch (e) { return false; }
}

/**
 * 节流按哪个账号记。页面上拿不到 uid（数据归谁由服务端会话定：v6 新会话 → 会话里的 uid，否则旧会话 → styrigx）；
 * 旧会话记在 'account'，有 v6 登录标记记在 'v6'，两种身份的节流时刻互不影响。登出 / 401 / 换账号登录都会清掉或强制刷新这个时刻。
 * @returns {string}
 */
function accountScope() {
  return v6Marked() ? 'v6' : 'account';
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

/** 服务端说「没登录账号」吗（401 account；P2-2 起 /api/prefs 的唯一一种 out） @param {{s:number, j:any}} res */
function saysAccountOut(res) {
  return res.s === 401 && !!res.j && res.j.error === 'account';
}

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
    if (saysAccountOut(res)) { onAuthOut(); return; }
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
  /* 2c：v6 exit / lock 就地切回访客（页面标记 locked）后本机改的设置不排队推（没有会话，推了也是 401） */
  if (document.documentElement.getAttribute('data-sgx-lock-session') !== 'valid') { s.last = cur; return; }
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

/**
 * 拉下来的值就地生效（不刷新页面）。
 * @param {string[]} keys 改了的 key
 * @param {Record<string,string|null>} values
 */
function applyLive(keys, values) {
  if (keys.indexOf(ACCENT_KEY) !== -1) {
    const seed = values[ACCENT_KEY];
    if (seed) {
      import('./accent-roles.js').then(function (m) { m.applyAccent(seed); }).catch(function () {});
    } else {
      try { clearAccent(); } catch (e) {}
    }
  }
  try { notifyExternal(keys); } catch (e) {}
}

function pull() {
  const s = /** @type {NonNullable<typeof st>} */ (st);
  /* 再拉一次前对齐本机：别的标签页可能改过设置 / 修改时间（这页自己的改动已在 pending 里） */
  s.last = snapshot(s.keys);
  const stored = getJSON(META_KEY, {}) || {};
  for (const k of Object.keys(stored)) if ((Number(stored[k]) || 0) > (s.meta[k] || 0)) s.meta[k] = Number(stored[k]);
  return call('GET').then(function (res) {
    if (saysAccountOut(res)) {
      onAuthOut();
      return 'out';
    }
    /* 别的 401 / 403（锁屏过期、没作用域）：这次不同步，也不标 out（之后有了作用域照常拉） */
    if (res.s === 403 && res.j && res.j.error === 'scope') {
      noScope = true;
      return 'skip';
    }
    if (res.s === 401 || res.s === 403) return 'skip';
    noScope = false;
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
      /* 先对齐快照：下面的通知会派发 sgx-settings-changed，diff() 看到的就是已同步的值，不回推 */
      s.last = snapshot(s.keys);
      try { syncUiCookie(); } catch (e) {}
      applyLive(applyKeys, p.apply);
    }
    return 'ok';
  }, function () {
    return 'error';
  });
}

let sessionBound = false;
/**
 * 2c：页面标记就地切了（v6 su / exit / lock 之后顶栏发 window 'sgx:session'，detail { ok, live: true }；守卫首帧那次没有 live，不管）。
 * - 切成 valid（刚 su 登录）→ 立即强制拉一次（忽略节流、旧 out 标记和 FORCE_REUSE_MS：可能刚换了身份）
 * - 切成 locked（exit / lock 回访客）→ 丢掉还没推的改动（属于刚退出的身份；没有会话推了也是 401）
 * shell/core.js 调一次（幂等）。
 */
export function bindSessionSync() {
  if (sessionBound) return;
  sessionBound = true;
  window.addEventListener('sgx:session', function (/** @type {any} */ e) {
    const d = e && e.detail;
    if (!d || !d.live) return;
    if (d.ok) {
      okAt = 0;
      initCloudSync({ force: true }).catch(function () {});
      return;
    }
    if (st) { window.clearTimeout(st.timer); st.timer = 0; st.pending = {}; }
  });
}

/**
 * 主站每页调用一次（shell/core.js），页面回到前台再调；账号页 / 云同步页 / 登录 / 打开开关时 force。
 * 锁屏已解锁 + 开关开 + 没被标「没登录账号」才动（不看锁屏进门方式，按 /api/prefs 的结果）；普通调用 5 分钟内拉过就不拉（'fresh'）。
 * @param {{force?: boolean}} [opts] force：忽略节流和 'out' 标记（刚登录 / 打开开关 / 进账号页、云同步页）
 * @returns {Promise<string>} 'off' | 'skip' | 'out' | 'fresh' | 'ok' | 'error'
 */
export function initCloudSync(opts) {
  const force = !!(opts && opts.force);
  if (document.documentElement.getAttribute('data-sgx-lock-session') !== 'valid') return Promise.resolve('skip');
  if (!syncEnabled()) return Promise.resolve('off');
  /* 'out' 是旧账号会话的结论（401 account）；有 v6 登录标记时服务端按 v6 会话判，不受它挡（2b） */
  if (!force && sget(AUTH_KEY) === 'out' && !v6Marked()) return Promise.resolve('out');

  if (!st) {
    try { sessionStorage.removeItem(OLD_RELOAD_FLAG); } catch (e) {}
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
  sessionBound = false;
}
