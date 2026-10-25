/**
 * 账号已登录设备（设置 › 账号 › 设备）。
 *
 * 每次账号登录（通行密钥 / 密码 / 根凭证重置）在 sgx-account 票据里带一个随机 sid，
 * 并在 KV 记一条 account-dev:<sid>：
 *   { sid, by, createdAt, authAt, lastSeen, model, platform, platformVersion, browser, country, city }
 * - 同一浏览器重新登录（含进安全与隐私的门）沿用原 sid，只更新 by/authAt，不会多出一台
 * - 设备页 GET 列出全部记录，当前请求的 sid 标为「此设备」排最上面
 * - 单独退出别的设备：删记录 + 写黑名单 account-revoked:<sid>（TTL 同账号会话 400 天），
 *   之后那台设备的票据验签通过也会被拒（reason=revoked）
 * - 改账号密码 / 删账号通行密钥（account-epoch +1）：其他设备的票据本来就失效，顺手删掉它们的记录
 * - 不存 IP，只存 Cloudflare 给的国家 / 城市（显示「上次活动地点」）
 *
 * 型号来自前端 navigator.userAgentData.getHighEntropyValues（登录请求体 device 字段），
 * 拿不到时只从 User-Agent 推平台和浏览器。三星常见型号映射成「Galaxy S23 Ultra」这样的名字。
 *
 * 叶子模块：只 import _kernel（crypto / realms）。
 */
import { b64urlEnc } from './crypto.js';
import { REALM_ACCOUNT } from './realms.js';

export const DEVICE_PREFIX = REALM_ACCOUNT.kv.devicePrefix; /* 'account-dev:' */
export const REVOKED_PREFIX = REALM_ACCOUNT.kv.revokedPrefix; /* 'account-revoked:' */
const TTL = REALM_ACCOUNT.maxAge;
/** lastSeen 至多每 30 分钟写一次（省 KV 写次数） */
export const TOUCH_INTERVAL_MS = 30 * 60 * 1000;

/** sid：12 字节随机，base64url（16 字符，不含 '.'） */
export function newDeviceId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return b64urlEnc(b);
}

/** @param {string} sid */
export function isDeviceId(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(sid);
}

/** 字符串清洗：去控制字符、去首尾空格、截断 @param {any} v @param {number} n */
function clean(v, n) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
}

/** 三星型号前缀 → 名字（按前缀最长匹配；未知的 SM- 型号原样显示） */
const SAMSUNG_MODELS = [
  ['SM-S938', 'Galaxy S25 Ultra'], ['SM-S936', 'Galaxy S25+'], ['SM-S931', 'Galaxy S25'], ['SM-S937', 'Galaxy S25 Edge'],
  ['SM-S928', 'Galaxy S24 Ultra'], ['SM-S926', 'Galaxy S24+'], ['SM-S921', 'Galaxy S24'], ['SM-S721', 'Galaxy S24 FE'],
  ['SM-S918', 'Galaxy S23 Ultra'], ['SM-S916', 'Galaxy S23+'], ['SM-S911', 'Galaxy S23'], ['SM-S711', 'Galaxy S23 FE'],
  ['SM-S908', 'Galaxy S22 Ultra'], ['SM-S906', 'Galaxy S22+'], ['SM-S901', 'Galaxy S22'],
  ['SM-G998', 'Galaxy S21 Ultra'], ['SM-G996', 'Galaxy S21+'], ['SM-G991', 'Galaxy S21'],
  ['SM-F966', 'Galaxy Z Fold7'], ['SM-F956', 'Galaxy Z Fold6'], ['SM-F946', 'Galaxy Z Fold5'], ['SM-F936', 'Galaxy Z Fold4'],
  ['SM-F766', 'Galaxy Z Flip7'], ['SM-F761', 'Galaxy Z Flip7 FE'], ['SM-F741', 'Galaxy Z Flip6'], ['SM-F731', 'Galaxy Z Flip5'], ['SM-F721', 'Galaxy Z Flip4'],
  ['SM-X91', 'Galaxy Tab S9 Ultra'], ['SM-X81', 'Galaxy Tab S9+'], ['SM-X71', 'Galaxy Tab S9'],
  ['SM-X92', 'Galaxy Tab S10 Ultra'], ['SM-X82', 'Galaxy Tab S10+'],
  ['SM-A56', 'Galaxy A56'], ['SM-A55', 'Galaxy A55'], ['SM-A54', 'Galaxy A54'], ['SM-A36', 'Galaxy A36'], ['SM-A35', 'Galaxy A35'],
];

/**
 * 型号 → 显示名。SM-S918B → Galaxy S23 Ultra；其他原样。
 * @param {string} model
 */
export function modelName(model) {
  const m = clean(model, 40);
  if (!m) return '';
  const up = m.toUpperCase();
  let best = '';
  let name = '';
  for (const [pre, n] of SAMSUNG_MODELS) {
    if (up.startsWith(pre) && pre.length > best.length) { best = pre; name = n; }
  }
  return name || m;
}

/**
 * 从 User-Agent 推浏览器和平台（只是兜底，型号以前端 hints 为准）。
 * @param {string} ua
 * @returns {{browser:string, platform:string, model:string}}
 */
export function parseUserAgent(ua) {
  const s = typeof ua === 'string' ? ua : '';
  let browser = '';
  if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/EdgA?\/|Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\//.test(s)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/CriOS\/|Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  let platform = '';
  if (/Android/.test(s)) platform = 'Android';
  else if (/iPhone|iPad|iPod/.test(s)) platform = 'iOS';
  else if (/Windows/.test(s)) platform = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) platform = 'macOS';
  else if (/CrOS/.test(s)) platform = 'ChromeOS';
  else if (/Linux/.test(s)) platform = 'Linux';
  /* 老式 UA 里带型号：Android 14; SM-S918B Build/...；精简 UA 是「K」，丢掉 */
  let model = '';
  const mm = /Android [\d.]+; ([^;)]+?)(?: Build\/|\))/.exec(s);
  if (mm && mm[1] && mm[1] !== 'K') model = mm[1].trim();
  return { browser, platform, model };
}

/**
 * 由请求（UA + cf 地理）和前端给的 hints 组成设备信息。
 * @param {any} request
 * @param {any} hints 登录请求体的 device：{ model, platform, platformVersion }
 */
export function deviceInfo(request, hints) {
  const h = hints && typeof hints === 'object' ? hints : {};
  const ua = parseUserAgent((request && request.headers && request.headers.get('User-Agent')) || '');
  const cf = (request && request.cf) || {};
  return {
    model: clean(h.model, 40) || ua.model,
    platform: clean(h.platform, 20) || ua.platform,
    platformVersion: clean(h.platformVersion, 20),
    browser: ua.browser,
    country: clean(cf.country, 4),
    city: clean(cf.city, 40),
  };
}

/** @param {any} kv @param {string} sid */
export async function getDevice(kv, sid) {
  if (!kv || !isDeviceId(sid)) return null;
  return await kv.get(DEVICE_PREFIX + sid, 'json');
}

/** @param {any} kv @param {object} rec */
export async function putDevice(kv, rec) {
  await kv.put(DEVICE_PREFIX + rec.sid, JSON.stringify(rec), { expirationTtl: TTL });
}

/**
 * 登录时写设备记录：已有（同一浏览器重新登录）就更新 by/authAt/lastSeen 和设备信息，否则新建。
 * @param {any} kv @param {string} sid @param {string} by @param {number} authAt @param {object} info deviceInfo()
 */
export async function recordLogin(kv, sid, by, authAt, info) {
  const now = Date.now();
  let rec = null;
  try { rec = await getDevice(kv, sid); } catch (e) { rec = null; }
  const base = rec && typeof rec === 'object' ? rec : { sid: sid, createdAt: now };
  const next = Object.assign({}, base, info || {}, { sid: sid, by: by, authAt: authAt, lastSeen: now });
  /* 新信息缺型号时保留旧的（比如这次请求没带 hints） */
  if (rec && !(info && info.model) && rec.model) next.model = rec.model;
  await putDevice(kv, next);
  return next;
}

/** @param {any} kv @param {string} sid */
export async function isRevoked(kv, sid) {
  if (!kv || !sid) return false;
  return (await kv.get(REVOKED_PREFIX + sid)) !== null;
}

/**
 * 单独退出一台设备：写黑名单 + 删记录。
 * @param {any} kv @param {string} sid
 */
export async function revokeDevice(kv, sid) {
  await kv.put(REVOKED_PREFIX + sid, '1', { expirationTtl: TTL });
  await kv.delete(DEVICE_PREFIX + sid);
}

/**
 * 列出全部设备记录（按 lastSeen 倒序）。
 * @param {any} kv
 * @returns {Promise<object[]>}
 */
export async function listDevices(kv) {
  const out = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const page = await kv.list({ prefix: DEVICE_PREFIX, cursor: cursor });
    for (const k of (page && page.keys) || []) {
      const rec = await kv.get(k.name, 'json');
      if (rec && rec.sid) out.push(rec);
    }
    if (!page || page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  out.sort(function (a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
  return out;
}

/**
 * account-epoch +1 后：删掉除当前设备外的所有记录（它们的票据已经失效）。尽力而为，不抛错。
 * @param {any} kv @param {string} keepSid
 */
export async function pruneOtherDevices(kv, keepSid) {
  try {
    const all = await listDevices(kv);
    for (const d of all) {
      if (d.sid !== keepSid) await kv.delete(DEVICE_PREFIX + d.sid);
    }
  } catch (e) { /* 列不出来就算了：记录 400 天后自己过期，设备页也只多显示几台 */ }
}

/**
 * 给前端的设备视图（记录里的 sid 对外叫 deviceId）。
 * @param {object} d @param {string} curSid
 */
export function deviceView(d, curSid) {
  return {
    deviceId: d.sid,
    current: d.sid === curSid,
    name: modelName(d.model) || d.platform || '',
    model: d.model || '',
    platform: d.platform || '',
    platformVersion: d.platformVersion || '',
    browser: d.browser || '',
    country: d.country || '',
    city: d.city || '',
    by: d.by || '',
    createdAt: d.createdAt || 0,
    lastSeen: d.lastSeen || 0,
  };
}
