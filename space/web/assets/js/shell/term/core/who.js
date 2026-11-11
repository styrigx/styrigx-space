/**
 * @fileoverview 终端身份（v5 S5 终端合一，term-design-v5「提示符」）：一个终端、一个会话，提示符只看这里（唯一判断点）。
 *
 * 四种身份（钥匙层由服务端 GET /api/lock-session-check 的 ok / by 决定，账号层由 GET /api/account 的 session 决定；前端不猜）：
 * - nobody：没进站（访客）                         → nobody@space:~$
 * - link：分享链接进来的进站会话（by=link）         → nobody@space:~#
 * - styrigx：解锁密码 / 通行密钥进站               → styrigx@space:~#
 * - root：进站后 sudo root 登录了账号              → root@account:~#
 * reset 层（sudo styrigx reset / sudo root reset）有自己的提示符，由宿主在 reset 里换（reset@space:~# / reset@account:~#）。
 * 纯函数（prompt / listed 规则）+ 一个小状态对象（服务端回答的缓存，refresh() 重新问）。
 *
 * v6（P2b，定稿 v4 §二 / §七）：有 v6 新会话（POST /api/identity whoami 回了 user）时以它为准，先于上面四种：
 * - 'u:<名>'：普通用户 → <名>@space:<路径>$（styrigx@space:~$）
 * - 'u:root'：root（su root 或救援）→ root@space:<路径>#
 * 没有 v6 会话时四种旧身份原样（分步割接：旧入口不动）。
 */

/** @typedef {string} Who 'nobody' | 'link' | 'styrigx' | 'root' | 'u:<名>'（v6 普通用户）| 'u:root'（v6 root） */

/** v6 身份的前缀 */
export const V6_PREFIX = 'u:';
/** 这个身份是不是 v6 新会话 @param {Who} w */
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
 * man 索引 / 命令 audience 用的类别：v6 普通用户 = 'user'，v6 root = 'root6'，其余原样。
 * @param {Who} w @returns {string}
 */
export function kindOf(w) {
  if (!isV6(w)) return w;
  return v6Root(w) ? 'root6' : 'user';
}

/** 身份 → 提示符的用户@主机 */
export const PS_USER = Object.freeze({ nobody: 'nobody@space', link: 'nobody@space', styrigx: 'styrigx@space', root: 'root@account' });

/** reset 层的提示符（钥匙 sudo styrigx reset / 账号 sudo root reset；层不变） */
export const PS_RESET = Object.freeze({ space: 'reset@space:~#', account: 'reset@account:~#' });

/** 提示符里的路径 @param {string} cwd */
export function cwdPath(cwd) {
  return !cwd || cwd === '~' ? '~' : '~/' + cwd;
}
/** 已进站（钥匙层）：link / styrigx / root @param {Who} w */
export function entered(w) {
  return w === 'link' || w === 'styrigx' || w === 'root';
}
/** 用户@主机（v6：<名>@space） @param {Who} w */
function userHost(w) {
  if (isV6(w)) return v6Name(w) + '@space';
  return PS_USER[/** @type {'nobody'} */ (w)] || PS_USER.nobody;
}
/**
 * nobody@space:~/blog$ · nobody@space:~# · styrigx@space:~# · root@account:~#；v6：styrigx@space:~$ · root@space:~#
 * @param {Who} w @param {string} cwd
 */
export function ps1(w, cwd) {
  const mark = isV6(w) ? (v6Root(w) ? '#' : '$') : (w === 'nobody' ? '$' : '#');
  return userHost(w) + ':' + cwdPath(cwd) + mark;
}
/** 标题栏：styrigx@space: ~ @param {Who} w @param {string} cwd */
export function title(w, cwd) {
  return userHost(w) + ': ' + cwdPath(cwd);
}

/**
 * 服务端的两个回答 → 身份（唯一的合成规则）。
 * @param {{ ok: boolean, by?: string }|null} lock /api/lock-session-check（null = 没问到 = 没进站）
 * @param {boolean} account 账号会话在（GET /api/account 有 session）
 * @param {{name:string, root:boolean}|null} [v6] v6 新会话（whoami 的 user；有就以它为准）
 * @returns {Who}
 */
export function whoOf(lock, account, v6) {
  if (v6 && typeof v6.name === 'string' && v6.name) return V6_PREFIX + (v6.root ? 'root' : v6.name);
  if (!lock || !lock.ok) return 'nobody';
  if (account) return 'root';
  return lock.by === 'link' ? 'link' : 'styrigx';
}

/**
 * 一条命令在这个身份下列不列（man 索引；唯一判断点）。命令的 audience：缺省所有人；数组 = 只给这些身份列。
 * 只管列不列，不管能不能跑（能不能跑由命令自己 / 服务端回答）。
 * @param {{ audience?: Who[] }} c @param {Who} w
 */
export function listedFor(c, w) {
  return !c.audience || c.audience.indexOf(kindOf(w)) !== -1;
}

/**
 * 页面标记（<html data-sgx-lock-session>）该是什么（2c：v6 命令之后就地切换用；同网关 gate.js pageStateOf 的规则）：
 * 旧进站会话在，或有一个非救援的 v6 身份 → valid；否则 locked。救援会话只做白名单命令，页面不算登录（网关的 user 档拒救援）。
 * @param {boolean} lockOk 旧进站会话在（lock-session-check 回了 ok） @param {any} v6 whoami 的 user（null = 没有）
 * @returns {'valid'|'locked'}
 */
export function pageStateFor(lockOk, v6) {
  return lockOk || (!!v6 && typeof v6.name === 'string' && !!v6.name && v6.rescue !== true) ? 'valid' : 'locked';
}

/**
 * 身份状态：首帧用网关注入的页面标记（<html data-sgx-lock-session="valid|locked">，服务端写的）+ 账号登录标记猜一个画提示符，
 * refresh() 问服务端后以回答为准；回答变了通知订阅者（提示符重画）。
 * v6（P2b）：o.whoami 给了就一起问（POST /api/identity whoami），回了 user 就以它为准；o.v6Hint（登录标记 cookie sgx-id）首帧先猜在。
 * @param {{ check: () => Promise<{ ok: boolean, by?: string }|null>, page?: () => string, accountHint?: () => boolean,
 *   whoami?: () => Promise<any>, v6Hint?: () => boolean }} o
 */
export function createWho(o) {
  /** @type {{ ok: boolean, by?: string }|null} */
  let lock = null;
  let account = !!(o.accountHint && o.accountHint());
  /** v6 新会话的身份（whoami 的 user；null = 没有） @type {any} */
  let v6 = null;
  const pg = o.page ? o.page() : 'unknown';
  /* 2b：页面 valid 也可能只因为 v6 新会话（网关 pageStateOf）。有 v6 登录标记时首帧不猜旧进站身份（styrigx#），
     等 refresh()：旧会话问 lock-session-check，v6 问 whoami，以回答为准 */
  if (pg === 'valid' && !(o.v6Hint && o.v6Hint())) lock = { ok: true, by: '' };
  /** @type {Array<(w: Who) => void>} */
  const subs = [];
  /** v6 命令（su / exit / lock / idle）改了身份之后的订阅者：拿到页面标记该是什么（pageStateFor） @type {Array<(s: 'valid'|'locked') => void>} */
  const v6Subs = [];
  let cur = whoOf(lock, account, v6);
  function emit() {
    const w = whoOf(lock, account, v6);
    if (w === cur) return;
    cur = w;
    subs.forEach(function (f) { try { f(w); } catch (e) {} });
  }
  /** @type {Promise<Who>|null} */
  let pending = null;
  return {
    /** @returns {Who} */
    get: function () { return cur; },
    /** 问服务端（同一时刻只问一次） @returns {Promise<Who>} */
    refresh: function () {
      if (pending) return pending;
      const ask6 = o.whoami ? o.whoami().then(function (u) { return u; }, function () { return undefined; }) : Promise.resolve(undefined);
      pending = Promise.all([o.check(), ask6]).then(function (rr) {
        const r = rr[0];
        lock = r && r.ok ? r : null;
        if (!lock) account = false;
        if (rr[1] !== undefined) v6 = rr[1] && rr[1].name ? rr[1] : null;
        emit();
        pending = null;
        return cur;
      }, function () { pending = null; return cur; });
      return pending;
    },
    /** v6 新会话的身份（whoami 的 user；null = 没有） */
    v6: function () { return v6; },
    /** v6 命令（su / exit / lock / idle）回来的 user（null = 回到访客 / 旧身份） @param {any} u */
    setV6: function (u) {
      v6 = u && u.name ? u : null;
      emit();
      /* 2c：su / exit / lock 之后页面标记就地切（宿主 topbar-panel 订阅）；只在 v6 命令之后，不在 refresh 里（网络错不误锁） */
      const st = pageStateFor(!!(lock && lock.ok), v6);
      v6Subs.forEach(function (f) { try { f(st); } catch (e) {} });
    },
    /** 订阅 v6 命令之后的页面标记 @param {(s: 'valid'|'locked') => void} f */
    onV6: function (f) { v6Subs.push(f); },
    /** 首帧有 v6 登录标记：要问一次 whoami */
    v6Hinted: function () { return !!(o.v6Hint && o.v6Hint()); },
    /** 账号层的回答（GET /api/account 之后）。账号接口在钥匙之后（没进站回 401 lock），回了会话就说明钥匙层也在 @param {boolean} on */
    setAccount: function (on) {
      account = !!on;
      if (account && !lock) lock = { ok: true, by: '' };
      emit();
    },
    /** 钥匙层被服务端拒了（401 session）：没进站 */
    drop: function () { lock = null; account = false; emit(); },
    /** @param {(w: Who) => void} f */
    on: function (f) { subs.push(f); },
  };
}
