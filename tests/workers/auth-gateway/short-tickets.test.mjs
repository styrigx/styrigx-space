/**
 * 四张 reset / reauth 短票（_kernel/tickets.js verifyTicket）的时间窗口：
 * - expired：exp <= now（签发 181 秒前的票）
 * - not-yet：iat > now + 60s（时钟偏差容忍 60 秒，之内照常有效）
 * - 超长：exp − iat > 该票 maxAge → bad-format（签名本身是对的，也不认）
 * 每种情况都用正确的私钥、正确的纪元签，排除签名 / 纪元的干扰，只让时间这一项出错。
 *
 * 运行：node --test tests/workers/auth-gateway/short-tickets.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTicket, signTicket, SHORT_TICKETS } from '../../../workers/auth-gateway/functions/_kernel/tickets.js';
import { ed25519Sign } from '../../../workers/auth-gateway/functions/_kernel/crypto.js';
import { TICKETS } from '../../../workers/auth-gateway/functions/_kernel/realms.js';

function derToPem(der, label) {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}
async function pair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
    pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
  };
}
const LOCK = await pair();
const ACCOUNT = await pair();
const EPOCH = 3;

function makeKV() {
  const m = new Map([['lock-epoch', String(EPOCH)], ['account-epoch', String(EPOCH)]]);
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
const kv = makeKV();
const env = {
  SGX_LOCK_PRIVATE: LOCK.priv, SGX_LOCK_PUBLIC: LOCK.pub,
  SGX_ACCOUNT_PRIVATE: ACCOUNT.priv, SGX_ACCOUNT_PUBLIC: ACCOUNT.pub,
  KV_LOCK_DOOR: kv, KV_ACCOUNT_LOGIN: kv,
};
const privOf = (name) => env[TICKETS[name].privateKey];
const reqWith = (name, val) => new Request('https://styrigx.com/', { headers: { Cookie: TICKETS[name].cookie + '=' + val } });

/** 手签任意 iat / exp 的票（signTicket 永远是 exp = iat + maxAge，造不出超长票） */
async function rawTicket(name, by, epoch, iat, exp) {
  const payload = by + '.' + epoch + '.' + iat + '.' + exp;
  return payload + '.' + (await ed25519Sign(privOf(name), TICKETS[name].cookie + '|' + payload));
}

test('四张短票都在表里，时长都是 180 秒', () => {
  assert.equal(SHORT_TICKETS.length, 4);
  for (const name of SHORT_TICKETS) assert.equal(TICKETS[name].maxAge, 180, name);
});

for (const name of SHORT_TICKETS) {
  const by = TICKETS[name].bys[0];
  const maxMs = TICKETS[name].maxAge * 1000;

  test(name + '：刚签的票有效（对照）', async () => {
    const r = await verifyTicket(reqWith(name, await signTicket(privOf(name), name, by, EPOCH)), env, name);
    assert.deepEqual([r.ok, r.reason, r.by], [true, 'ok', by]);
  });

  test(name + '：181 秒前签的 → expired', async () => {
    const r = await verifyTicket(reqWith(name, await signTicket(privOf(name), name, by, EPOCH, Date.now() - 181000)), env, name);
    assert.deepEqual([r.ok, r.reason], [false, 'expired']);
  });

  test(name + '：exp 正好等于 now 也算过期（exp <= now）', async () => {
    const now = Date.now();
    const r = await verifyTicket(reqWith(name, await rawTicket(name, by, EPOCH, now - maxMs, now - 1)), env, name);
    assert.deepEqual([r.ok, r.reason], [false, 'expired']);
  });

  test(name + '：iat 在未来 61 秒以上 → not-yet；30 秒内的时钟偏差照常有效', async () => {
    const future = Date.now() + 90000;
    const r = await verifyTicket(reqWith(name, await signTicket(privOf(name), name, by, EPOCH, future)), env, name);
    assert.deepEqual([r.ok, r.reason], [false, 'not-yet']);
    const skew = await verifyTicket(reqWith(name, await signTicket(privOf(name), name, by, EPOCH, Date.now() + 30000)), env, name);
    assert.deepEqual([skew.ok, skew.reason], [true, 'ok']);
  });

  test(name + '：exp − iat 超过 maxAge（签名是对的）→ bad-format；正好等于 maxAge 有效', async () => {
    const iat = Date.now() - 1000;
    const long = await verifyTicket(reqWith(name, await rawTicket(name, by, EPOCH, iat, iat + maxMs + 1)), env, name);
    assert.deepEqual([long.ok, long.reason], [false, 'bad-format']);
    const year = await verifyTicket(reqWith(name, await rawTicket(name, by, EPOCH, iat, iat + 365 * 86400e3)), env, name);
    assert.deepEqual([year.ok, year.reason], [false, 'bad-format']);
    const exact = await verifyTicket(reqWith(name, await rawTicket(name, by, EPOCH, iat, iat + maxMs)), env, name);
    assert.deepEqual([exact.ok, exact.reason], [true, 'ok']);
  });
}
