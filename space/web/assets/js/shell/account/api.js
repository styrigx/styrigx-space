/**
 * @fileoverview 账号终端调后端的唯一地方（2026-11-08 账号 UI 改版；NAMING-V2 P2 起按入口拆开）。
 *
 * 面板代码只用这里导出的对象（按入口分：session / reauth / reset / keys / devices / grants，写法照 acct-naming NAMING-V2 §2.8），
 * 不直接写接口地址、action 名、请求字段、状态字段、密码管理器隐藏用户名。
 * 后端：GET /api/account（状态）、POST /api/account/<入口> { action }（入口 = session / reauth / reset / keys / devices / grants，
 * 见 workers/account/src/api/account/）。一次验证只签一张票：sudo root 只签 session，reauth 只从 /reauth 拿（NAMING-V2 Q1）。
 *
 * 每个调用都回 Promise<{ s: number, j: any }>（同 auth/post-json.js postJSON；网络失败 reject）。
 */
import { postJSON, errText as apiErrText } from '../../auth/post-json.js';
import { getPasskeyAssertion, assertionOptions, assertionToJSON, isPasskeyCancel } from '../../auth/passkey-assert.js';
import { KEY_ACCOUNT_PASSWORD, KEY_ACCOUNT_PASSKEY, KEY_RECOVERY_KEY } from '../../lib/key-names.js';
import { deviceHints } from '../../lib/device-hints.js';

/** 账号接口：GET 状态；POST 到 /api/account/<入口> */
const ACCOUNT_API = '/api/account';

/** 密码管理器里的隐藏用户名：账号密码（登录 / 再验证 / 新密码）、恢复密钥（K2） */
export const PM_USER = Object.freeze({ password: KEY_ACCOUNT_PASSWORD, recoveryKey: KEY_RECOVERY_KEY });
/** 账号通行密钥在密码管理器里的显示名（服务端 passkey-list 没给 userName 时用；signalCurrentUserDetails） */
export const PASSKEY_USER_NAME = KEY_ACCOUNT_PASSKEY;

/** 服务端错误码（面板按它分支） */
export const ERR = Object.freeze({
  /** 没有进站会话 → 回锁屏 */
  lock: 'session',
  /** 没账号会话 */
  account: 'account',
  /** reset 票无效 / 过期（/api/account/reset） */
  reset: 'reset',
  /** 要 reauth 票 */
  reauth: 'reauth',
  /** 密码 / 恢复密钥不对 */
  wrong: ['wrong', 'denied', 'auth'],
  cooldown: 'cooldown',
  config: 'config',
  params: 'params',
});

/**
 * @param {string} entry 入口（session / reauth / reset / keys / devices / grants）
 * @param {string} action @param {object} [fields]
 */
function post(entry, action, fields) { return postJSON(ACCOUNT_API + '/' + entry, Object.assign({ action: action }, fields || {})); }
/** @param {any} body 带上设备提示（型号 / 平台，服务端记进设备列表） */
function withDevice(body) {
  const dev = deviceHints();
  if (dev) body.device = dev;
  return body;
}

/** @param {any} tk */
function liveTicket(tk) { return tk && typeof tk.expiresAt === 'number' ? { by: tk.by || '', expiresAt: tk.expiresAt } : null; }

/**
 * GET 账号状态。读不到 / 非 JSON / !ok → null。
 * @returns {Promise<{signing: boolean, configured: {password: boolean, passkey: boolean}, session: any, reauth: any, reset: any}|null>}
 */
export function status() {
  return fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok) return null;
      const c = j.configured || {};
      return {
        signing: j.signing !== false,
        configured: { password: !!c.password, passkey: !!c.passkey },
        session: j.session ? { by: j.session.by || '', device: j.session.device || '', expiresAt: j.session.expiresAt || 0 } : null,
        reauth: liveTicket(j.reauth),
        reset: liveTicket(j.reset),
      };
    }, function () { return null; });
}

/**
 * 通行密钥断言（session / reauth 各用各的入口和 challenge）。
 * reject：{ cancelled: true } | { message } | { code, s }
 * @param {'session'|'reauth'} entry @param {(k: string) => string} t 错误文案（common.*）
 */
function passkeyAssert(entry, t) {
  return post(entry, 'passkey-challenge').then(function (res) {
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
    const fields = { cid: r.cid, credential: assertionToJSON(cred) };
    return post(entry, 'passkey', entry === 'session' ? withDevice(fields) : fields).then(function (res) {
      if (res.j && res.j.ok) return;
      throw { message: apiErrText(t, res.j && res.j.error, res.s) };
    }, function () {
      throw { message: t('errNetwork') };
    });
  });
}

/** sudo root：登录会话（只签 session） */
export const session = Object.freeze({
  /** @param {string} pw */
  password: function (pw) { return post('session', 'password', withDevice({ password: pw })); },
  /** @param {(k: string) => string} t */
  passkey: function (t) { return passkeyAssert('session', t); },
  /** exit：退出登录（连带清掉挂在会话上的 reauth） */
  end: function () { return post('session', 'end'); },
});

/** sudo root reauth：3 分钟再验证（挂在本机会话上） */
export const reauth = Object.freeze({
  /** @param {string} pw */
  password: function (pw) { return post('reauth', 'password', { password: pw }); },
  /** @param {(k: string) => string} t */
  passkey: function (t) { return passkeyAssert('reauth', t); },
  /** 关下拉 / 离开页面（keepalive，不等结果；只清 reauth） */
  end: function () {
    try {
      fetch(ACCOUNT_API + '/reauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'end' }), credentials: 'same-origin', keepalive: true }).catch(function () {});
    } catch (e) {}
  },
});

/**
 * 账号钥匙的写操作（同名 action 在 /api/account/keys（reauth 票）和 /api/account/reset（reset 票）各有一份，验票各验各的）
 * @param {'keys'|'reset'} entry
 */
function keyOps(entry) {
  return {
    /** @param {string} pw */
    passwordSet: function (pw) { return post(entry, 'password-set', { password: pw }); },
    passkeyList: function () { return post(entry, 'passkey-list'); },
    passkeyAddChallenge: function () { return post(entry, 'passkey-add-challenge'); },
    /** @param {any} body registerPasskey 给的注册结果 */
    passkeyAdd: function (body) { return post(entry, 'passkey-add', body); },
    /** @param {string} id */
    passkeyDelete: function (id) { return post(entry, 'passkey-delete', { credId: id }); },
  };
}

/** sudo root reset：恢复密钥 → reset 票（不签会话）→ 重设 → finish 三选一 */
export const reset = Object.freeze(Object.assign({
  /** @param {string} key */
  recoveryKey: function (key) { return post('reset', 'recovery-key', { key: key }); },
  /** @param {'all'|'others'|'none'} signOut */
  finish: function (signOut) { return post('reset', 'finish', { signOut: signOut }); },
  /** 只清 reset 票 */
  end: function () { return post('reset', 'end'); },
}, keyOps('reset')));

/** 账号安全（reauth 票） */
export const keys = Object.freeze(Object.assign({
  /** @param {string} id @param {string} name */
  passkeyRename: function (id, name) { return post('keys', 'passkey-rename', { credId: id, name: name }); },
}, keyOps('keys')));

/** 设备 */
export const devices = Object.freeze({
  list: function () { return post('devices', 'list'); },
  /** @param {string} id */
  revoke: function (id) { return post('devices', 'revoke', { deviceId: id }); },
  revokeAll: function () { return post('devices', 'revoke-all'); },
});

/** 应用授权 */
export const grants = Object.freeze({
  list: function () { return post('grants', 'list'); },
  /** @param {string} app */
  add: function (app) { return post('grants', 'add', { app: app }); },
  /** @param {string} app */
  revoke: function (app) { return post('grants', 'revoke', { app: app }); },
});

/** 错误码 → 文案（common.err*，同 auth/post-json.js） */
export { apiErrText as errText };

/** @param {any} res @param {string|string[]} code */
export function isErr(res, code) {
  const c = res && res.j && res.j.error;
  return Array.isArray(code) ? code.indexOf(c) !== -1 : c === code;
}
