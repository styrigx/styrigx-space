/**
 * _kernel/cookies.js：网关读 Cookie 头的唯一实现。
 *
 * - 语义和以前四处手写的解析（account-session / tickets 的 readCookie、lock-session 的 allLockSessionCookies、
 *   root-auth 的 lightSession 循环）逐字一致：拿以前的实现当参照，对一批刁钻的 Cookie 头逐个比结果
 * - looksVisitor 仍按六段票判断（访客必须带合法 tempkeyId），五段的旧格式不算访客
 * - 源码守卫：网关里除了 cookies.js 没有别的地方自己切 Cookie 头
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCookie, readAllCookies, MAX_COOKIE_HEADER } from '../../../workers/auth-gateway/functions/_kernel/cookies.js';
import { looksVisitor } from '../../../workers/auth-gateway/functions/_kernel/lock-session.js';

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
  'sgx-lock-session=a.b.c',
  'sgx-lock-session=a.b.c; sgx-lock-session=d.e.f',
  'x=1;sgx-lock-session=v1;  sgx-lock-session = v2 ;sgx-lock-session=v3',
  'sgx-lock-session',
  'sgx-lock-session=',
  'sgx-lock-session==abc==',
  'SGX-LOCK-SESSION=upper; sgx-lock-session=lower',
  'sgx-lock-session="quoted"',
  'sgx-lock-session=a%2Eb',
  'sgx-lock-sessionx=no; xsgx-lock-session=no',
  '\tsgx-lock-session=tab\t; sgx-account-session=acc',
  'sgx-lock-reauth=t1; sgx-lock-reset=t2; sgx-account-reauth=t3',
  'a=b=c=d',
];
const NAMES = ['sgx-lock-session', 'sgx-account-session', 'sgx-lock-reauth', 'sgx-lock-reset', 'sgx-account-reauth', 'a', 'x', ''];

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
  const alphabet = ['sgx-lock-session', 'sgx-account-session', '=', ';', ' ', 'a', '.', '"', '%3D', '\t'];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  for (let i = 0; i < 500; i++) {
    let h = '';
    const len = rnd() % 12;
    for (let j = 0; j < len; j++) h += alphabet[rnd() % alphabet.length];
    const r = req(h);
    for (const name of ['sgx-lock-session', 'sgx-account-session', 'a']) {
      assert.equal(readCookie(r, name), oldReadCookie(r, name), JSON.stringify(h));
      assert.deepEqual(readAllCookies(r, name), oldReadAll(r, name), JSON.stringify(h));
    }
  }
});

test('cookies：规则本身（同名按顺序、值里的 = 保留、不解码、区分大小写、没有就是空串）', () => {
  const r = req('x=1; sgx-lock-session=v1; sgx-lock-session=a=b; SGX-LOCK-SESSION=up; s=%2E');
  assert.deepEqual(readAllCookies(r, 'sgx-lock-session'), ['v1', 'a=b']);
  assert.equal(readCookie(r, 'sgx-lock-session'), 'v1');
  assert.equal(readCookie(r, 's'), '%2E');
  assert.equal(readCookie(r, 'missing'), '');
  assert.deepEqual(readAllCookies(r, 'missing'), []);
  assert.equal(readCookie(null, 'x'), '');
  assert.deepEqual(readAllCookies({}, 'x'), []);
  assert.equal(MAX_COOKIE_HEADER, 8192);
});

test('looksVisitor：六段访客票（合法 tempkeyId）才算；五段旧格式、管理员票、坏 tempkeyId 都不算', () => {
  const visitor6 = 'tempkey.visitor.3.9999999999999.AbCdEfGhIjKlMn_-.sig';
  const visitor5 = 'tempkey.visitor.3.9999999999999.sig';
  const admin6 = 'password.admin.3.9999999999999..sig';
  const badId = 'tempkey.visitor.3.9999999999999.short.sig';
  assert.equal(looksVisitor(req('sgx-lock-session=' + visitor6)), true);
  assert.equal(looksVisitor(req('sgx-lock-session=' + visitor5)), false);
  assert.equal(looksVisitor(req('sgx-lock-session=' + admin6)), false);
  assert.equal(looksVisitor(req('sgx-lock-session=' + badId)), false);
  assert.equal(looksVisitor(req()), false);
  /* 同名并存：任一个是访客票就算 */
  assert.equal(looksVisitor(req('sgx-lock-session=' + admin6 + '; sgx-lock-session=' + visitor6)), true);
  /* 名字不对不算 */
  assert.equal(looksVisitor(req('sgx-lock-sessionx=' + visitor6)), false);
});

test('源码守卫：网关里只有 _kernel/cookies.js 自己切 Cookie 头', () => {
  const root = join(REPO, 'workers/auth-gateway');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules') walk(p); } else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(join(root, 'functions'));
  walk(join(root, 'src'));
  const offenders = [];
  for (const f of files) {
    if (f.endsWith('/_kernel/cookies.js')) continue;
    const src = readFileSync(f, 'utf8');
    if (/headers\.get\(\s*['"]cookie['"]\s*\)/i.test(src) && /split\(\s*['"];['"]\s*\)/.test(src)) offenders.push(f.slice(root.length + 1));
  }
  assert.deepEqual(offenders, []);
});
