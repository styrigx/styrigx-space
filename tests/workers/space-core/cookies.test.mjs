/**
 * workers/space-core/src/lib/cookies.js：网关读 Cookie 头的唯一实现。
 *
 * - 语义和以前四处手写的解析（account-session / tickets 的 readCookie、lock-session 的 allLockSessionCookies、
 *   以前 space-auth 的快速会话判断循环）逐字一致：拿以前的实现当参照，对一批刁钻的 Cookie 头逐个比结果
 * - 源码守卫：网关里除了 cookies.js 没有别的地方自己切 Cookie 头
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCookie, readAllCookies, MAX_COOKIE_HEADER } from '../../../workers/space-core/src/lib/cookies.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 以前 account-session.js / tickets.js 里的 readCookie（原样） */
function oldReadCookie(request, name) {
  const h = (request && request.headers && request.headers.get('Cookie')) || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
/** 以前 lock-session.js 的 allLockSessionCookies（原样，名字参数化） */
function oldReadAll(request, name) {
  const out = [];
  const h = (request && request.headers && request.headers.get('Cookie')) || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) out.push(v.join('='));
  }
  return out;
}

const req = (cookie) => new Request('https://styrigx.com/', cookie === undefined ? {} : { headers: { Cookie: cookie } });

const HEADERS = [
  undefined,
  '',
  ';',
  ' ; ; ',
  'sgx-space-session=a.b.c',
  'sgx-space-session=a.b.c; sgx-space-session=d.e.f',
  'x=1;sgx-space-session=v1;  sgx-space-session = v2 ;sgx-space-session=v3',
  'sgx-space-session',
  'sgx-space-session=',
  'sgx-space-session==abc==',
  'SGX-LOCK-SESSION=upper; sgx-space-session=lower',
  'sgx-space-session="quoted"',
  'sgx-space-session=a%2Eb',
  'sgx-space-sessionx=no; xsgx-space-session=no',
  '\tsgx-space-session=tab\t; sgx-account-session=acc',
  'sgx-space-reauth=t1; sgx-space-reset=t2; sgx-account-reauth=t3',
  'a=b=c=d',
];
const NAMES = ['sgx-space-session', 'sgx-account-session', 'sgx-space-reauth', 'sgx-space-reset', 'sgx-account-reauth', 'a', 'x', ''];

test('cookies：readCookie / readAllCookies 与以前的手写解析逐个一致', () => {
  for (const h of HEADERS) {
    for (const name of NAMES) {
      const r = req(h);
      assert.equal(readCookie(r, name), oldReadCookie(r, name), JSON.stringify([h, name]));
      assert.deepEqual(readAllCookies(r, name), oldReadAll(r, name), JSON.stringify([h, name]));
    }
  }
});

test('cookies：随机 Cookie 头与以前的解析一致', () => {
  const alphabet = ['sgx-space-session', 'sgx-account-session', '=', ';', ' ', 'a', '.', '"', '%3D', '\t'];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 500; i++) {
    let h = '';
    const len = rnd() % 12;
    for (let j = 0; j < len; j++) h += alphabet[rnd() % alphabet.length];
    const r = req(h);
    for (const name of ['sgx-space-session', 'sgx-account-session', 'a']) {
      assert.equal(readCookie(r, name), oldReadCookie(r, name), JSON.stringify(h));
      assert.deepEqual(readAllCookies(r, name), oldReadAll(r, name), JSON.stringify(h));
    }
  }
});

test('cookies：规则本身（同名按顺序、值里的 = 保留、不解码、区分大小写、没有就是空串）', () => {
  const r = req('x=1; sgx-space-session=v1; sgx-space-session=a=b; SGX-LOCK-SESSION=up; s=%2E');
  assert.deepEqual(readAllCookies(r, 'sgx-space-session'), ['v1', 'a=b']);
  assert.equal(readCookie(r, 'sgx-space-session'), 'v1');
  assert.equal(readCookie(r, 's'), '%2E');
  assert.equal(readCookie(r, 'missing'), '');
  assert.deepEqual(readAllCookies(r, 'missing'), []);
  assert.equal(readCookie(null, 'x'), '');
  assert.deepEqual(readAllCookies({}, 'x'), []);
  assert.equal(MAX_COOKIE_HEADER, 8192);
});

test('源码守卫：网关里只有 src/lib/cookies.js 自己切 Cookie 头', () => {
  const root = join(REPO, 'workers');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules') walk(p); } else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(join(root, 'space-core/src'));
  const offenders = [];
  for (const f of files) {
    if (f.endsWith('/workers/space-core/src/lib/cookies.js')) continue;
    const src = readFileSync(f, 'utf8');
    if (/headers\.get\(\s*['"]cookie['"]\s*\)/i.test(src) && /split\(\s*['"];['"]\s*\)/.test(src)) offenders.push(f.slice(root.length + 1));
  }
  assert.deepEqual(offenders, []);
});
