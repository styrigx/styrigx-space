/**
 * 分层检查器（space/scripts/check-layers.mjs）和前端规范检查器（space/scripts/check-frontend.mjs）的单测。
 *
 * - 本仓库现在两者都通过
 * - 解析不到文件的相对 import 报错（以前记成 unknown 放行）
 * - 前端：lib/ → auth/shell/apps、auth/ → shell/apps、shell/ → apps/、前端 → functions/、lib/ 里出现鉴权接口或 navigator.credentials
 * - 每个 Worker 只能 import 自己目录 workers/<名字>/ 下的文件；账号和网关互相不许 import；没有共享目录（2026-10-30）
 * - 注释（含 JSDoc 的 import('…') 类型）不算 import
 * - Worker 边界（账号拆分 PR3e）：规则 15 不许有 workers/shared；规则 16 网关源码（含 wrangler.toml，注释除外）不许出现账号鉴权标识；
 *   规则 17 账号 Worker 的 wrangler.toml 不许有路由。每条都故意违反一次，检查必须报错
 * - check-frontend：'https://…' 之后同一行的 alert( 查得到；window['alert'] / globalThis.confirm 查得到；注释里的不算
 * - check-frontend 规则 3：openSheet( 只许白名单文件（P4-3 §6.7 不做底部弹出窗口）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const layers = await import(join(REPO, 'space/scripts/check-layers.mjs'));
const frontend = await import(join(REPO, 'space/scripts/check-frontend.mjs'));

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

const GW = 'workers/space-core/';

/** 规则 19–21 要的骨架文件（README.md、带 name 的 package.json）：fixture 里的 Worker 目录有 wrangler.toml 时补上，免得干扰别的规则 @param {string} dir 如 'workers/account/' */
const skeletonFiles = (dir) => ({ [dir + 'README.md']: '# x\n', [dir + 'package.json']: '{"name":"x","private":true,"type":"module"}' });
const FE = 'space/web/assets/shell/js/';

test('check-layers：本仓库通过', () => {
  const { files, errors } = layers.checkRepo(REPO);
  assert.deepEqual(errors, []);
  assert.ok(files > 130, '扫描了各 Worker 的 src/ 和前端：' + files);
});

test('check-frontend：本仓库通过（含 space/web/shared/shell）', () => {
  const { files, errors } = frontend.checkRepo(REPO);
  assert.deepEqual(errors, []);
  assert.ok(files > 80, String(files)); /* 2026-11-08 账号整页（apps/account*.js 7 个 + entries 6 个）删了，账号终端在 shell/account/ */
});

test('check-layers：网关禁止的 import（外部包、账号、其他 Worker）', () => {
  const bad = [
    [GW + 'src/api/geo.js', "import x from 'some-package';", /只能 import 相对路径或 cloudflare:workers/],
    [GW + 'src/api/geo.js', "import { json } from '../../../account/src/lib/http.js';", /账号和网关互相不许 import/],
    [GW + 'src/api/geo.js', "import { json } from '../../../status/src/index.js';", /网关目录以外/],
  ];
  for (const [rel, code, re] of bad) {
    const errs = layers.checkFile(REPO, join(REPO, rel), code);
    assert.equal(errs.length, 1, rel + ' ' + code + ' → ' + JSON.stringify(errs));
    assert.match(errs[0], re);
  }
});

const AC = 'workers/account/';

test('check-layers：layerOf 认每个 Worker 目录', () => {
  assert.deepEqual(layers.layerOf(REPO, join(REPO, AC + 'src/lib/http.js')), { area: 'worker', layer: 'account', rel: AC + 'src/lib/http.js', worker: 'account' });
  assert.deepEqual(layers.layerOf(REPO, join(REPO, GW + 'src/lib/http.js')), { area: 'gateway', layer: 'src', rel: GW + 'src/lib/http.js', worker: 'space-core' });
  assert.equal(layers.layerOf(REPO, join(REPO, 'workers/chat/src/index.js')).worker, 'chat');
});

test('check-layers：workers/ 下每个目录都是一个 Worker（有自己的 wrangler.toml，没有跨 Worker 的共享目录），扫描覆盖所有 Worker 目录', () => {
  const dirs = readdirSync(join(REPO, 'workers'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(dirs.includes('account') && dirs.includes('space-core'));
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
    [AC + 'src/x.js']: "import { a } from '../../space-core/src/lib/http.js';",
    [AC + 'src/y.js']: "export { s } from '../../space-core/src/index.js';",
    [GW + 'src/lib/http.js']: 'export const a = 1;',
    [GW + 'src/index.js']: 'export const s = 1;',
    [GW + 'src/core/k.js']: "import { b } from '../../../account/src/lib/b.js';",
    [GW + 'src/api/p.js']: "const m = await import('../../../account/src/lib/b.js');",
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
    for (const f of [AC + 'src/x.js', AC + 'src/y.js', GW + 'src/core/k.js', GW + 'src/api/p.js', GW + 'src/v.js']) {
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
  const f = join(REPO, AC + 'src/rpc/account-service.js');
  assert.deepEqual(layers.checkFile(REPO, f, "import { WorkerEntrypoint } from 'cloudflare:workers';"), []);
  assert.match(layers.checkFile(REPO, f, "import x from 'some-package';")[0], /只能 import 相对路径或 cloudflare:workers/);
  assert.deepEqual(layers.checkFile(REPO, f, "// import { a } from '../../space-core/src/index.js';"), []);
  assert.match(layers.checkFile(REPO, f, "import { x } from './no-such-file.js';")[0], /import 的文件不存在/);
});

test('check-layers：解析不到的相对 import 报错（不再按 unknown 放行）', () => {
  const errs = layers.checkFile(REPO, join(REPO, GW + 'src/api/geo.js'), "import { x } from './no-such-file.js';");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /import 的文件不存在/);
  const errs2 = layers.checkFile(REPO, join(REPO, FE + 'shell/nav.js'), "import { x } from './scheduler.js';");
  assert.match(errs2[0], /import 的文件不存在/);
});

test('check-layers：export … from 和动态 import() 也算', () => {
  const a = layers.checkFile(REPO, join(REPO, GW + 'src/api/geo.js'), "export { json } from '../../../account/src/lib/http.js';");
  assert.equal(a.length, 1);
  const b = layers.checkFile(REPO, join(REPO, GW + 'src/api/geo.js'), "const m = await import('../../../share/src/lib/http.js');");
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
    [FE + 'entries/e.js']: "import { p } from '../apps/p.js';\nimport { k } from '../../../../../workers/space-core/src/core/k.js';",
    [GW + 'src/core/k.js']: 'export const k = 1;',
  });
  try {
    const { errors } = layers.checkRepo(root);
    const want = [
      'space/web/assets/shell/js/lib/a.js: lib/ 禁止 import shell/',
      'space/web/assets/shell/js/lib/a.js: lib/ 禁止 import auth/',
      'space/web/assets/shell/js/lib/a.js: lib/ 禁止 import apps/',
      'space/web/assets/shell/js/auth/x.js: auth/ 禁止 import shell/',
      'space/web/assets/shell/js/auth/x.js: auth/ 禁止 import apps/',
      'space/web/assets/shell/js/shell/s.js: shell/ 禁止 import apps/',
      'space/web/assets/shell/js/apps/p.js: apps/ 禁止 import entries/',
      'space/web/assets/shell/js/entries/e.js: 前端禁止 import space/web/assets/shell/js/ 以外的文件',
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
    "fetch('/api/space-auth');",
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
  assert.match(layers.checkFile(REPO, f, "document.cookie.includes('sgx-space-session')")[0], /sgx-space-session/);
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
    const errs = frontend.checkSource('space/web/assets/shell/js/apps/x.js', code);
    assert.equal(errs.length, 1, code + ' → ' + JSON.stringify(errs));
    assert.match(errs[0], /禁止原生弹窗/);
  }
  for (const code of [
    "// alert('x')",
    "/* window.confirm('x') */",
    "confirmLockNow();",
    "const u = 'https://a/'; // alert(u)",
  ]) {
    assert.deepEqual(frontend.checkSource('space/web/assets/shell/js/apps/x.js', code), [], code);
  }
});

test('check-frontend：行号按原文（多行块注释之后）', () => {
  const errs = frontend.checkSource('space/web/assets/shell/js/apps/x.js', "/* a\n b\n c */\nconst s = 'http://x';\nalert(s);");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^space\/web\/assets\/shell\/js\/apps\/x\.js:5:/);
});

test('check-frontend：独立 token 变量', () => {
  for (const code of ['let token = 1;', 'token = x;', 'function f(token) {}', '(token) => token', 'post({ token: t })', 'post({ a, token })']) {
    assert.equal(frontend.checkSource('space/web/assets/shell/js/apps/x.js', code).length, 1, code);
  }
  for (const code of ['const csrfToken = 1;', 'submitToken(token2);', "// let token = 1"]) {
    assert.deepEqual(frontend.checkSource('space/web/assets/shell/js/apps/x.js', code), [], code);
  }
});

test('check-frontend 规则 3：openSheet( 只许白名单文件（P4-3 §6.7 不做底部弹出窗口）', () => {
  /* 白名单外：调用、改名 import 都拦；报错带行号和规则号 */
  for (const code of ["openSheet({ title: 'x' });", "import { openSheet } from '../shell/sheet.js';\nopenSheet({});", "import { openSheet as os } from '../shell/sheet.js';", 'const u = 1;\nopenSheet ({})']) {
    const errs = frontend.checkSource('space/web/assets/shell/js/apps/new-app.js', code);
    assert.equal(errs.length, 1, code + ' → ' + JSON.stringify(errs));
    assert.match(errs[0], /规则 3/);
  }
  assert.match(frontend.checkSource('space/web/assets/shell/js/apps/x.js', 'const u = 1;\nopenSheet({});')[0], /^space\/web\/assets\/shell\/js\/apps\/x\.js:2:/);
  /* 只 import 不调用、注释里、别的名字不算 */
  for (const code of ["import { closeSheet } from '../shell/sheet.js';", '// openSheet({})', '/* openSheet({}) */', 'openSheetLater();', 'reopenSheet();']) {
    assert.deepEqual(frontend.checkSource('space/web/assets/shell/js/apps/new-app.js', code), [], code);
  }
  /* 账号页 AI 模型已改行内展开：account-ai.js 不在白名单，再调就拦 */
  assert.equal(frontend.SHEET_ALLOW.has('space/web/assets/shell/js/apps/account-ai.js'), false);
  assert.equal(frontend.checkSource('space/web/assets/shell/js/apps/account-ai.js', 'openSheet({});').length, 1);
  /* 白名单里照常放行；PR-4b 语言选择改行内后 settings.js 已删、移出白名单，旷野页 space.js 不在白名单 */
  assert.equal(frontend.SHEET_ALLOW.has('space/web/assets/shell/js/apps/settings.js'), false);
  assert.equal(frontend.SHEET_ALLOW.has('space/web/assets/shell/js/apps/space.js'), false);
  /* 2026-11-08 账号整页删了、头像改成账号终端里的行内选项：白名单只剩 sheet.js 本身 */
  for (const f of ['space/web/assets/shell/js/apps/account.js', 'space/web/assets/shell/js/apps/account-apps.js', 'space/web/assets/shell/js/apps/avatar-edit.js', 'space/web/assets/shell/js/shell/account/avatar-edit.js']) {
    assert.equal(frontend.SHEET_ALLOW.has(f), false, f);
  }
  for (const f of ['space/web/assets/shell/js/shell/sheet.js']) {
    assert.ok(frontend.SHEET_ALLOW.has(f), f);
    assert.deepEqual(frontend.checkSource(f, 'openSheet({});'), [], f);
  }
  assert.equal(frontend.SHEET_ALLOW.size, 1, '白名单只减不增');
  /* 共享外壳（子站用）也在扫描范围里 */
  assert.equal(frontend.checkSource('space/web/shared/shell/topbar.js', 'openSheet({});').length, 1);
});

/* ---------------- Worker 边界（规则 15-17，账号拆分 PR3e） ---------------- */

test('规则 15：workers/shared 目录存在就失败；import workers/shared/ 也失败（文件不存在时同样给规则 15 的信息）', () => {
  const root = fixture({
    ['workers/shared/lock-identity.js']: 'export const h = 1;',
    ['workers/chat/src/index.js']: "import { h } from '../../shared/lock-identity.js';",
    [AC + 'src/a.js']: "import { h } from '../../shared/gone.js';",
  });
  try {
    const { errors } = layers.checkRepo(root);
    assert.ok(errors.includes('workers/shared: 不许存在（规则 15：2026-10-30 起没有跨 Worker 的共享目录，每个 Worker 各自实现）'), errors.join('\n'));
    assert.match(errors.find((e) => e.startsWith('workers/chat/src/index.js:')), /禁止 import workers\/shared（规则 15/);
    assert.match(errors.find((e) => e.startsWith(AC + 'src/a.js:')), /禁止 import workers\/shared（规则 15/);
    assert.equal(errors.length, 3, errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(join(REPO, 'workers/shared')), false, '本仓库没有 workers/shared');
});

/* PR3d 的残留 grep 列表（网关里删光的账号鉴权标识），每个都必须被规则 16 抓到 */
const ACCOUNT_AUTH_IDS = [
  'SGX_ACCOUNT_PRIVATE', 'SGX_ACCOUNT_PUBLIC', 'SGX_ACCOUNT_ROOT_KEY', 'SGX_ACCOUNT_RECOVERY_KEY', 'SGX_ACCOUNT_PASSWORD_PEPPER', 'SGX_ROOT_KEY',
  'D1_ACCOUNT', 'D1_ACCOUNT_AUTH', 'D1_ROOT_AUTH', 'REALM_ACCOUNT', 'REALM_ROOT', 'BY_ACCOUNT', 'PASSKEY_ACCOUNT',
  'checkAccountSession', 'verifyAccountSession', 'issueAccountSession', 'clearAccountSession',
  'AccountSessionTicket', 'AccountReauthTicket', 'AccountResetTicket', 'signAccountReauthTicket', 'verifyAccountResetTicket',
  'ACCOUNT_SESSION_TICKET', 'ACCOUNT_REAUTH_TICKET', 'ACCOUNT_RESET_COOKIE', 'ACCOUNT_EPOCH', 'bumpAccountEpoch',
  'accountKeysReady', 'isAccountEffectivelyConfigured',
];

test('规则 16：网关源码里出现任一账号鉴权标识都报错，信息带文件:行号、标识和规则号', () => {
  const f = join(REPO, GW + 'src/rpc/space-verifier.js');
  for (const id of ACCOUNT_AUTH_IDS) {
    const errs = layers.checkFile(REPO, f, `const x = ${id};`);
    assert.equal(errs.length, 1, id + ' → ' + JSON.stringify(errs));
    assert.equal(errs[0], `${GW}src/rpc/space-verifier.js:1: 网关源码禁止出现账号鉴权标识 ${id}（规则 16：账号鉴权只在 workers/account/，网关只经 ACCOUNT_VERIFIER.authorize() 拿结论）`);
  }
  const cookie = layers.checkFile(REPO, join(REPO, GW + 'src/api/lock-now.js'), "clear('sgx-account-reauth');");
  assert.match(cookie[0], /账号鉴权标识 sgx-account-reauth/);
  /* 多行块注释之后，行号仍按原文 */
  const ln = layers.checkFile(REPO, join(REPO, GW + 'src/core/realms.js'), "/* a\n b\n */\nconst ok = 1;\nexport const r = env.SGX_ROOT_KEY;");
  assert.equal(ln.length, 1);
  assert.match(ln[0], /^workers\/space-core\/src\/core\/realms\.js:5: .*SGX_ROOT_KEY/);
});

test('规则 16：注释、ACCOUNT_VERIFIER.authorize()、首帧提示属性名不算；账号 Worker 自己用这些标识不算', () => {
  const f = join(REPO, GW + 'src/core/account-rpc.js');
  for (const code of [
    '// SGX_ACCOUNT_ROOT_KEY 只绑在账号 Worker',
    '/* 原来的 REALM_ROOT、D1_ROOT_AUTH 已删；AccountReauthTicket 在账号 Worker */',
    '/** @see checkAccountSession */ export const a = 1;',
    "const r = await env.ACCOUNT_VERIFIER.authorize(cookie, ctx);",
    "html.replace('<html', '<html data-sgx-account-session=\"in\"');",
    "const u = 'https://x/'; // verifyAccountSession",
  ]) {
    assert.deepEqual(layers.checkFile(REPO, f, code), [], code);
  }
  assert.deepEqual(layers.checkFile(REPO, join(REPO, AC + 'src/rpc/account-verifier.js'), "import { verifySession } from '../core/identity-session.js';\nconst k = env.SGX_ACCOUNT_RECOVERY_KEY;"), []);
});

test('规则 22：账号 Worker / 账号前端里出现退役旧名（含注释）报错；别处不管；名单只在 retired-names.json', () => {
  const errs = layers.checkFile(REPO, join(REPO, AC + 'src/core/session.js'), "// 原来叫 verifyAccountSession\nconst a = 'root-reset';\nconst b = 'reset-recovery-key';");
  assert.deepEqual(errs.map((e) => e.replace(/（.*$/, '')).sort(), [AC + 'src/core/session.js:1: 退役旧名 verifyAccountSession', AC + 'src/core/session.js:2: 退役旧名 root-reset'].sort());
  assert.deepEqual(layers.checkFile(REPO, join(REPO, 'space/web/assets/shell/js/shell/account/api.js'), "post('/api/account/session', { action: 'password' })"), []);
  assert.ok(layers.checkFile(REPO, join(REPO, 'space/web/assets/shell/js/shell/account/api.js'), "post('/api/account', { action: 'login-password' })").some((e) => /login-password/.test(e)));
  assert.deepEqual(layers.checkFile(REPO, join(REPO, 'space/scripts/x.mjs'), "const a = 'root-reset';"), [], '范围外不管');
  assert.ok(layers.retiredNames().includes('SGX_ACCOUNT_ROOT_KEY'));
});

test('规则 16：网关 wrangler.toml 去掉 # 注释后也查；checkRepo 会读它', () => {
  const rel = GW + 'wrangler.toml';
  assert.deepEqual(layers.checkGatewayAccountAuth(rel, '# 原来的 D1_ACCOUNT_AUTH / D1_ROOT_AUTH 两个绑定名删掉\nbinding = "D1_SPACE" # 不是 SGX_ROOT_KEY', 'toml'), []);
  const bad = layers.checkGatewayAccountAuth(rel, '[[secrets_store_secrets]]\nbinding = "SGX_ACCOUNT_PRIVATE"\nsecret_name = "SGX_ACCOUNT_PRIVATE" # 注释', 'toml');
  assert.equal(bad.length, 2, bad.join('\n'));
  assert.match(bad[0], /^workers\/space-core\/wrangler\.toml:2: 网关源码禁止出现账号鉴权标识 SGX_ACCOUNT_PRIVATE（规则 16/);
  const root = fixture({
    [GW + 'wrangler.toml']: 'name = "styrigx-space-core"\nmain = "src/index.js"\n[[d1_databases]]\nbinding = "D1_ROOT_AUTH"\n',
    [GW + 'src/index.js']: "export const k = 'SGX_SPACE_RECOVERY_KEY';",
    ...skeletonFiles(GW),
  });
  try {
    const { errors } = layers.checkRepo(root);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /^workers\/space-core\/wrangler\.toml:4: .*D1_ROOT_AUTH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('规则 17：账号 Worker 的 wrangler.toml 不许有路由（[[routes]]、env 下的 routes、route =、非空 routes）；routes = [] 和注释允许', () => {
  const rel = AC + 'wrangler.toml';
  const bad = [
    '[[routes]]\npattern = "styrigx.com/api/prefs*"\nzone_name = "styrigx.com"',
    '[[env.preview.routes]]\npattern = "x.styrigx.com/*"',
    'route = "styrigx.com/avatar/*"',
    'routes = [ { pattern = "styrigx.com/api/avatar*", zone_name = "styrigx.com" } ]',
    'routes = [\n  "styrigx.com/api/wellbeing*",\n]',
    '[env.preview]\nroutes = ["styrigx.com/*"]',
    'env.preview.routes = ["styrigx.com/*"]',
  ];
  for (const src of bad) {
    const errs = layers.checkAccountToml(rel, src);
    assert.equal(errs.length, 1, src + ' → ' + JSON.stringify(errs));
    assert.match(errs[0], /^workers\/account\/wrangler\.toml:\d+: 账号 Worker 不许有公开路由，发现「.+」（规则 17：/);
  }
  for (const src of [
    '[env.preview]\nworkers_dev = false\nroutes = []',
    '# [[routes]] 已删\n# route = "styrigx.com/avatar/*"',
    'name = "styrigx-account" # routes = ["x"]',
    'main = "src/worker.js"',
  ]) {
    assert.deepEqual(layers.checkAccountToml(rel, src), [], src);
  }
  const root = fixture({ [rel]: 'name = "styrigx-account"\nmain = "src/index.js"\n[[routes]]\npattern = "styrigx.com/avatar/*"\n', ...skeletonFiles(AC) });
  try {
    const { errors } = layers.checkRepo(root);
    assert.deepEqual(errors, ['workers/account/wrangler.toml:3: 账号 Worker 不许有公开路由，发现「[[routes]]」（规则 17：账号请求只经网关服务绑定 ACCOUNT 进来，路径在 workers/space-core/src/router.js 登记）']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('规则 16、17：本仓库的网关源码和两个 wrangler.toml 都通过（账号 Worker 0 条路由，网关里没有账号鉴权标识）', () => {
  const gw = layers.walk(join(REPO, GW));
  assert.ok(gw.length >= 20, String(gw.length)); /* v6 P4 删进站签发 / 分享短链 / lock 接口后网关剩 24 个文件 */
  const errs = [];
  for (const f of gw) errs.push(...layers.checkGatewayAccountAuth(f, readFileSync(f, 'utf8')));
  errs.push(...layers.checkGatewayAccountAuth(GW + 'wrangler.toml', readFileSync(join(REPO, GW + 'wrangler.toml'), 'utf8'), 'toml'));
  errs.push(...layers.checkAccountToml(AC + 'wrangler.toml', readFileSync(join(REPO, AC + 'wrangler.toml'), 'utf8')));
  assert.deepEqual(errs, []);
});

test('maskComments：注释换成空格、换行保留；字符串里的 // 不当注释', () => {
  assert.equal(layers.maskComments("a /* x\ny */ b // c\nd"), "a     \n     b     \nd");
  assert.equal(layers.maskComments("u = 'https://x'; // c"), "u = 'https://x';     ");
  assert.equal(layers.stripTomlComments('a = "x#y" # c\n# d\nb = 1'), 'a = "x#y" \n\nb = 1');
});

test('stripComments：字符串里的 // 和 /* 不当注释', () => {
  assert.equal(layers.stripComments("a('https://x/*y') // c\nb"), "a('https://x/*y') \nb");
  assert.equal(frontend.stripComments("x = '//'; // c"), "x = '//';     ");
});

/* ---------------- 规则 18–21：Worker 骨架防回退（2026-11-02） ---------------- */

/** 一个合规的最小 Worker（wrangler.toml main = src/index.js、README.md、带 name 的 package.json） */
const okWorker = (w) => ({
  [`workers/${w}/wrangler.toml`]: `name = "styrigx-${w}"\nmain = "src/index.js"\n`,
  [`workers/${w}/src/index.js`]: 'export default {};',
  ...skeletonFiles(`workers/${w}/`),
});

test('规则 18–21：本仓库每个 Worker 都通过；合规的最小 Worker 不报错', () => {
  assert.deepEqual(layers.checkWorkerSkeleton(REPO), []);
  const root = fixture(okWorker('demo'));
  try {
    assert.deepEqual(layers.checkRepo(root).errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('规则 18：workers/** 下出现 functions/ 或 _kernel/（任何深度）都报错', () => {
  const root = fixture({
    ...okWorker('demo'),
    'workers/demo/functions/_middleware.js': 'export const a = 1;',
    'workers/demo/src/_kernel/lib/http.js': 'export const b = 1;',
  });
  try {
    const errs = layers.checkWorkerSkeleton(root).sort();
    assert.equal(errs.length, 2, errs.join('\n'));
    assert.match(errs[0], /^workers\/demo\/functions: 不许有 functions\/ 目录（规则 18/);
    assert.match(errs[1], /^workers\/demo\/src\/_kernel: 不许有 _kernel\/ 目录（规则 18/);
    assert.ok(layers.checkRepo(root).errors.some((e) => /规则 18/.test(e)), 'checkRepo 也报');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('规则 19：wrangler.toml 的 main 必须是 src/index.js（旧的 src/worker.js、没写都报；注释和 [env.*] 里的不算）', () => {
  for (const [toml, re] of [
    ['name = "styrigx-demo"\nmain = "src/worker.js"\n', /main 必须是 "src\/index\.js"，现在是 "src\/worker\.js"（规则 19）/],
    ['name = "styrigx-demo"\n# main = "src/index.js"\n', /现在是 （没写）（规则 19）/],
    ['name = "styrigx-demo"\n[env.preview]\nmain = "src/index.js"\n', /现在是 （没写）（规则 19）/],
  ]) {
    const root = fixture({ ...okWorker('demo'), 'workers/demo/wrangler.toml': toml });
    try {
      const errs = layers.checkWorkerSkeleton(root);
      assert.equal(errs.length, 1, toml + ' → ' + JSON.stringify(errs));
      assert.match(errs[0], re);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('规则 20、21：缺 README.md、package.json 没有 name（或坏 JSON、没有文件）都报错', () => {
  const root = fixture({
    ...okWorker('a'), ...okWorker('b'), ...okWorker('c'), ...okWorker('d'),
    'workers/b/package.json': '{ "private": true, "type": "module" }',
    'workers/c/package.json': '{ name: broken',
  });
  rmSync(join(root, 'workers/a/README.md'));
  rmSync(join(root, 'workers/d/package.json'));
  try {
    const errs = layers.checkWorkerSkeleton(root);
    assert.deepEqual(errs, [
      'workers/a: 缺 README.md（规则 20）',
      'workers/b/package.json: 必须有 name（规则 21）',
      'workers/c/package.json: 必须有 name（规则 21）',
      'workers/d/package.json: 必须有 name（规则 21）',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('规则 19–21 只管带 wrangler.toml 的目录：没有 wrangler.toml 的目录缺 main / README / name 都不报（规则 18 照查）', () => {
  const root = fixture({
    ...okWorker('demo'),
    'workers/notes/scratch.txt': 'x',
    'workers/notes/package.json': '{ "private": true }',
  });
  try {
    assert.deepEqual(layers.checkWorkerSkeleton(root), []);
    mkdirSync(join(root, 'workers/notes/_kernel'), { recursive: true });
    const errs = layers.checkWorkerSkeleton(root);
    assert.equal(errs.length, 1, errs.join('\n'));
    assert.match(errs[0], /^workers\/notes\/_kernel: 不许有 _kernel\/ 目录（规则 18/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('本仓库：workers/ 下每个子目录都有 wrangler.toml（规则 19–21 不会因为漏了 toml 而漏查）', () => {
  const dirs = readdirSync(join(REPO, 'workers'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(dirs.length >= 7, dirs.join(','));
  for (const d of dirs) assert.ok(existsSync(join(REPO, 'workers', d, 'wrangler.toml')), `workers/${d} 缺 wrangler.toml`);
});

/* ───────── 规则 23–27：space 骨架契约（space/README.md，规范 v1.8） ───────── */

/** 带 space/README.md 和两张表的最小仓库 */
function spaceFixture(files, { pending = [], exceptions = [] } = {}) {
  return fixture({
    'space/README.md': '# space\n',
    'space/scripts/check/layers-pending.json': JSON.stringify({ pending }),
    'space/scripts/check/layers-exceptions.json': JSON.stringify({ exceptions }),
    ...files,
  });
}
const W = 'space/web/';

test('check-layers 23/24：Platform 不依赖产品、产品之间不互相引用（JS、CSS、模板都查）；产品用 Platform 可以', () => {
  const root = spaceFixture({
    [W + 'assets/shell/js/a.js']: "import { c } from '../../curio/js/c.js';",
    [W + 'assets/curio/js/c.js']: "import { a } from '../../shell/js/a.js';\nimport { d } from '../../daymark/js/d.js';",
    [W + 'assets/daymark/js/d.js']: 'export const d = 1;',
    [W + 'assets/blog/css/x.css']: "@import '../../curio/css/y.css';\n/* @import '../../daymark/css/z.css'; */",
    [W + 'assets/curio/css/y.css']: '',
    [W + 'layouts/index.html']: '{{ partial "curio/x.html" . }}{{ $j := resources.Get "daymark/js/d.js" }}{{ site.Data.blog.i18n }}{{ partial "shell/ok.html" . }}',
    [W + 'layouts/partials/shell/ok.html']: '{{ index site.Data "curio" }}',
    [W + 'layouts/partials/curio/x.html']: '{{ partial "blog/p.html" . }}{{ partial "shell/ok.html" . }}{{ site.Data.shell.nav }}{{ site.Data.curio.i18n }}',
  });
  try {
    const { errors } = layers.checkSpace(root, { files: [] });
    const want = [
      [/assets\/shell\/js\/a\.js: Platform 不许依赖产品 curio（规则 23）/],
      [/assets\/curio\/js\/c\.js: 产品 curio 不许引用产品 daymark（规则 24）/],
      [/assets\/blog\/css\/x\.css: 产品 blog 不许引用产品 curio（规则 24）/],
      [/layouts\/index\.html:1: Platform 不许依赖产品 curio（规则 23）.*partial "curio\/x\.html"/],
      [/layouts\/index\.html:1: Platform 不许依赖产品 daymark（规则 23）.*resources\.Get/],
      [/layouts\/index\.html:1: Platform 不许依赖产品 blog（规则 23）.*site\.Data\.blog/],
      [/partials\/shell\/ok\.html:1: Platform 不许依赖产品 curio（规则 23）.*index site\.Data "curio"/],
      [/partials\/curio\/x\.html:1: 产品 curio 不许引用产品 blog（规则 24）/],
    ];
    for (const [re] of want) assert.ok(errors.some((e) => re.test(e)), '缺：' + re + '\n' + errors.join('\n'));
    assert.equal(errors.length, want.length, errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-layers 25：前端不许引用 assets/ 以外，相对引用要解析到真实文件', () => {
  const root = spaceFixture({
    [W + 'assets/curio/js/c.js']: "import { k } from '../../../../../workers/x/src/k.js';\nimport { n } from './nope.js';",
    'workers/x/src/k.js': 'export const k = 1;',
  });
  try {
    const { errors } = layers.checkSpace(root, { files: [] });
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.match(errors[0], /assets\/ 以外的文件.*规则 25/);
    assert.match(errors[1], /不存在.*规则 25/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-layers 26：落点白名单 + 待迁移表（只许删不许加）', () => {
  const root = spaceFixture({}, { pending: [W + 'assets/js/old.js', W + 'assets/js/gone.js', W + 'assets/shell/js/moved.js'] });
  try {
    const files = [
      W + 'assets/shell/js/moved.js', W + 'assets/curio/js/ok.js', W + 'layouts/index.html', W + 'layouts/shell/player.html',
      W + 'layouts/partials/shell/p.html', W + 'data/shell/nav.json', 'space/scripts/build/build-css.cjs', 'space/README.md',
      W + 'assets/js/old.js',
      W + 'assets/js/new.js', W + 'assets/curio/x.js', W + 'layouts/partials/loose.html', W + 'data/loose.yaml', 'space/scripts/loose.mjs',
      W + 'static/anything.txt', W + 'content/blog/a.md',
    ];
    const { errors } = layers.checkSpace(root, { files });
    const want = [
      'assets/js/new.js: 放错了地方', 'assets/curio/x.js: 放错了地方', 'partials/loose.html: 放错了地方',
      'data/loose.yaml: 放错了地方', 'space/scripts/loose.mjs: 放错了地方',
      'assets/js/gone.js 已经不在了', 'assets/shell/js/moved.js 已在目标位置',
    ];
    for (const w of want) assert.ok(errors.some((e) => e.includes(w)), '缺：' + w + '\n' + errors.join('\n'));
    assert.equal(errors.length, want.length, errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-layers 27：例外必须有 reason，用得上才算，用不上的报错', () => {
  const files = {
    [W + 'assets/shell/js/a.js']: "import { c } from '../../curio/js/c.js';",
    [W + 'assets/curio/js/c.js']: 'export const c = 1;',
  };
  const ok = spaceFixture(files, { exceptions: [{ rule: '23', file: W + 'assets/shell/js/a.js', ref: W + 'assets/curio/js/c.js', reason: '测试：说清楚了原因' }] });
  const noReason = spaceFixture(files, { exceptions: [{ rule: '23', file: W + 'assets/shell/js/a.js', reason: ' ' }] });
  const stale = spaceFixture({ [W + 'assets/curio/js/c.js']: '' }, { exceptions: [{ rule: '24', file: W + 'assets/curio/js/c.js', reason: '早就不需要了' }] });
  try {
    assert.deepEqual(layers.checkSpace(ok, { files: [] }).errors, []);
    const e1 = layers.checkSpace(noReason, { files: [] }).errors;
    assert.ok(e1.some((e) => /没写 reason/.test(e)), e1.join('\n'));
    assert.ok(e1.some((e) => /规则 23/.test(e)), '没原因的例外不放行：' + e1.join('\n'));
    const e2 = layers.checkSpace(stale, { files: [] }).errors;
    assert.equal(e2.length, 1, e2.join('\n'));
    assert.match(e2[0], /用不上了/);
  } finally {
    for (const r of [ok, noReason, stale]) rmSync(r, { recursive: true, force: true });
  }
});

test('check-layers 23–27：本仓库有契约文件，checkRepo 默认就查；缺表报错', () => {
  assert.ok(existsSync(join(REPO, 'space/README.md')));
  const readme = readFileSync(join(REPO, 'space/README.md'), 'utf8');
  for (const re of layers.ALLOWED_PLACES) assert.ok(re instanceof RegExp);
  assert.match(readme, /例外/);
  const root = fixture({ 'space/README.md': '# x\n' });
  try {
    const { errors } = layers.checkRepo(root);
    assert.ok(errors.some((e) => /缺待迁移表/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /缺例外表/.test(e)), errors.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
