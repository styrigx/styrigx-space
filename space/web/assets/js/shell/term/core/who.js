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
 */

/** @typedef {'nobody'|'link'|'styrigx'|'root'} Who */

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
/** nobody@space:~/blog$ · nobody@space:~# · styrigx@space:~# · root@account:~# @param {Who} w @param {string} cwd */
export function ps1(w, cwd) {
  return (PS_USER[w] || PS_USER.nobody) + ':' + cwdPath(cwd) + (w === 'nobody' ? '$' : '#');
}
/** 标题栏：styrigx@space: ~ @param {Who} w @param {string} cwd */
export function title(w, cwd) {
  return (PS_USER[w] || PS_USER.nobody) + ': ' + cwdPath(cwd);
}

/**
 * 服务端的两个回答 → 身份（唯一的合成规则）。
 * @param {{ ok: boolean, by?: string }|null} lock /api/lock-session-check（null = 没问到 = 没进站）
 * @param {boolean} account 账号会话在（GET /api/account 有 session）
 * @returns {Who}
 */
export function whoOf(lock, account) {
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
  return !c.audience || c.audience.indexOf(w) !== -1;
}

/**
 * 身份状态：首帧用网关注入的页面标记（<html data-sgx-lock-session="valid|locked">，服务端写的）+ 账号登录标记猜一个画提示符，
 * refresh() 问服务端后以回答为准；回答变了通知订阅者（提示符重画）。
 * @param {{ check: () => Promise<{ ok: boolean, by?: string }|null>, page?: () => string, accountHint?: () => boolean }} o
 */
export function createWho(o) {
  /** @type {{ ok: boolean, by?: string }|null} */
  let lock = null;
  let account = !!(o.accountHint && o.accountHint());
  const pg = o.page ? o.page() : 'unknown';
  if (pg === 'valid') lock = { ok: true, by: '' };
  /** @type {Array<(w: Who) => void>} */
  const subs = [];
  let cur = whoOf(lock, account);
  function emit() {
    const w = whoOf(lock, account);
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
      pending = o.check().then(function (r) {
        lock = r && r.ok ? r : null;
        if (!lock) account = false;
        emit();
        pending = null;
        return cur;
      }, function () { pending = null; return cur; });
      return pending;
    },
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
