/* 生成 tests/fixtures/app-token-vectors.json（测试向量，仅测试用）
   用项目自身的 _kernel/crypto.js 签名，保证与服务端一致。
   运行：node scripts/gen-app-vectors.mjs（只需跑一次，提交生成的文件） */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519Sign } from '../workers/auth-gateway/functions/_kernel/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

const now = Date.now();
const exp = now + 600 * 1000;

const vectors = {
  note: '测试向量（仅测试用，绝非生产密钥）。space 与 book 各放一份完全相同。',
  keypair: { private_pem: privPem, public_pem: pubPem },
  valid: [],
  invalid: {},
};

const cases = [
  ['book', 'upload', 3, 5],
  ['book', 'upload', 0, 5],
  ['music', 'play', 1, 7],
];
for (const [aud, scope, appEpoch, epoch] of cases) {
  const payload = ['owner', epoch, appEpoch, now, exp, aud, scope].join('.');
  const token = payload + '.' + (await ed25519Sign(privPem, payload));
  vectors.valid.push({ token, epoch, appEpoch, aud, scope, desc: `有效 token：aud=${aud}, scope=${scope}, appEpoch=${appEpoch}` });
}

// 篡改
{
  const parts = vectors.valid[0].token.split('.');
  parts[5] = 'evil';
  vectors.invalid.tampered = { token: parts.join('.'), desc: '篡改 aud 后签名失效，验证必须拒绝' };
}
// 过期
{
  const iat = now - 700000, e = now - 100000;
  const payload = ['owner', 5, 3, iat, e, 'book', 'upload'].join('.');
  vectors.invalid.expired = { token: payload + '.' + (await ed25519Sign(privPem, payload)), desc: '已过期，验证必须拒绝' };
}
// appEpoch 偏低
{
  const payload = ['owner', 5, 1, now, exp, 'book', 'upload'].join('.');
  vectors.invalid.low_app_epoch = {
    token: payload + '.' + (await ed25519Sign(privPem, payload)),
    appEpoch: 1,
    desc: '签名有效但 appEpoch=1，若当前为 3 则 book 验证必须拒绝',
  };
}

const out = join(__dirname, '..', 'tests', 'fixtures', 'app-token-vectors.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(vectors, null, 2));
console.log('wrote', out);
