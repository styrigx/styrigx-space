/**
 * 分层检查器（scripts/check-layers.mjs）和前端规范检查器（scripts/check-frontend.mjs）的单测。
 *
 * - 本仓库现在两者都通过
 * - 以前漏掉的 5 处网关违规（api → api、api → _middleware、src → _middleware、src → api）用原来的 import 写法喂给检查器，必须报错
 * - 解析不到文件的相对 import 报错（以前记成 unknown 放行）
 * - 前端：lib/ → auth/shell/apps、auth/ → shell/apps、shell/ → apps/、前端 → functions/、lib/ 里出现鉴权接口或 navigator.credentials
 * - 每个 Worker 只能 import 自己目录 workers/<名字>/ 下的文件；账号和网关互相不许 import；没有共享目录（2026-10-30）
 * - 注释（含 JSDoc 的 import('…') 类型）不算 import
 * - check-frontend：'https://…' 之后同一行的 alert( 查得到；window['alert'] / globalThis.confirm 查得到；注释里的不算
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const layers = await import(join(REPO, 'scripts/check-layers.mjs'));
const frontend = await import(join(REPO, 'scripts/check-frontend.mjs'));

/** 在临时目录造一个最小仓库：files = { 相对路径: 源码 } */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'sgx-layers-'));
  for (const [rel, src] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}

const GW = 'workers/auth-gateway/';
const FE = 'web/assets/js/';

test('check-layers：本仓库通过', () => {
  const { files, errors } = layers.checkRepo(REPO);
  assert.deepEqual(errors, []);
  assert.ok(files > 130, '扫描了网关 functions/、src/ 和前端：' + files);
});

test('check-frontend：本仓库通过（含 web/shared/shell）', () => {
  const { files, errors } = frontend.checkRepo(REPO);
  assert.deepEqual(errors, []);
  assert.ok(files > 90, String(files));
});

test('check-layers：以前漏掉的 5 处网关违规，用原来的 import 写法都报错', () => {
  const api = (n) => join(REPO, GW + 'functions/api/' + n);
  const src = (n) => join(REPO, GW + 'src/' + n);
  const cases = [
    [api('lock-password.js'), "import { checkLockManage } from './lock-reauth.js';", /functions\/api\/ 只能 import _kernel\/，发现 api/],
    [api('lock-passkey.js'), "import { checkLockManage, TICKET_IDS } from './lock-reauth.js';", /发现 api/],
    [api('lock-all-devices.js'), "import { checkLockManage } from './lock-reauth.js';", /发现 api/],
    [api('lock-session-check.js'), "import { resolveReturn } from '../_middleware.js';", /发现 _middleware/],
    [src('subsites.js'), "import { stripSessionAttrs } from '../functions/_middleware.js';", /src\/ 只能 import/],
    [src('subsites.js'), "import * as searchApi from '../functions/api/search.js';", /src\/ 只能 import/],
  ];
  for (const [file, code, re] of cases) {
    const errs = layers.checkFile(REPO, file, code);
    assert.equal(errs.length, 1, code + ' → ' + JSON.stringify(errs));
    assert.match(errs[0], re);
  }
});

test('check-layers：网关允许的方向（_kernel 内部、api → _kernel、路由表 → api、入口 → middleware、src 内部）', () => {
  const ok = [
    [GW + 'functions/_kernel/return.js', "import { ROLE_VISITOR } from './lock-session.js';"],
    [GW + 'functions/api/lock-reauth.js', "import { TICKET_IDS } from '../_kernel/lock-manage.js';"],
    [GW + 'functions/_middleware.js', "import { resolveReturn } from './_kernel/return.js';"],
    [GW + 'src/routes.js', "import * as search from '../functions/api/search.js';"],
    [GW + 'src/index.js', "import { onRequest } from '../functions/_middleware.js';\nimport { API_ROUTES } from './routes.js';"],
    [GW + 'src/subsites.js', "import { stripSessionAttrs } from '../functions/_kernel/html.js';\nimport { API_ROUTES } from './routes.js';"],
    [GW + 'src/rpc.js', "import { WorkerEntrypoint } from 'cloudflare:workers';"],
  ];
  for (const [rel, code] of ok) assert.deepEqual(layers.checkFile(REPO, join(REPO, rel), code), [], rel);
});

test('check-layers：网关禁止的其他方向', () => {
  const bad = [
    [GW + 'functions/_kernel/realms.js', "import { onRequest } from '../_middleware.js';", /_kernel\/ 只能 import _kernel/],
    [GW + 'functions/_kernel/realms.js', "import * as a from '../api/geo.js';", /_kernel\/ 只能 import _kernel/],
    [GW + 'functions/_middleware.js', "import * as a from './api/geo.js';", /_middleware\.js 只能 import _kernel/],
    [GW + 'src/verifier.js', "import * as a from '../functions/api/geo.js';", /src\/ 只能 import/],
    [GW + 'src/verifier.js', "import { onRequest } from '../functions/_middleware.js';", /src\/ 只能 import/],
    [GW + 'functions/api/geo.js', "import x from 'some-package';", /只能 import 相对路径或 cloudflare:workers/],
    [GW + 'functions/api/geo.js', "import { json } from '../../../account/src/lib/http.js';", /账号和网关互相不许 import/],
    [GW + 'functions/api/geo.js', "import { json } from '../../../share/src/lib/http.js';", /网关目录以外/],
  ];
  for (const [rel, code, re] of bad) {
    const errs = layers.checkFile(REPO, join(REPO, rel), code);
    assert.equal(errs.length, 1, rel + ' ' + code + ' → ' + JSON.stringify(errs));
    assert.match(errs[0], re);
  }
});

const AC = 'workers/account/';

test('check-layers：layerOf 认每个 Worker 目录；网关仍细分层', () => {
  assert.deepEqual(layers.layerOf(REPO, join(REPO, AC + 'src/lib/http.js')), { area: 'worker', layer: 'account', rel: AC + 'src/lib/http.js', worker: 'account' });
  assert.deepEqual(layers.layerOf(REPO, join(REPO, GW + 'functions/_kernel/lib/http.js')), { area: 'gateway', layer: '_kernel', rel: GW + 'functions/_kernel/lib/http.js', worker: 'auth-gateway' });
  assert.equal(layers.layerOf(REPO, join(REPO, 'workers/chat/src/index.js')).worker, 'chat');
});

test('check-layers：workers/ 下每个目录都是一个 Worker（有自己的 wrangler.toml，没有跨 Worker 的共享目录），扫描覆盖所有 Worker 目录', () => {
  const dirs = readdirSync(join(REPO, 'workers'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(dirs.includes('account') && dirs.includes('auth-gateway'));
  for (const d of dirs) assert.ok(existsSync(join(REPO, 'workers', d, 'wrangler.toml')), d + ' 不是 Worker 目录');
  const root = fixture({
    [AC + 'src/a.js']: "import { b } from './lib/b.js';",
    [AC + 'src/lib/b.js']: 'export const b = 1;',
    ['workers/chat/src/index.js']: "import { r } from './lock-identity.js';",
    ['workers/chat/src/lock-identity.js']: 'export const r = 1;',
  });
  try {
    const { files, errors } = layers.checkRepo(root);
    assert.equal(files, 4);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-layers：交叉 import 一律失败——账号 ↔ 网关（任何层）、Worker 之间、Worker 以外的公共目录', () => {
  const root = fixture({
    [AC + 'src/x.js']: "import { a } from '../../auth-gateway/functions/_kernel/lib/http.js';",
    [AC + 'src/y.js']: "export { s } from '../../auth-gateway/src/index.js';",
    [GW + 'functions/_kernel/lib/http.js']: 'export const a = 1;',
    [GW + 'src/index.js']: 'export const s = 1;',
    [GW + 'functions/_kernel/k.js']: "import { b } from '../../../account/src/lib/b.js';",
    [GW + 'functions/api/p.js']: "const m = await import('../../../account/src/lib/b.js');",
    [GW + 'src/v.js']: "import { b } from '../../account/src/lib/b.js';",
    [AC + 'src/lib/b.js']: 'export const b = 1;',
    ['workers/share/src/auth.js']: "export { authFor } from '../../account/src/lib/b.js';",
    ['workers/chat/src/index.js']: "import { h } from '../../common/lock-identity.js';",
    ['workers/common/lock-identity.js']: 'export const h = 1;',
    [GW + 'src/w.js']: "import { h } from '../../common/lock-identity.js';",
  });
  try {
    const { errors } = layers.checkRepo(root);
    const by = (f) => errors.filter((e) => e.startsWith(f + ':'));
    for (const f of [AC + 'src/x.js', AC + 'src/y.js', GW + 'functions/_kernel/k.js', GW + 'functions/api/p.js', GW + 'src/v.js']) {
      assert.equal(by(f).length, 1, f + ' → ' + JSON.stringify(errors));
      assert.match(by(f)[0], /账号和网关互相不许 import/);
    }
    assert.match(by('workers/share/src/auth.js')[0], /只能 import 自己目录 workers\/share\//);
    assert.match(by('workers/chat/src/index.js')[0], /只能 import 自己目录 workers\/chat\//);
    assert.match(by(GW + 'src/w.js')[0], /网关禁止 import 网关目录以外的文件/);
    assert.equal(errors.length, 8, errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-layers：Worker 的非相对 import 只认 cloudflare:workers；注释里的不算', () => {
  const f = join(REPO, AC + 'src/entrypoints.js');
  assert.deepEqual(layers.checkFile(REPO, f, "import { WorkerEntrypoint } from 'cloudflare:workers';"), []);
  assert.match(layers.checkFile(REPO, f, "import x from 'some-package';")[0], /只能 import 相对路径或 cloudflare:workers/);
  assert.deepEqual(layers.checkFile(REPO, f, "// import { a } from '../../auth-gateway/src/index.js';"), []);
  assert.match(layers.checkFile(REPO, f, "import { x } from './no-such-file.js';")[0], /import 的文件不存在/);
});

test('check-layers：网关 functions/ 杂项文件仍报错；_kernel/lib 属于 _kernel', () => {
  const a = layers.checkFile(REPO, join(REPO, GW + 'functions/api/geo.js'), "import { json } from '../_kernel/lib/http.js';");
  assert.deepEqual(a, []);
  const b = layers.checkFile(REPO, join(REPO, GW + 'functions/misc.js'), "import { json } from './_kernel/lib/http.js';");
  assert.equal(b.length, 1);
  assert.match(b[0], /functions\/ 下只允许/);
});

test('check-layers：解析不到的相对 import 报错（不再按 unknown 放行）', () => {
  const errs = layers.checkFile(REPO, join(REPO, GW + 'functions/api/geo.js'), "import { x } from './no-such-file.js';");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /import 的文件不存在/);
  const errs2 = layers.checkFile(REPO, join(REPO, FE + 'shell/nav.js'), "import { x } from './scheduler.js';");
  assert.match(errs2[0], /import 的文件不存在/);
});

test('check-layers：export … from 和动态 import() 也算', () => {
  const a = layers.checkFile(REPO, join(REPO, GW + 'functions/api/geo.js'), "export { checkLockManage } from './lock-reauth.js';");
  assert.equal(a.length, 1);
  const b = layers.checkFile(REPO, join(REPO, GW + 'functions/api/geo.js'), "const m = await import('../_middleware.js');");
  assert.equal(b.length, 1);
  const c = layers.checkFile(REPO, join(REPO, FE + 'lib/util.js'), "export * from '../shell/core.js';");
  assert.equal(c.length, 1);
});

test('check-layers：注释里的 import（含 JSDoc 类型）不算', () => {
  const code = [
    "/** @param {import('../shell/core.js').X} a */",
    "// import { initCore } from '../shell/core.js';",
    "/* import * as x from '../apps/chat.js'; */",
    "const u = 'https://example.com/x'; // import('../apps/chat.js')",
  ].join('\n');
  assert.deepEqual(layers.checkFile(REPO, join(REPO, FE + 'lib/util.js'), code), []);
});

test('check-layers：前端层方向', () => {
  const root = fixture({
    [FE + 'lib/a.js']: "import { b } from './b.js';\nimport { s } from '../shell/s.js';\nimport { x } from '../auth/x.js';\nimport { p } from '../apps/p.js';",
    [FE + 'lib/b.js']: 'export const b = 1;',
    [FE + 'auth/x.js']: "import { b } from '../lib/b.js';\nimport { y } from './y.js';\nimport { s } from '../shell/s.js';\nimport { p } from '../apps/p.js';",
    [FE + 'auth/y.js']: 'export const y = 1;',
    [FE + 'shell/s.js']: "import { x } from '../auth/x.js';\nimport { b } from '../lib/b.js';\nimport { p } from '../apps/p.js';",
    [FE + 'apps/p.js']: "import { s } from '../shell/s.js';\nimport { x } from '../auth/x.js';\nimport { e } from '../entries/e.js';",
    [FE + 'entries/e.js']: "import { p } from '../apps/p.js';\nimport { k } from '../../../../workers/auth-gateway/functions/_kernel/k.js';",
    [GW + 'functions/_kernel/k.js']: 'export const k = 1;',
  });
  try {
    const { errors } = layers.checkRepo(root);
    const want = [
      'web/assets/js/lib/a.js: lib/ 禁止 import shell/',
      'web/assets/js/lib/a.js: lib/ 禁止 import auth/',
      'web/assets/js/lib/a.js: lib/ 禁止 import apps/',
      'web/assets/js/auth/x.js: auth/ 禁止 import shell/',
      'web/assets/js/auth/x.js: auth/ 禁止 import apps/',
      'web/assets/js/shell/s.js: shell/ 禁止 import apps/',
      'web/assets/js/apps/p.js: apps/ 禁止 import entries/',
      'web/assets/js/entries/e.js: 前端禁止 import web/assets/js/ 以外的文件',
    ];
    for (const w of want) assert.ok(errors.some((e) => e.startsWith(w)), '缺：' + w + '\n' + errors.join('\n'));
    assert.equal(errors.length, want.length, errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-layers：lib/ 不得包含鉴权逻辑（鉴权接口地址、navigator.credentials）；auth/ 可以', () => {
  const lib = join(REPO, FE + 'lib/util.js');
  for (const code of [
    "fetch('/api/lock-now', { method: 'POST' });",
    "fetch('/api/root-auth');",
    "const ACCOUNT_API = '/api/account';",
    'navigator.credentials.get({ publicKey: o });',
  ]) {
    const errs = layers.checkFile(REPO, lib, code);
    assert.equal(errs.length, 1, code);
    assert.match(errs[0], /lib\/ 不得包含鉴权逻辑/);
  }
  assert.deepEqual(layers.checkFile(REPO, lib, "fetch('/api/status'); fetch('/api/accounting-x'); // /api/lock-now"), []);
  assert.deepEqual(layers.checkFile(REPO, join(REPO, FE + 'auth/lock-now.js'), "fetch('/api/lock-now');"), []);
});

test('check-layers：前端 cookie 名 / sgx-lock-shown / storage 存解锁状态', () => {
  const f = join(REPO, FE + 'apps/chat.js');
  assert.match(layers.checkFile(REPO, f, "document.cookie.includes('sgx-lock-session')")[0], /sgx-lock-session/);
  assert.deepEqual(layers.checkFile(REPO, f, "el.getAttribute('data-sgx-lock-session')"), []);
  assert.match(layers.checkFile(REPO, f, "sessionStorage.setItem('sgx-lock-shown', '1')").join('\n'), /sgx-lock-shown/);
  assert.match(layers.checkFile(REPO, f, "localStorage.setItem('unlocked', '1')")[0], /解锁状态/);
  assert.match(layers.checkFile(REPO, f, "setJSON('sgx-unlock-at', 1)")[0], /setJSON/);
  assert.deepEqual(layers.checkFile(REPO, f, "// localStorage.setItem('unlocked', '1')"), []);
});

test('check-frontend：原生弹窗的各种写法', () => {
  const bad = [
    "alert('x');",
    "window.confirm('x');",
    "globalThis.prompt('x');",
    "self.alert('x');",
    "window['alert']('x');",
    'window["confirm"](1);',
    "const u = 'https://styrigx.com/'; alert(u);",
  ];
  for (const code of bad) {
    const errs = frontend.checkSource('web/assets/js/apps/x.js', code);
    assert.equal(errs.length, 1, code + ' → ' + JSON.stringify(errs));
    assert.match(errs[0], /禁止原生弹窗/);
  }
  for (const code of [
    "// alert('x')",
    "/* window.confirm('x') */",
    "confirmLockNow();",
    "const u = 'https://a/'; // alert(u)",
  ]) {
    assert.deepEqual(frontend.checkSource('web/assets/js/apps/x.js', code), [], code);
  }
});

test('check-frontend：行号按原文（多行块注释之后）', () => {
  const errs = frontend.checkSource('web/assets/js/apps/x.js', "/* a\n b\n c */\nconst s = 'http://x';\nalert(s);");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^web\/assets\/js\/apps\/x\.js:5:/);
});

test('check-frontend：独立 token 变量', () => {
  for (const code of ['let token = 1;', 'token = x;', 'function f(token) {}', '(token) => token', 'post({ token: t })', 'post({ a, token })']) {
    assert.equal(frontend.checkSource('web/assets/js/apps/x.js', code).length, 1, code);
  }
  for (const code of ['const csrfToken = 1;', 'submitToken(token2);', "// let token = 1"]) {
    assert.deepEqual(frontend.checkSource('web/assets/js/apps/x.js', code), [], code);
  }
});

test('stripComments：字符串里的 // 和 /* 不当注释', () => {
  assert.equal(layers.stripComments("a('https://x/*y') // c\nb"), "a('https://x/*y') \nb");
  assert.equal(frontend.stripComments("x = '//'; // c"), "x = '//';     ");
});
