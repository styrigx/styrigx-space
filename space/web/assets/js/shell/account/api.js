/**
 * @fileoverview 账号终端调后端的唯一地方（2026-11-08 账号 UI 改版；NAMING-V2 P2 起按入口拆开）。
 *
 * 面板代码只用这里导出的对象（按入口分：v6keys / devices / grants / proxy），不直接写接口地址、action 名、请求字段。
 * 后端：POST /api/account/<入口> { action }（入口 = devices / grants / proxy，见 workers/account/src/api/account/）、
 * POST /api/identity passkey-*（自己的通行密钥）。v6 P4 起旧账号会话的入口（session / reauth / reset / keys、GET /api/account 状态）删除。
 *
 * 每个调用都回 Promise<{ s: number, j: any }>（同 auth/post-json.js postJSON；网络失败 reject）。
 */
import { postJSON, errText as apiErrText } from '../../auth/post-json.js';

/** 账号接口：POST 到 /api/account/<入口> */
const ACCOUNT_API = '/api/account';
/** v6 身份接口（自己的通行密钥走这里；同 shell/identity/api.js IDENTITY_API） */
const IDENTITY_API = '/api/identity';

/** 服务端错误码（面板按它分支） */
export const ERR = Object.freeze({
  /** 密码不对 */
  wrong: ['wrong', 'denied', 'auth'],
  cooldown: 'cooldown',
  config: 'config',
  params: 'params',
});

/**
 * @param {string} entry 入口（devices / grants / proxy）
 * @param {string} action @param {object} [fields]
 */
function post(entry, action, fields) { return postJSON(ACCOUNT_API + '/' + entry, Object.assign({ action: action }, fields || {})); }
/**
 * v6 用户自己的通行密钥（定稿 §八「普通用户用 passwd、passkey 改自己的凭据；通行密钥自带 WebAuthn 验证」）。
 * 后端 POST /api/identity passkey-list | passkey-add-challenge | passkey-add | passkey-delete（user 档，按服务端会话的 uid，
 * 栈顶是谁就是谁的：su root 后是 root 的，救援白名单也有）。回的形状：列表 keys[]。没有改名接口（加的时候带上预填名）。
 */
export const v6keys = Object.freeze({
  /** @returns {Promise<{s: number, j: any}>} j.keys = 自己的钥匙（每把带服务端编号 n） */
  passkeyList: function () {
    return postJSON(IDENTITY_API, { action: 'passkey-list' }).then(function (r) {
      const got = r && r.j && r.j.ok ? r.j : null;
      return got ? { s: r.s, j: { ok: true, keys: got.passkeys || [] } } : r;
    });
  },
  passkeyAddChallenge: function () { return postJSON(IDENTITY_API, { action: 'passkey-add-challenge' }); },
  /** @param {any} body registerPasskey 给的注册结果 @param {string} handle challenge 里的 user.id（服务端用它对上这次 challenge） */
  passkeyAdd: function (body, handle) { return postJSON(IDENTITY_API, Object.assign({ action: 'passkey-add' }, body, { handle: handle })); },
  /** @param {number} n 服务端列表里的编号 */
  passkeyDelete: function (n) { return postJSON(IDENTITY_API, { action: 'passkey-delete', n: n }); },
});

/** 设备 = 自己的 v6 会话（user 档） */
export const devices = Object.freeze({
  list: function () { return post('devices', 'list'); },
  /** @param {number} n 服务端列表里的编号 */
  revoke: function (n) { return post('devices', 'revoke', { n: n }); },
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

/** 代理订阅（sub v3.1）：POST /api/account/proxy { action }（root 档） */
export const proxy = Object.freeze({
  status: function () { return post('proxy', 'status'); },
  /** @param {string} pubkey */
  key: function (pubkey) { return post('proxy', 'key', { pubkey: pubkey }); },
  show: function () { return post('proxy', 'show'); },
  /** 换新令牌（action token） */
  rotate: function () { return post('proxy', 'token'); },
  /** @param {string} name @param {string} url */
  add: function (name, url) { return post('proxy', 'add', { name: name, url: url }); },
  /** @param {string} name @param {string} text */
  upload: function (name, text) { return post('proxy', 'upload', { name: name, text: text }); },
  /** @param {string} from @param {string} to */
  mv: function (from, to) { return post('proxy', 'mv', { from: from, to: to }); },
  /** @param {string} name @param {boolean} on */
  toggle: function (name, on) { return post('proxy', on ? 'on' : 'off', { name: name }); },
  /** @param {string} name */
  rm: function (name) { return post('proxy', 'rm', { name: name }); },
});

/** 错误码 → 文案（common.err*，同 auth/post-json.js） */
export { apiErrText as errText };

/** @param {any} res @param {string|string[]} code */
export function isErr(res, code) {
  const c = res && res.j && res.j.error;
  return Array.isArray(code) ? code.indexOf(c) !== -1 : c === code;
}
