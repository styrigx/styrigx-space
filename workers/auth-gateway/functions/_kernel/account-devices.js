/**
 * 账号已登录设备（设置 › 账号 › 设备）。
 *
 * 每次账号登录（通行密钥 / 密码）在 sgx-account-session 票据里带一个随机 deviceId，
 * 并在 D1 device 表记一行（realm = 'account'，绑定 D1_ACCOUNT_AUTH；2026-10-27 从 KV account-device:* 搬来）：
 *   record = { deviceId, by, createdAt, authAt, lastSeen, model, platform, platformVersion, browser, country, city }
 * - 同一浏览器重新登录（含进账号安全前再验一次）沿用原 deviceId，只更新 by/authAt，不会多出一台
 * - 设备页列出全部未退出、未过期的行（SQL ORDER BY last_seen DESC），当前请求的 deviceId 标为「此设备」排最上面
 * - 单独退出别的设备：revoked_at = now（行留到 expires_at = 400 天，同账号会话；以前另写 account-device-revoked:* 黑名单），
 *   之后那台设备的票据验签通过也会被拒（reason=revoked）。D1 强一致：退出后那台的下一个请求就被拒。
 *   已退出的行不会被改回来（写记录的 UPSERT 带 WHERE revoked_at = 0）
 * - 改账号密码 / 删账号通行密钥（account-epoch +1）：其他设备的票据本来就失效，顺手删掉它们的行
 * - 不存 IP，只存 Cloudflare 给的国家 / 城市（显示「上次活动地点」）
 * - 过期行读时不认，登录写记录时顺手清掉
 *
 * 型号来自前端 navigator.userAgentData.getHighEntropyValues（登录请求体 device 字段），
 * 拿不到时只从 User-Agent 推平台和浏览器。三星常见型号映射成「Galaxy S23 Ultra」这样的名字。
 *
 * 叶子模块：只 import _kernel（crypto / realms / d1-state）。
 */
import { b64urlEnc } from './crypto.js';
import { REALM_ACCOUNT } from './realms.js';
import { onAuthDb, sweepExpired, parseRecord } from './d1-state.js';

const REALM = REALM_ACCOUNT.id;
const TTL_MS = REALM_ACCOUNT.maxAge * 1000;
/** lastSeen 至多每 30 分钟写一次（省 D1 写次数） */
export const TOUCH_INTERVAL_MS = 30 * 60 * 1000;

/** deviceId：12 字节随机，base64url（16 字符，不含 '.'） */
export function newDeviceId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return b64urlEnc(b);
}

/** @param {string} deviceId */
export function isDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(deviceId);
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

/**
 * 读一台设备（未退出、未过期；没有 → null）。D1 出错抛错。
 * @param {any} env @param {string} deviceId
 */
export async function getDevice(env, deviceId) {
  if (!isDeviceId(deviceId)) return null;
  const row = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'SELECT record FROM device WHERE realm = ? AND device_id = ? AND revoked_at = 0 AND expires_at > ?'
  ).bind(r.id, deviceId, Date.now()).first());
  return parseRecord(row);
}

/**
 * 写设备记录（没有就插入；有就覆盖并续期）。已单独退出的行不改（WHERE revoked_at = 0）。D1 出错抛错。
 * @param {any} env @param {any} rec
 */
export async function putDevice(env, rec) {
  const now = Date.now();
  await onAuthDb(env, REALM, (db, r) => db.prepare(
    'INSERT INTO device (realm, device_id, record, last_seen, revoked_at, expires_at) VALUES (?1, ?2, ?3, ?4, 0, ?5) ' +
    'ON CONFLICT (realm, device_id) DO UPDATE SET record = excluded.record, last_seen = excluded.last_seen, expires_at = excluded.expires_at ' +
    'WHERE device.revoked_at = 0'
  ).bind(r.id, String(rec.deviceId), JSON.stringify(rec), Number(rec.lastSeen) || now, now + TTL_MS).run());
}

/**
 * 登录时写设备记录：已有（同一浏览器重新登录）就更新 by/authAt/lastSeen 和设备信息，否则新建。顺手清掉过期行。
 * @param {any} env @param {string} deviceId @param {string} by @param {number} authAt @param {object} info deviceInfo()
 */
export async function recordLogin(env, deviceId, by, authAt, info) {
  const now = Date.now();
  let rec = null;
  try { rec = await getDevice(env, deviceId); } catch (e) { rec = null; }
  const base = rec && typeof rec === 'object' ? rec : { deviceId: deviceId, createdAt: now };
  const next = Object.assign({}, base, info || {}, { deviceId: deviceId, by: by, authAt: authAt, lastSeen: now });
  /* 新信息缺型号时保留旧的（比如这次请求没带 hints） */
  if (rec && !(info && info.model) && rec.model) next.model = rec.model;
  await putDevice(env, next);
  try { await onAuthDb(env, REALM, (db, r) => sweepExpired(db, 'device', r.id, now)); } catch (e) {}
  return next;
}

/**
 * 这台设备是否已被单独退出（验账号会话时用：每个请求一次主键读，主库、不缓存）。D1 出错抛错。
 * @param {any} env @param {string} deviceId
 */
export async function isRevoked(env, deviceId) {
  if (!deviceId) return false;
  const row = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'SELECT 1 AS x FROM device WHERE realm = ? AND device_id = ? AND revoked_at > 0 AND expires_at > ?'
  ).bind(r.id, String(deviceId), Date.now()).first());
  return !!row;
}

/**
 * 单独退出一台设备：revoked_at = now，行续到 400 天后（期间这台的票一律拒）。没有这一行也插一行已退出的
 * （退出账号时本机记录可能还没写进来）。D1 出错抛错。
 * @param {any} env @param {string} deviceId
 */
export async function revokeDevice(env, deviceId) {
  const now = Date.now();
  await onAuthDb(env, REALM, (db, r) => db.prepare(
    'INSERT INTO device (realm, device_id, record, last_seen, revoked_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?4, ?5) ' +
    'ON CONFLICT (realm, device_id) DO UPDATE SET revoked_at = ?4, expires_at = ?5'
  ).bind(r.id, String(deviceId), JSON.stringify({ deviceId: String(deviceId) }), now, now + TTL_MS).run());
}

/** 设备页一次最多列多少台（最近活跃的在前；当前设备不在其中时由 device-list 单独补上，见 api/account.js）。2026-10-28 PR2 */
export const DEVICE_LIST_MAX = 50;

/**
 * 列出全部设备记录（未退出、未过期；按 lastSeen 倒序）。D1 出错抛错。
 * @param {any} env
 * @returns {Promise<object[]>}
 */
export async function listDevices(env, limit = DEVICE_LIST_MAX) {
  const n = Math.max(1, Math.min(DEVICE_LIST_MAX, Math.floor(Number(limit)) || DEVICE_LIST_MAX));
  const res = await onAuthDb(env, REALM, (db, r) => db.prepare(
    'SELECT record FROM device WHERE realm = ? AND revoked_at = 0 AND expires_at > ? ORDER BY last_seen DESC LIMIT ?'
  ).bind(r.id, Date.now(), n).all());
  return ((res && res.results) || []).map(parseRecord).filter((d) => d && d.deviceId);
}

/**
 * account-epoch +1 后：删掉除当前设备外的所有未退出的行（它们的票据已经失效）。尽力而为，不抛错。
 * 已退出的行留着（到期前那台的票继续拒，哪怕纪元以后被改回去也一样）。
 * @param {any} env @param {string} keepDeviceId
 */
export async function pruneOtherDevices(env, keepDeviceId) {
  try {
    await onAuthDb(env, REALM, (db, r) => db.prepare('DELETE FROM device WHERE realm = ? AND device_id <> ? AND revoked_at = 0')
      .bind(r.id, String(keepDeviceId || '')).run());
  } catch (e) { /* 删不掉就算了：设备页也只多显示几台，它们的票已随纪元失效 */ }
}

/**
 * 给前端的设备视图。
 * @param {object} d @param {string} currentDeviceId
 */
export function deviceView(d, currentDeviceId) {
  return {
    deviceId: d.deviceId,
    current: d.deviceId === currentDeviceId,
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
