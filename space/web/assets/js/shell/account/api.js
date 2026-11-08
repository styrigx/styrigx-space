/**
 * @fileoverview 账号终端调后端的唯一地方（2026-11-08 账号 UI 改版）。
 *
 * 面板代码只用这里导出的对象（按入口分：session / reauth / reset / keys / devices / grants，写法照 acct-naming NAMING-V2 §2.8），
 * 不直接写 action 名、请求字段、状态字段、密码管理器隐藏用户名。
 * 现在调的还是旧接口（POST /api/account { action }，GET 的 ready / password / passkey），等账号 Worker 按入口拆开（NAMING-V2 P2）时只改这个文件：
 * - 下面每个 `action:` 字符串、请求字段（password / key / signOut / credId / deviceId / app / name / reauth / device）
 * - status() 里把旧 GET 字段（ready、password、passkey）归一成 { signing, configured: { password, passkey } }
 * - PM_USER 里的密码管理器隐藏用户名（现在是 key-names.js 的 KEY_ACCOUNT / KEY_ROOT）
 * - 错误码（ERR）
 *
 * 每个调用都回 Promise<{ s: number, j: any }>（同 auth/post-json.js postJSON；网络失败 reject）。
 */
import { postJSON, errText as apiErrText } from '../../auth/post-json.js';
import { getPasskeyAssertion, assertionOptions, assertionToJSON, isPasskeyCancel } from '../../auth/passkey-assert.js';
import { KEY_ACCOUNT, KEY_ROOT } from '../../lib/key-names.js';
import { deviceHints } from '../../lib/device-hints.js';

/** 账号接口（现在是单入口 POST { action }；NAMING-V2 P2 拆成按入口的子路径时只改这个文件） */
const ACCOUNT_API = '/api/account';

/** 密码管理器里的隐藏用户名：account password（登录 / 再验证 / 新密码）、恢复密钥 */
export const PM_USER = Object.freeze({ password: KEY_ACCOUNT, recoveryKey: KEY_ROOT });
/** 账号通行密钥在密码管理器里的显示名（服务端 passkey-list 没给 userName 时用；signalCurrentUserDetails） */
export const PASSKEY_USER_NAME = KEY_ACCOUNT;

/** 服务端错误码（面板按它分支） */
export const ERR = Object.freeze({
  /** 没进门（进站会话没了）→ 回锁屏 */
  lock: 'session',
  /** 没账号会话 / reset 票无效 */
  account: 'account',
  /** 要 reauth 票 */
  reauth: 'reauth',
  /** 密码 / 恢复密钥不对 */
  wrong: ['wrong', 'denied', 'auth'],
  cooldown: 'cooldown',
  config: 'config',
  params: 'params',
});

/** @param {any} body */
function post(body) { return postJSON(ACCOUNT_API, body); }
/** @param {any} body 带上设备提示（型号 / 平台，服务端记进设备列表） */
function withDevice(body) {
  const dev = deviceHints();
  if (dev) body.device = dev;
  return body;
}

/** @param {any} tk */
function liveTicket(tk) { return tk && typeof tk.expiresAt === 'number' ? { by: tk.by || '', expiresAt: tk.expiresAt } : null; }

/**
 * GET 账号状态，归一成面板用的形状。读不到 / 非 JSON / !ok → null。
 * @returns {Promise<{signing: boolean, configured: {password: boolean, passkey: boolean}, session: any, reauth: any, reset: any}|null>}
 */
export function status() {
  return fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok) return null;
      return {
        signing: j.ready !== false,
        configured: { password: !!j.password, passkey: !!j.passkey },
        session: j.session ? { by: j.session.by || '', device: j.session.device || '', expiresAt: j.session.expiresAt || 0 } : null,
        reauth: liveTicket(j.reauth),
        reset: liveTicket(j.reset),
      };
    }, function () { return null; });
}

/**
 * 通行密钥断言（登录 / 再验证共用一套旧接口：challenge + login-passkey，再验证带 reauth:true）。
 * reject：{ cancelled: true } | { message } | { code, s }
 * @param {(k: string) => string} t 错误文案（common.*） @param {boolean} reauthToo
 */
function passkeyAssert(t, reauthToo) {
  return post({ action: 'login-challenge' }).then(function (res) {
    const j = res.j;
    if (!j || !j.ok || !j.challenge) throw { message: apiErrText(t, j && j.error, res.s) };
    return getPasskeyAssertion(assertionOptions(j), {}).then(function (cred) {
      return { cred: /** @type {any} */ (cred), cid: j.cid };
    }, function (e) {
      if (isPasskeyCancel(e)) throw { cancelled: true };
      throw { message: t('errVerify') };
    });
  }, function () {
    throw { message: t('errNetwork') };
  }).then(function (r) {
    const cred = r.cred;
    const body = withDevice({ action: 'login-passkey', cid: r.cid, credential: assertionToJSON(cred) });
    if (reauthToo) body.reauth = true;
    return post(body).then(function (res) {
      if (res.j && res.j.ok) return;
      throw { message: apiErrText(t, res.j && res.j.error, res.s) };
    }, function () {
      throw { message: t('errNetwork') };
    });
  });
}

/** sudo root：登录会话 */
export const session = Object.freeze({
  /**
   * 账号密码登录。withReauth：顺手签 reauth 票（奇趣 / 日刻授权同意要用，NAMING-V2 Q1 待定）
   * @param {string} pw @param {boolean} [withReauth]
   */
  password: function (pw, withReauth) {
    const body = withDevice({ action: 'login-password', password: pw });
    if (withReauth) body.reauth = true;
    return post(body);
  },
  /** @param {(k: string) => string} t @param {boolean} [withReauth] */
  passkey: function (t, withReauth) { return passkeyAssert(t, !!withReauth); },
  /** exit：退出登录 */
  end: function () { return post({ action: 'logout' }); },
});

/** sudo root reauth：3 分钟再验证 */
export const reauth = Object.freeze({
  /** @param {string} pw */
  password: function (pw) { return post(withDevice({ action: 'login-password', password: pw, reauth: true })); },
  /** @param {(k: string) => string} t */
  passkey: function (t) { return passkeyAssert(t, true); },
  /** 关下拉 / 离开页面（keepalive，不等结果） */
  end: function () {
    try {
      fetch(ACCOUNT_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reauth-clear' }), credentials: 'same-origin', keepalive: true }).catch(function () {});
    } catch (e) {}
  },
});

/** 账号钥匙的写操作（账号安全 = reauth 票；sudo root reset 里 = reset 票，后端现在是同一组 action） */
const keyOps = {
  /** @param {string} pw */
  passwordSet: function (pw) { return post({ action: 'password-change', password: pw }); },
  passkeyList: function () { return post({ action: 'passkey-list' }); },
  passkeyAddChallenge: function () { return post({ action: 'passkey-register-challenge' }); },
  /** @param {any} body registerPasskey 给的注册结果 */
  passkeyAdd: function (body) { return post(Object.assign({ action: 'passkey-register' }, body)); },
  /** @param {string} id */
  passkeyDelete: function (id) { return post({ action: 'passkey-delete', credId: id }); },
};

/** sudo root reset：恢复密钥 → reset 票（不签会话）→ 重设 → finish 三选一 */
export const reset = Object.freeze(Object.assign({
  /** @param {string} key */
  recoveryKey: function (key) { return post({ action: 'root-reset', key: key }); },
  /** @param {'all'|'others'|'none'} signOut */
  finish: function (signOut) { return post({ action: 'reset-finish', signOut: signOut }); },
}, keyOps));

/** 账号安全（reauth 票） */
export const keys = Object.freeze(Object.assign({
  /** @param {string} id @param {string} name */
  passkeyRename: function (id, name) { return post({ action: 'passkey-rename', credId: id, name: name }); },
}, keyOps));

/** 设备 */
export const devices = Object.freeze({
  list: function () { return post({ action: 'device-list' }); },
  /** @param {string} id */
  revoke: function (id) { return post({ action: 'device-revoke', deviceId: id }); },
  revokeAll: function () { return post({ action: 'device-revoke-all' }); },
});

/** 应用授权 */
export const grants = Object.freeze({
  list: function () { return post({ action: 'grant-list' }); },
  /** @param {string} app */
  add: function (app) { return post({ action: 'grant-add', app: app }); },
  /** @param {string} app */
  revoke: function (app) { return post({ action: 'grant-revoke', app: app }); },
});

/** 错误码 → 文案（common.err*，同 auth/post-json.js） */
export { apiErrText as errText };

/** @param {any} res @param {string|string[]} code */
export function isErr(res, code) {
  const c = res && res.j && res.j.error;
  return Array.isArray(code) ? code.indexOf(c) !== -1 : c === code;
}
