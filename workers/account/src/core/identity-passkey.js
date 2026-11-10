/**
 * v6 身份统一（P2）：v6 用户的通行密钥（account_user_passkey：credential_id → uid）——su / sudo 用的断言、自己的 passkey ls / add / rm。
 *
 * - 断言用可发现凭据（allowCredentials 为空）：不按用户名列钥匙，所以不会透露某个用户有哪些验证方式（防枚举，定稿 v4 §十）。
 *   验完按 credential_id 找到 uid，再和要登录的那个用户比；对不上 / 找不到 → 同一个 verify 错误。
 * - userHandle：断言带回的 userHandle 必须等于这把钥匙的 user_handle 或 legacy_handle（迁移照抄，逐字节；RP 不变）。
 * - 注册：user.id = 这个用户已有钥匙的 user_handle（第一把时新生成 32 字节随机，同 docs/specs/v6-identity-migration.md §3）；user.name / displayName = 用户名
 *   （密码管理器里 styrigx / root 分得开，定稿 v4 §二）。UV 必须。
 * - 通行密钥不计入用户名冷却（core/identity-auth.js）。
 *
 * 只 import lib/ 和 core/。
 */
import { onDb } from '../lib/db.js';
import { randB64, issueChallenge, consumeChallenge, verifyAssertion, rpIdHashOf } from '../lib/webauthn.js';
import { CHALLENGE_TTL } from './config.js';
import { verifyRegistration, passkeyView } from './passkey.js';

/** challenge 用途（account_challenge.purpose；和旧账号的 session / reauth / keys-add / reset-add 分开） */
export const V6_PURPOSE = Object.freeze({ su: 'v6-su', sudo: 'v6-sudo', add: 'v6-add' });

/** @param {any} row */
function rec(row) {
  try { return JSON.parse(String(row.record)); } catch (e) { return null; }
}

/** 某人的通行密钥（按注册顺序）。出错抛错。 @param {any} env @param {number} uid */
export async function listUserPasskeys(env, uid) {
  return onDb(env, async (d) => {
    const r = await d.prepare('SELECT credential_id, user_handle, legacy_handle, record FROM account_user_passkey WHERE uid = ? ORDER BY rowid').bind(uid).all();
    return ((r && r.results) || []).map((row) => ({ row, rec: rec(row) })).filter((x) => x.rec && x.rec.credId);
  });
}

/**
 * 断言第一步（su / sudo）：发 challenge，不列钥匙。
 * @param {any} env @param {{rpId:string}} rp @param {string} purpose V6_PURPOSE.su | .sudo
 */
export async function v6AssertionChallenge(env, rp, purpose) {
  const challenge = randB64(32);
  const cid = await issueChallenge(env, purpose, challenge, CHALLENGE_TTL);
  return { cid, challenge, rpId: rp.rpId, allowCredentials: [] };
}

/**
 * 断言第二步：消费 challenge → 按 credential_id 找钥匙 → 验签（UV 必须）→ userHandle 对得上 → 回写 signCount。
 * expectUid 给了就必须是这个人的钥匙。永不抛错：{ ok:true, uid } | { ok:false, error:'challenge'|'verify'|'uv-required' }。
 * @param {any} env @param {{rpId:string, origin:string}} rp @param {string} purpose @param {any} body { cid, credential }
 * @param {number|null} expectUid
 */
export async function v6CheckAssertion(env, rp, purpose, body, expectUid) {
  const cred = (body && body.credential) || {};
  const ch = await consumeChallenge(env, purpose, (body && body.cid) || '');
  if (!ch) return { ok: false, error: 'challenge' };
  try {
    const row = await onDb(env, (d) => d.prepare('SELECT credential_id, uid, user_handle, legacy_handle, record FROM account_user_passkey WHERE credential_id = ?')
      .bind(String(cred.rawId || '')).first());
    const stored = row ? rec(row) : null;
    if (!row || !stored || !stored.publicKey) throw new Error('unknown-key');
    if (expectUid !== null && Number(row.uid) !== expectUid) throw new Error('other-user');
    const checked = await verifyAssertion({
      credential: cred, challenge: ch.challenge, rpIdHash: await rpIdHashOf(rp.rpId), expectOrigin: rp.origin,
      storedPublicKey: stored.publicKey, storedSignCount: stored.signCount, requireUV: true,
    });
    const uh = cred.response && cred.response.userHandle;
    if (uh && uh !== row.user_handle && (!row.legacy_handle || uh !== row.legacy_handle)) throw new Error('userHandle');
    stored.signCount = checked.signCount;
    stored.lastUsedAt = Date.now();
    try {
      await onDb(env, (d) => d.prepare('UPDATE account_user_passkey SET record = ? WHERE credential_id = ?').bind(JSON.stringify(stored), row.credential_id).run());
    } catch (e) { console.error('[account-v6-passkey] signCount writeback failed'); }
    return { ok: true, uid: Number(row.uid) };
  } catch (e) {
    return { ok: false, error: e && /** @type {any} */ (e).message === 'uv-required' ? 'uv-required' : 'verify' };
  }
}

/**
 * 注册第一步（passkey add，给自己加）：user.id = 已有钥匙的 user_handle（没有 → 新生成）；name = 用户名。
 * @param {any} env @param {{rpId:string}} rp @param {{uid:number, name:string}} user
 */
export async function v6RegistrationChallenge(env, rp, user) {
  const keys = await listUserPasskeys(env, user.uid);
  const handle = keys.length ? String(keys[0].row.user_handle) : randB64(32);
  const challenge = randB64(32);
  const cid = await issueChallenge(env, V6_PURPOSE.add + ':' + user.uid + ':' + handle, challenge, CHALLENGE_TTL);
  return {
    cid, challenge, rpId: rp.rpId, rp: { id: rp.rpId, name: 'Styrigx' },
    user: { id: handle, name: user.name, displayName: user.name },
    excludeCredentials: keys.map((k) => ({ id: k.rec.credId, type: 'public-key' })),
  };
}

/**
 * 注册第二步：challenge 的用途里带着 uid 和 handle（别人的 challenge 用不了）→ 验 attestation → 存。
 * 永不抛错：{ ok:true, credId } | { ok:false, error }。
 * @param {any} env @param {{rpId:string, origin:string}} rp @param {{uid:number}} user @param {any} body { cid, credential, name?, handle }
 */
export async function v6AddPasskey(env, rp, user, body) {
  const handle = typeof (body && body.handle) === 'string' ? body.handle : '';
  const ch = await consumeChallenge(env, V6_PURPOSE.add + ':' + user.uid + ':' + handle, (body && body.cid) || '');
  if (!ch) return { ok: false, error: 'challenge' };
  try {
    const item = await verifyRegistration(rp, ch.challenge, body);
    await onDb(env, (d) => d.prepare('INSERT INTO account_user_passkey (credential_id, uid, user_handle, legacy_handle, record) VALUES (?, ?, ?, \'\', ?)')
      .bind(item.credId, user.uid, handle, JSON.stringify(item)).run());
    return { ok: true, credId: item.credId };
  } catch (e) {
    return { ok: false, error: e && /** @type {any} */ (e).message === 'uv-required' ? 'uv-required' : 'verify' };
  }
}

/** 列表视图（同账号通行密钥的字段） @param {any} env @param {number} uid */
export async function v6PasskeyViews(env, uid) {
  return (await listUserPasskeys(env, uid)).map((k, i) => Object.assign({ n: i + 1 }, passkeyView(k.rec)));
}

/** 删自己的第 n 把（1 起）。没有 → false。出错抛错。 @param {any} env @param {number} uid @param {number} n */
export async function v6DeletePasskey(env, uid, n) {
  const keys = await listUserPasskeys(env, uid);
  const k = Number.isInteger(n) && n >= 1 ? keys[n - 1] : null;
  if (!k) return false;
  await onDb(env, (d) => d.prepare('DELETE FROM account_user_passkey WHERE credential_id = ? AND uid = ?').bind(k.row.credential_id, uid).run());
  return true;
}
