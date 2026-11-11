/**
 * 账号（2026-11-08 账号 UI 改版，space/web/assets/js/shell/account/*；S9 起账号卡片只展示，操作都在全站终端的账号层 cmd/*）：
 * - commands.js：命令字、入口名 → 终端里怎么开、密码 / 恢复密钥提示
 * - 纯函数：agoText、mmdd、verifyKinds、三选一
 * - 字符串表：sgx-shell-i18n 的 account.* 中英键一致；代码里写死的每个键两种语言都有
 * - 后端名字只在 api.js（等 acct-naming NAMING-V2 P2 换接口时只改一个文件）；root 只在 commands.js
 * - 旧账号整页删干净，/account/* 都 301 到本语言首页 #acct=<层>
 *
 * 运行：node --test tests/space/ui/account/term.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DIR = 'space/web/assets/js/shell/account/';
const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
const strip = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const C = await import('../../../../' + DIR + 'commands.js');
const D = await import('../../../../' + DIR + 'cmd/devices.js');
const K = await import('../../../../' + DIR + 'cmd/keys.js');
const W = await import('../../../../' + DIR + 'window.js');
const ACM = await import('../../../../space/web/assets/js/shell/term/cmds/acct/index.js');

test('v6 P4：旧账号会话的命令字（sudo root / reauth / reset）和输密码 / 恢复密钥那一行删了；卡片没有命令行', () => {
  for (const gone of ['ROOT_COMMAND', 'CMD', 'PS_PASSWORD', 'PS_RECOVERY_KEY', 'TRY_AGAIN', 'TRIES_OVER', 'MAX_TRIES', 'parseCmd', 'WINDOW_TABLE', 'LAYERS', 'LAYER_PATH', 'PS_GUEST', 'PS_ROOT', 'PS_RESET']) assert.equal(/** @type {any} */ (C)[gone], undefined, gone);
  for (const f of ['session.js', 'reauth.js', 'reset.js', 'passkey-signal.js']) assert.equal(existsSync(path.join(REPO, DIR, f)), false, f + ' 已删（v6 P4）');
});

test('账号卡片的行 → 终端预填的命令（S9）；profile set 的字段名', () => {
  assert.deepEqual({ ...W.CARD_CMDS }, { profile: 'profile', devices: 'device', keys: 'passkey', exit: 'exit', login: 'su root' }, '登录行 sudo root → su root（Gray 11-11 17:51）；应用授权行随应用授权删除（定稿 v5.3 §十二）');
  assert.deepEqual({ ...C.PROFILE_KEYS }, { name: 'name', nick: 'nickname', sign: 'motto', email: 'email' });
  const prof = ACM.ACCOUNT_CMDS.find((c) => c.name === 'profile');
  assert.deepEqual(prof.subArgs('set'), Object.keys(C.PROFILE_KEYS), '补全表和字段表一致');
  const w = rd(DIR + 'window.js');
  assert.doesNotMatch(w, /createInputLine|data-at-in|data-at-form|data-at-log|typeHelp/, '卡片里没有命令行和「输入 man」提示');
  assert.match(w, /data-at-run=/);
});

test('入口名 → 在终端里怎么开（旧地址 #acct=<子页>、[data-acct-open]；子页 = 预填命令；v6 P4：旧 reset / reauth 入口删了，开卡片）', () => {
  assert.deepEqual(C.layerFromPath(''), { cmd: '' });
  assert.deepEqual(C.layerFromPath('profile'), { cmd: 'profile' });
  assert.deepEqual(C.layerFromPath('devices'), { cmd: 'device' });
  assert.deepEqual(C.layerFromPath('security'), { cmd: 'passkey' });
  assert.deepEqual(C.layerFromPath('apps'), { cmd: '' }, '应用授权删了（定稿 v5.3 §十二）：旧 #acct=apps 开卡片');
  assert.deepEqual(C.layerFromPath('reset'), { cmd: '' }, '旧 /account/reset/ 删了（Gray 11-11 17:47）：不预填');
  assert.deepEqual(C.layerFromPath('reauth'), { cmd: '' });
  assert.deepEqual(C.layerFromPath('sync'), { cmd: '' }, '云同步子页删了，开卡片');
  assert.equal(W.layerFromPath, C.layerFromPath);
});

test('设备「上次活动」相对时间；会话开始时间', () => {
  const t = (/** @type {string} */ k) => ({ 'devices.justNow': 'now', 'devices.minAgo': '{n}m', 'devices.hourAgo': '{n}h', 'devices.dayAgo': '{n}d' })[k];
  const now = 1e12;
  assert.equal(D.agoText(t, now - 30e3, now), 'now');
  assert.equal(D.agoText(t, now - 5 * 60e3, now), '5m');
  assert.equal(D.agoText(t, now - 3 * 3600e3, now), '3h');
  assert.equal(D.agoText(t, now - 50 * 3600e3, now), '2d');
  assert.equal(D.sinceText(Date.UTC(2026, 10, 11, 8, 5)), '2026-11-11 08:05');
  assert.equal(K.mmdd(new Date(2026, 10, 9).getTime()), '11-09');
  assert.equal(K.mmdd(0), '');
});

/** 嵌套表 → 点号键 @param {any} o @param {string} [pre] @returns {string[]} */
function keysOf(o, pre) {
  return Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v, (pre ? pre + '.' : '') + k) : [(pre ? pre + '.' : '') + k]));
}
const TR = Object.fromEntries(['zh', 'en'].map((l) => [l, /** @type {any} */ (yaml.load(rd('space/web/data/sgx-shell-i18n/' + l + '.yaml')))]));

test('字符串表：account.* 中英键一致；旧的平铺 acct 节删了；代码里写死的键两种语言都有', () => {
  assert.equal(TR.zh.acct, undefined);
  assert.equal(TR.en.acct, undefined);
  const zk = keysOf(TR.zh.account).sort();
  const ek = keysOf(TR.en.account).sort();
  assert.deepEqual(zk, ek);
  for (const g of ['common', 'keys', 'devices', 'profile']) assert.ok(TR.zh.account[g], 'account.' + g);
  for (const g of ['reset', 'grants']) assert.equal(TR.zh.account[g], undefined, 'account.' + g + ' 删了（定稿 v5.4 §十三 P4 收尾）');
  assert.equal(TR.zh.account.help, undefined, 'S9：卡片的 help 删了（man 在终端里）');
  const used = new Set();
  /* v5 S5：终端里的账号层在 cmd/ 子目录，一起查 */
  for (const f of readdirSync(path.join(REPO, DIR)).filter((x) => x.endsWith('.js')).concat(readdirSync(path.join(REPO, DIR, 'cmd')).map((x) => 'cmd/' + x))) {
    const src = strip(rd(DIR + f));
    for (const m of src.matchAll(/\b(?:t|tf|C\.t|C\.tf|C\.note)\('([a-z][A-Za-z]*\.[A-Za-z.]*[A-Za-z])'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 60, String(used.size));
  for (const k of used) {
    assert.ok(zk.includes(k), 'zh 缺 account.' + k);
    assert.ok(ek.includes(k), 'en 缺 account.' + k);
  }
  /* 动态拼的键 */
  for (const pre of ['profile.name', 'profile.nickname', 'profile.motto', 'profile.email']) assert.ok(zk.includes(pre), pre);
  /* 头像裁剪退到外壳表 account.profile.avatar.* */
  for (const k of ['title', 'pick', 'remove', 'crop', 'cancel', 'done', 'saved', 'removed', 'failed', 'badFile', 'noScope']) assert.ok(zk.includes('profile.avatar.' + k), k);
  /* auth/post-json.js errText 用的旧平铺键都接得上（term.js errT） */
  const api = rd('space/web/assets/js/auth/post-json.js');
  for (const m of api.matchAll(/: '(err\w+|sessExp)'/g)) assert.ok(zk.includes('common.' + m[1]), m[1]);
});

test('后端名字只在 api.js：入口、action 名、请求字段、状态字段、密码管理器隐藏用户名（NAMING-V2 P2 已切到按入口的新接口）', () => {
  const top = readdirSync(path.join(REPO, DIR)).filter((f) => f.endsWith('.js'));
  /* S9：卡片只展示，窗口那一套（keys / devices / grants / profile 层）删了，只剩终端的账号层 cmd/ */
  assert.deepEqual(top.sort(), ['api.js', 'avatar-edit.js', 'commands.js', 'proxy.js', 'window.js']);
  const sub = readdirSync(path.join(REPO, DIR, 'cmd')).map((f) => 'cmd/' + f);
  /* 割接：cmd/v6-direct.js = v6 root 直接做的 sub 的门（C.gated / C.authErrFor） */
  assert.deepEqual(sub.sort(), ['cmd/devices.js', 'cmd/keys.js', 'cmd/layer.js', 'cmd/profile.js', 'cmd/v6-direct.js']);
  const files = top.concat(sub);
  const api = strip(rd(DIR + 'api.js'));
  /* NAMING-V2 P2：POST /api/account/<入口> { action }，入口和 action 都只在 api.js 里写；v6 P4 起旧会话的 session / reauth / reset / keys 入口删了 */
  for (const [e, acts] of Object.entries({ devices: ['list', 'revoke', 'revoke-all'] })) {
    for (const a of acts) assert.ok(api.includes("post('" + e + "', '" + a + "'"), e + '/' + a);
  }
  for (const e of ['session', 'reauth', 'reset', 'keys', 'grants']) assert.ok(!api.includes("post('" + e + "'") && !api.includes("ACCOUNT_API + '/" + e + "'"), '旧入口 ' + e + ' 删了');
  for (const a of ['passkey-list', 'passkey-add-challenge', 'passkey-add', 'passkey-delete']) assert.ok(api.includes("action: '" + a + "'"), 'v6 ' + a);
  /* 旧单入口 action 一个都不剩 */
  for (const a of ['login-challenge', 'login-passkey', 'login-password', 'logout', 'reauth-clear', 'root-reset', 'reset-finish', 'password-change',
    'passkey-register', 'device-list', 'device-revoke', 'grant-list', 'grant-add', 'grant-revoke', 'reauth: true', 'j.ready', 'j.password', 'j.passkey']) {
    assert.ok(!api.includes(a), '旧接口残留：' + a);
  }
  for (const f of files.filter((x) => x !== 'api.js' && x !== 'avatar-edit.js')) {
    const src = strip(rd(DIR + f));
    assert.doesNotMatch(src, /action:|\/api\/account|ACCOUNT_API|postJSON|account-api\.js|key-names\.js|KEY_ACCOUNT|KEY_ROOT|KEY_RECOVERY|\b(?:AccountKey|AccountPassword|AccountPasskey|RecoveryKey|RootKey)\b/, f);
    assert.doesNotMatch(src, /\.ready\b|status\.password|status\.passkey/, f + '：状态用归一后的 signing / configured');
    if (f !== 'commands.js') assert.doesNotMatch(src, /'root'|"root"/, f + '：root 只在 commands.js');
  }
});

test('旧账号整页删干净；/account/*（reset 除外）都 301 到本语言首页 #acct=<层>；奇趣 / 日刻入口指向 su（2c）', () => {
  for (const p of ['layouts/_default/account.html', 'layouts/_default/account-security.html', 'layouts/_default/account-devices.html', 'layouts/_default/account-apps.html',
    'layouts/_default/account-profile.html', 'layouts/_default/account-reset.html', 'content/account.md', 'content/zh/account.md', 'assets/js/apps/account.js',
    'assets/js/apps/account-security.js', 'assets/js/entries/entry-account.js', 'assets/js/shell/account-term.js', 'layouts/partials/sgx-account-card.html']) {
    assert.equal(existsSync(path.join(REPO, 'space/web', p)), false, p);
  }
  const red = rd('space/web/static/_redirects');
  for (const [pre, sub, h] of [['', '', '#acct'], ['', 'profile/', '#acct=profile'], ['', 'devices/', '#acct=devices'], ['', 'security/', '#acct=security'],
    ['/zh', '', '#acct'], ['/zh', 'security/', '#acct=security']]) {
    assert.match(red, new RegExp('^' + pre + '/account/' + sub + '\\s+' + pre + '/' + h + '\\s+301$', 'm'), pre + '/account/' + sub);
  }
  /* v6 P4（定稿 v5.5 §十二 应用授权整套删除）：/account/apps/ 跳转删除 */
  assert.doesNotMatch(red, /^(?:\/zh)?\/account\/apps\//m, '/account/apps/ 不再 301');
  /* v6 P4（定稿 §十三，Gray 11-11 17:47）：旧地址 /account/reset/ 直接删——不跳转、不预填，同任何不存在的路径 404 */
  assert.doesNotMatch(red, /^(?:\/zh)?\/account\/reset\//m, '/account/reset/ 不再 301');
  const tp = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(tp, /\/\^#acct\(\?:=\(\[a-z\]\*\)\)\?\$\//, '#acct=<层>（&app= 随应用授权删除，v6 P4）');
  assert.doesNotMatch(tp, /&app=\(/);
  assert.match(tp, /closest\('\[data-acct-open\]'\)/);
  /* 2c（v6 割接）：奇趣 / 日刻「su 登录后可编辑」入口改指向 su（data-sec-open，打开终端预填 su ）；旧账号授权同意那层只剩「未获授权」分支（JS 换回 data-acct-open） */
  const cu = rd('space/web/layouts/partials/curio/signin.html');
  assert.match(cu, /id="cu-signin" class="sgx-cmd hidden" data-sec-open=""/);
  assert.match(cu, />su</);
  const dm = rd('space/web/layouts/daymark/section.html');
  assert.equal((dm.match(/data-dm-signin class="sgx-cmd hidden" data-sec-open=""/g) || []).length, 2);
  assert.doesNotMatch(dm + cu, />sudo login</);
  assert.doesNotMatch(rd('space/web/assets/curio/js/curio.js') + rd('space/web/assets/daymark/js/daymark.js'), /\?return=|\/account\//);
});
