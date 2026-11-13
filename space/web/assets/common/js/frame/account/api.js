/**
 * @fileoverview 账号终端调后端的唯一地方（2026-11-08 账号 UI 改版；NAMING-V2 P2 起按入口拆开）。
 *
 * 面板代码只用这里导出的对象（按入口分：v6keys / devices / proxy），不直接写接口地址、action 名、请求字段。
 * 后端：POST /api/account/<入口> { action }（入口 = devices / proxy，见 workers/account/src/api/account/）、
 * POST /api/identity passkey-*（自己的通行密钥）。v6 P4 起旧账号会话的入口（session / reauth / reset / keys、GET /api/account 状态）删除。
 *
 * 每个调用都回 Promise<{ s: number, j: any }>（同 auth/post-json.js postJSON；网络失败 reject）。
 */
import { postJSON, errText as apiErrText } from '../../auth/post-json.js';

/** 账号接口：POST 到 /api/account/<入口> */
const ACCOUNT_API = '/api/account';
/** v6 身份接口（自己的通行密钥走这里；同 identity/api.js IDENTITY_API） */
const IDENTITY_API = '/api/identity';

/** 服务端错误码（面板按它分支） */
export const ERR = Object.freeze({
  /** 密码不对 */
  wrong: ['wrong', 'auth'],
  cooldown: 'cooldown',
  config: 'config',
  params: 'params',
});

/**
 * sudo 借 root（定稿 v5.5 §四「后台数据控制……一律 root 档，站长用 sudo 提权、不必 su root」；§七「站长预填 sudo …」）：
 * 终端 sudo device … / sudo sub … 跑这一条命令时由身份层（identity/layer.js sudoProof）给一个「证明」来源，
 * 这条命令里每次调账号接口都改走 POST /api/identity { action:'sudo', password | {cid, credential}, command:{ method, path, body } }
 * （服务端 api/sudo-route.js：每次验自己的凭据、不发票据、不压栈；回的就是那条接口的响应，形状不变）。
 * 下一条命令开始前清掉（setSudo(null)）。
 * @type {null | (() => Promise<any>)}
 */
let sudoVia = null;
/** 这一条命令走不走 sudo（null = 不走） @param {null | (() => Promise<any>)} via */
export function setSudo(via) { sudoVia = typeof via === 'function' ? via : null; }
/** 现在是不是 sudo 这一条命令 */
export function sudoOn() { return !!sudoVia; }

/**
 * @param {string} entry 入口（devices / proxy）
 * @param {string} action @param {object} [fields]
 */
function post(entry, action, fields) {
  const body = Object.assign({ action: action }, fields || {});
  if (!sudoVia) return postJSON(ACCOUNT_API + '/' + entry, body);
  return sudoVia().then(function (/** @type {any} */ proof) {
    return postJSON(IDENTITY_API, Object.assign({ action: 'sudo' }, proof || {}, { command: { method: 'POST', path: ACCOUNT_API + '/' + entry, body: body } }));
  });
}
/**
 * v6 用户自己的通行密钥（定稿 §八「普通用户用 passwd、passkey 改自己的凭据；通行密钥自带 WebAuthn 验证」）。
 * 后端 POST /api/identity passkey-list | passkey-add-challenge | passkey-add | passkey-delete（user 档，按服务端会话的 uid，
 * 栈顶是谁就是谁的：su root 后是 root 的，救援白名单也有）。回的形状：列表 keys[]。没有改名接口（加的时候带上预填名）。
 * 每个请求带 as = 终端提示符上的 uid；服务端认定的身份对不上 → 409 identity（auth-err.js 切回真实身份），不执行。
 */
export const v6keys = Object.freeze({
  /** @returns {Promise<{s: number, j: any}>} j.keys = 自己的钥匙（每把带服务端编号 n） */
  /** @param {number} as */
  passkeyList: function (as) {
    return postJSON(IDENTITY_API, { action: 'passkey-list', as: as }).then(function (r) {
      const got = r && r.j && r.j.ok ? r.j : null;
      return got ? { s: r.s, j: { ok: true, keys: got.passkeys || [] } } : r;
    });
  },
  /** @param {number} as */
  passkeyAddChallenge: function (as) { return postJSON(IDENTITY_API, { action: 'passkey-add-challenge', as: as }); },
  /** @param {any} body registerPasskey 给的注册结果 @param {string} handle challenge 里的 user.id（服务端用它对上这次 challenge） @param {number} as */
  passkeyAdd: function (body, handle, as) { return postJSON(IDENTITY_API, Object.assign({ action: 'passkey-add' }, body, { handle: handle, as: as })); },
  /** @param {number} n 服务端列表里的编号 @param {number} as */
  passkeyDelete: function (n, as) { return postJSON(IDENTITY_API, { action: 'passkey-delete', n: n, as: as }); },
});

/** 设备会话（定稿 v5.5 §五：list webmaster 档、全站视图；revoke / revoke-all root 档，站长经 sudo） */
export const devices = Object.freeze({
  list: function () { return post('devices', 'list'); },
  /** @param {number} n 服务端列表里的编号 */
  revoke: function (n) { return post('devices', 'revoke', { n: n }); },
  revokeAll: function () { return post('devices', 'revoke-all'); },
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
  /** 立即拉一个机场源 @param {string} name */
  update: function (name) { return post('proxy', 'update', { name: name }); },
  map: function () { return post('proxy', 'map'); },
  /** 没 code = 丢弃词 @param {string} word @param {string} [code] */
  mapSet: function (word, code) { return post('proxy', 'map_set', code ? { word: word, code: code } : { word: word }); },
  /** @param {string} word */
  mapRm: function (word) { return post('proxy', 'map_rm', { word: word }); },
  /** @param {string} name */
  mapLs: function (name) { return post('proxy', 'map_ls', { name: name }); },
  /** 没 value = 看当前 @param {string} [value] */
  fp: function (value) { return post('proxy', 'fp', value ? { value: value } : {}); },
});

/** 错误码 → 文案（common.err*，同 auth/post-json.js） */
export { apiErrText as errText };

/** @param {any} res @param {string|string[]} code */
export function isErr(res, code) {
  const c = res && res.j && res.j.error;
  return Array.isArray(code) ? code.indexOf(c) !== -1 : c === code;
}
