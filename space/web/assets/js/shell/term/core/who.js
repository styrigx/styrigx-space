/**
 * @fileoverview 终端身份（v5 S5 终端合一起一个终端、一个会话；提示符只看这里，唯一判断点）。
 *
 * v6 P4（定稿 v5.2 §二「主机固定 space，提示符 <用户>@space:<路径>；未登录提示符保持现状」、§十三 P4 删旧会话）起只有 v6 身份，
 * 由服务端 POST /api/identity whoami 决定（前端不猜）：
 * - 'nobody'：访客（没有 v6 会话）           → nobody@space:~$
 * - 'u:<名>'：普通用户                       → <名>@space:<路径>$（styrigx@space:~$）
 * - 'u:root'：root（su root 或救援）          → root@space:<路径>#
 * 旧的四种身份（link / styrigx / root@account）与旧进站会话一起删了。
 * 纯函数（prompt / listed 规则）+ 一个小状态对象（服务端回答的缓存，refresh() 重新问）。
 */

/** @typedef {string} Who 'nobody' | 'u:<名>'（v6 普通用户）| 'u:root'（v6 root） */

/** v6 身份的前缀 */
export const V6_PREFIX = 'u:';
/** 这个身份是不是 v6 会话（= 已登录） @param {Who} w */
export function isV6(w) {
  return typeof w === 'string' && w.indexOf(V6_PREFIX) === 0;
}
/** v6 身份的用户名（不是 v6 → ''） @param {Who} w */
export function v6Name(w) {
  return isV6(w) ? w.slice(V6_PREFIX.length) : '';
}
/** v6 身份里是不是 root @param {Who} w */
export function v6Root(w) {
  return v6Name(w) === 'root';
}
/**
 * man 索引 / 命令 audience 用的类别：访客 = 'nobody'，v6 普通用户（uid 1001 起）= 'user'，站长 styrigx = 'owner'，v6 root = 'root6'。
 * 站长按 whoami 的 owner 标记（服务端 view：uid 1000）；没有服务端回答时按用户名 styrigx（保留名）。
 * @param {Who} w @param {any} [u] whoami 的 user（可省）
 * @returns {string}
 */
export function kindOf(w, u) {
  if (!isV6(w)) return 'nobody';
  if (v6Root(w)) return 'root6';
  if (u && typeof u === 'object' && u.name === v6Name(w)) return u.owner === true ? 'owner' : 'user';
  return v6Name(w) === 'styrigx' ? 'owner' : 'user';
}

/**
 * 权限层级（定稿 v5.5 §四「权限层级 = man 索引顺序：root → 站长 styrigx → 普通用户 → 访客，自上而下递减」）：数字越大层越高。
 * man 索引按这四层分段（高的在前），各人只看到自己这一层及以下的命令，root 看全部（Gray 2026-11-11 19:59）。
 */
export const TIERS = Object.freeze(['nobody', 'user', 'owner', 'root6']);
/** @param {string} k */
export function tierRank(k) {
  return TIERS.indexOf(k);
}
/**
 * 一条命令属于哪一层：audience 里最低的那一层（缺省 = 访客层）。audience 空数组 = 不进索引（rescue）。
 * @param {{ audience?: string[] }} c @returns {number} -1 = 不进索引
 */
export function tierOf(c) {
  if (!c.audience) return 0;
  let t = -1;
  c.audience.forEach(function (k) { const r = tierRank(k); if (r !== -1 && (t === -1 || r < t)) t = r; });
  return t;
}

/** 访客的提示符（定稿 §二：未登录提示符保持现状） */
export const PS_GUEST = 'nobody@space';

/** 提示符里的路径 @param {string} cwd */
export function cwdPath(cwd) {
  return !cwd || cwd === '~' ? '~' : '~/' + cwd;
}
/** 用户@主机（v6：<名>@space） @param {Who} w */
function userHost(w) {
  return isV6(w) ? v6Name(w) + '@space' : PS_GUEST;
}
/**
 * nobody@space:~/blog$ · styrigx@space:~$ · root@space:~#
 * @param {Who} w @param {string} cwd
 */
export function ps1(w, cwd) {
  return userHost(w) + ':' + cwdPath(cwd) + (v6Root(w) ? '#' : '$');
}
/** 标题栏：styrigx@space: ~ @param {Who} w @param {string} cwd */
export function title(w, cwd) {
  return userHost(w) + ': ' + cwdPath(cwd);
}

/**
 * 服务端的回答 → 身份（唯一的合成规则）。
 * @param {{name:string, root:boolean}|null} [v6] whoami 的 user（null = 访客）
 * @returns {Who}
 */
export function whoOf(v6) {
  if (v6 && typeof v6.name === 'string' && v6.name) return V6_PREFIX + (v6.root ? 'root' : v6.name);
  return 'nobody';
}

/**
 * 一条命令在这个身份下列不列（man 索引 / 补全；唯一判断点）。定稿 v5.5 §四：各人只看到自己这一层及以下的命令，root 看全部。
 * - 命令的层 = tierOf（audience 里最低的那一层；缺省访客层；空数组不进索引）
 * - group：只给这个组的成员列（ask = ai 组，定稿 v5.5 §四「ai 组成员的 man 都列出 ask」；sudo = sudoers）；root 不看组
 * 只管列不列，不管能不能跑（能不能跑由命令自己 / 服务端回答）。
 * @param {{ audience?: string[], group?: string }} c @param {Who} w @param {any} [u] whoami 的 user（组、owner 标记；可省）
 */
export function listedFor(c, w, u) {
  const t = tierOf(c);
  if (t === -1) return false;
  const k = kindOf(w, u);
  if (k === 'root6') return true;
  if (tierRank(k) < t) return false;
  if (c.group) return !!u && Array.isArray(u.groups) && u.groups.indexOf(c.group) !== -1;
  return true;
}

/**
 * 页面标记（<html data-sgx-lock-session>）该是什么（同网关 gate.js pageStateOf 的规则）：有一个非救援的 v6 身份 → valid；否则 locked。
 * 救援会话只做白名单命令，页面不算登录（网关的 user 档拒救援）。
 * @param {any} v6 whoami 的 user（null = 没有）
 * @returns {'valid'|'locked'}
 */
export function pageStateFor(v6) {
  return !!v6 && typeof v6.name === 'string' && !!v6.name && v6.rescue !== true ? 'valid' : 'locked';
}

/**
 * 身份状态：首帧有 v6 登录标记（o.v6Hint，cookie sgx-id）就问一次 whoami（POST /api/identity），以回答为准；回答变了通知订阅者（提示符重画）。
 * @param {{ whoami?: () => Promise<any>, v6Hint?: () => boolean }} o
 */
export function createWho(o) {
  /** v6 会话的身份（whoami 的 user；null = 访客） @type {any} */
  let v6 = null;
  /** @type {Array<(w: Who) => void>} */
  const subs = [];
  /** v6 命令（su / exit / lock / idle）改了身份之后的订阅者：拿到页面标记该是什么（pageStateFor） @type {Array<(s: 'valid'|'locked') => void>} */
  const v6Subs = [];
  let cur = whoOf(v6);
  function emit() {
    const w = whoOf(v6);
    if (w === cur) return;
    cur = w;
    subs.forEach(function (f) { try { f(w); } catch (e) {} });
  }
  /** @type {Promise<Who>|null} */
  let pending = null;
  return {
    /** @returns {Who} */
    get: function () { return cur; },
    /** 问服务端（同一时刻只问一次）。没问到（网络错）不动 @returns {Promise<Who>} */
    refresh: function () {
      if (pending) return pending;
      if (!o.whoami) return Promise.resolve(cur);
      pending = o.whoami().then(function (u) {
        if (u !== undefined) v6 = u && u.name ? u : null;
        emit();
        pending = null;
        return cur;
      }, function () { pending = null; return cur; });
      return pending;
    },
    /** v6 会话的身份（whoami 的 user；null = 没有） */
    v6: function () { return v6; },
    /** v6 命令（su / exit / lock / idle）回来的 user（null = 回到访客） @param {any} u */
    setV6: function (u) {
      v6 = u && u.name ? u : null;
      emit();
      /* 2c：su / exit / lock 之后页面标记就地切（宿主 topbar-panel 订阅）；只在 v6 命令之后，不在 refresh 里（网络错不误锁） */
      const st = pageStateFor(v6);
      v6Subs.forEach(function (f) { try { f(st); } catch (e) {} });
    },
    /** 订阅 v6 命令之后的页面标记 @param {(s: 'valid'|'locked') => void} f */
    onV6: function (f) { v6Subs.push(f); },
    /** 首帧有 v6 登录标记：要问一次 whoami */
    v6Hinted: function () { return !!(o.v6Hint && o.v6Hint()); },
    /** 服务端说没登录（接口 401 / 页面要人 su）：回访客 */
    drop: function () { v6 = null; emit(); },
    /** @param {(w: Who) => void} f */
    on: function (f) { subs.push(f); },
  };
}
