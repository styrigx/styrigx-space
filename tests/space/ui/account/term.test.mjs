/**
 * 账号终端（2026-11-08 账号 UI 改版，space/web/assets/js/shell/account/*，设计稿 acct-sec-redraw mock v3）：
 * - commands.js：命令解析（sudo root / sudo root reauth / sudo root reset / exit / passwd / passkey add / cd）、入口名 → 层、提示符
 * - 纯函数：filterGrants（grep + 标签）、agoText、mmdd、verifyKinds、三选一
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
const G = await import('../../../../' + DIR + 'grants.js');
const D = await import('../../../../' + DIR + 'devices.js');
const R = await import('../../../../' + DIR + 'reset.js');
const SE = await import('../../../../' + DIR + 'session.js');

test('命令：三条账号命令 + exit / passwd / passkey add / cd / help / clear；别的 command not found', () => {
  const p = (/** @type {string} */ s) => C.parseCmd(C.normCmd(s));
  assert.equal(C.ROOT_COMMAND, 'root');
  assert.deepEqual(C.CMD, { session: 'sudo root', reauth: 'sudo root reauth', reset: 'sudo root reset' });
  assert.equal(p('  SUDO   root ').cmd, 'session');
  assert.equal(p('sudo -i').cmd, 'session');
  assert.equal(p('sudo root reauth').cmd, 'reauth');
  assert.equal(p('sudo -v').cmd, 'reauth');
  assert.equal(p('sudo root reset').cmd, 'reset');
  assert.equal(p('exit').cmd, 'exit');
  assert.equal(p('logout').cmd, 'exit');
  assert.equal(p('passwd').cmd, 'passwd');
  assert.equal(p('passkey add').cmd, 'passkey-add');
  assert.deepEqual(p('cd security'), { cmd: 'cd', arg: 'keys' });
  assert.deepEqual(p('cd ~/account/apps/'), { cmd: 'cd', arg: 'grants' });
  assert.deepEqual(p('cd ..'), { cmd: 'cd', arg: 'home' });
  assert.equal(p('help').cmd, 'help');
  assert.equal(p('clear').cmd, 'clear');
  assert.equal(p('sudo login').cmd, 'unknown', 'v3：sudo login 不再认');
  assert.equal(p('sudo account').cmd, 'unknown');
  assert.equal(p('').cmd, '');
  /* 提示符（Gray 17:45 / 17:18）与不回显的输入行（同锁屏） */
  assert.equal(C.PS_GUEST, 'login@account:~$');
  assert.equal(C.PS_ROOT, 'root@account:~#');
  assert.equal(C.PS_RESET, 'reset@account:~#');
  assert.equal(C.PS_PASSWORD, '[sudo] password for root:');
  assert.equal(C.PS_RECOVERY_KEY, '[sudo] recovery key:');
  assert.equal(C.TRY_AGAIN, 'Sorry, try again.');
  assert.equal(C.TRIES_OVER, 'sudo: 3 incorrect password attempts');
});

test('sudo root 选项说明只列给了的方式；账号密码没设才多一行（Gray 22:13）', () => {
  const zh = TR.zh.account.session.kind;
  const tt = (/** @type {string} */ k) => (k.startsWith('session.kind.') ? zh[k.slice(13)] : k);
  assert.deepEqual(SE.verifyKinds({ configured: { passkey: true, password: false } }), ['passkey']);
  assert.equal(SE.keyMapLine(['passkey'], tt), 'passkey = 账号通行密钥');
  assert.equal(SE.keyMapLine(['passkey', 'password'], tt), 'passkey = 账号通行密钥 · password = 账号密码');
  assert.equal(SE.keyMapLine(['password'], tt), 'password = 账号密码');
  assert.equal(SE.pwUnset({ configured: { passkey: true, password: false } }), true);
  assert.equal(SE.pwUnset({ configured: { passkey: true, password: true } }), false);
  assert.equal(SE.pwUnset({ configured: { passkey: false, password: false } }), false, '一种都没设走 noMethod');
  assert.equal(SE.pwUnset(null), false, '读不到状态不算');
  assert.equal(TR.zh.account.session.keyMap, undefined, '旧的整行 keyMap 删了');
  assert.match(TR.zh.account.session.pwUnset, /账号密码未设置/);
  assert.equal(TR.zh.account.common.noOption, '没有这个选项');
});

test('入口名 → 层（旧地址 #acct=<子页>、[data-acct-open]、sudo root reauth）', () => {
  assert.deepEqual(C.layerFromPath(''), { layer: '', reset: false, reauth: false });
  assert.deepEqual(C.layerFromPath('profile'), { layer: 'profile', reset: false, reauth: false });
  assert.deepEqual(C.layerFromPath('devices'), { layer: 'devices', reset: false, reauth: false });
  assert.deepEqual(C.layerFromPath('security'), { layer: 'keys', reset: false, reauth: false });
  assert.deepEqual(C.layerFromPath('apps'), { layer: 'grants', reset: false, reauth: false });
  assert.deepEqual(C.layerFromPath('reset'), { layer: '', reset: true, reauth: false });
  assert.deepEqual(C.layerFromPath('reauth'), { layer: '', reset: false, reauth: true });
  assert.deepEqual(C.layerFromPath('sync'), { layer: '', reset: false, reauth: false }, '云同步子页删了，回主页');
  assert.deepEqual([...C.LAYERS], ['home', 'profile', 'devices', 'keys', 'grants']);
});

test('应用授权（v5 S5 起在终端 app / app rm <n>）：没有窗口里的 grep / 标签了；应用表照旧', () => {
  const t = (/** @type {string} */ k) => ({ 'grants.app.curio': '奇趣', 'grants.app.daymark': '日刻' })[k] || '';
  const gs = [{ app: 'curio', granted: true }, { app: 'daymark', granted: false }, { app: 'prefs', granted: true, name: 'Settings sync' }];
  /* v5 S5：应用授权在终端里（app / app rm <n>），窗口里的 grep / 标签没有了 */
  void t; void gs;
  assert.equal(G.filterGrants, undefined);
  assert.deepEqual([...G.APP_IDS], ['curio', 'daymark', 'prefs', 'wellbeing', 'avatar', 'profile'], '设置同步的授权还在（O9）');
});

test('设备「上次活动」相对时间；reset 三选一默认 [2]', () => {
  const t = (/** @type {string} */ k) => ({ 'devices.justNow': 'now', 'devices.minAgo': '{n}m', 'devices.hourAgo': '{n}h', 'devices.dayAgo': '{n}d' })[k];
  const now = 1e12;
  assert.equal(D.agoText(t, now - 30e3, now), 'now');
  assert.equal(D.agoText(t, now - 5 * 60e3, now), '5m');
  assert.equal(D.agoText(t, now - 3 * 3600e3, now), '3h');
  assert.equal(D.agoText(t, now - 50 * 3600e3, now), '2d');
  assert.deepEqual(R.SIGN_OUT_CHOICES.map((c) => c[1]), ['all', 'others', 'none']);
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
  for (const g of ['common', 'session', 'reauth', 'reset', 'keys', 'devices', 'grants', 'profile', 'help']) assert.ok(TR.zh.account[g], 'account.' + g);
  const used = new Set();
  for (const f of readdirSync(path.join(REPO, DIR))) {
    const src = strip(rd(DIR + f));
    for (const m of src.matchAll(/\b(?:t|tf|C\.t|C\.tf|C\.note|C\.foot)\('([a-z][A-Za-z]*\.[A-Za-z.]*[A-Za-z])'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 80, String(used.size));
  for (const k of used) {
    assert.ok(zk.includes(k), 'zh 缺 account.' + k);
    assert.ok(ek.includes(k), 'en 缺 account.' + k);
  }
  /* 动态拼的键 */
  for (const pre of ['reset.signOut.all', 'reset.signOut.others', 'reset.signOut.none', 'profile.name', 'profile.nickname', 'profile.motto', 'profile.email']) assert.ok(zk.includes(pre), pre);
  for (const app of G.APP_IDS) { assert.ok(zk.includes('grants.app.' + app), app); assert.ok(zk.includes('grants.desc.' + app), app); }
  /* 头像裁剪退到外壳表 account.profile.avatar.* */
  for (const k of ['title', 'pick', 'remove', 'crop', 'cancel', 'done', 'saved', 'removed', 'failed', 'badFile', 'noScope']) assert.ok(zk.includes('profile.avatar.' + k), k);
  /* auth/post-json.js errText 用的旧平铺键都接得上（term.js errT） */
  const api = rd('space/web/assets/js/auth/post-json.js');
  for (const m of api.matchAll(/: '(err\w+|sessExp)'/g)) assert.ok(zk.includes('common.' + m[1]), m[1]);
});

test('后端名字只在 api.js：入口、action 名、请求字段、状态字段、密码管理器隐藏用户名（NAMING-V2 P2 已切到按入口的新接口）', () => {
  const files = readdirSync(path.join(REPO, DIR)).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['api.js', 'avatar-edit.js', 'commands.js', 'devices.js', 'grants.js', 'keys.js', 'passkey-signal.js', 'profile.js', 'proxy.js', 'reauth.js', 'reset.js', 'session.js', 'window.js']);
  const api = strip(rd(DIR + 'api.js'));
  /* NAMING-V2 P2：POST /api/account/<入口> { action }，入口和 action 都只在 api.js 里写 */
  for (const [e, acts] of Object.entries({ session: ['passkey-challenge', 'passkey', 'password', 'end'], reauth: ['passkey-challenge', 'passkey', 'password'],
    reset: ['recovery-key', 'finish', 'end'], keys: ['passkey-rename'], devices: ['list', 'revoke', 'revoke-all'], grants: ['list', 'add', 'revoke'] })) {
    for (const a of acts) assert.ok(api.includes("post('" + e + "', '" + a + "'") || (a === 'passkey-challenge' || a === 'passkey'), e + '/' + a);
  }
  for (const a of ['password-set', 'passkey-list', 'passkey-add-challenge', 'passkey-add', 'passkey-delete']) assert.ok(api.includes("post(entry, '" + a + "'"), a);
  assert.ok(api.includes("post(entry, 'passkey-challenge')") && api.includes("post(entry, 'passkey',"), 'session / reauth 的通行密钥断言');
  assert.ok(api.includes("ACCOUNT_API + '/reauth'") && api.includes("action: 'end'"), 'reauth end（keepalive）');
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

test('旧账号整页删干净；/account/* 都 301 到本语言首页 #acct=<层>；奇趣 / 日刻 sudo root 打开账号终端', () => {
  for (const p of ['layouts/_default/account.html', 'layouts/_default/account-security.html', 'layouts/_default/account-devices.html', 'layouts/_default/account-apps.html',
    'layouts/_default/account-profile.html', 'layouts/_default/account-reset.html', 'content/account.md', 'content/zh/account.md', 'assets/js/apps/account.js',
    'assets/js/apps/account-security.js', 'assets/js/entries/entry-account.js', 'assets/js/shell/account-term.js', 'layouts/partials/sgx-account-card.html']) {
    assert.equal(existsSync(path.join(REPO, 'space/web', p)), false, p);
  }
  const red = rd('space/web/static/_redirects');
  for (const [pre, sub, h] of [['', '', '#acct'], ['', 'profile/', '#acct=profile'], ['', 'devices/', '#acct=devices'], ['', 'security/', '#acct=security'], ['', 'apps/', '#acct=apps'],
    ['', 'reset/', '#acct=reset'], ['/zh', '', '#acct'], ['/zh', 'security/', '#acct=security'], ['/zh', 'reset/', '#acct=reset']]) {
    assert.match(red, new RegExp('^' + pre + '/account/' + sub + '\\s+' + pre + '/' + h + '\\s+301$', 'm'), pre + '/account/' + sub);
  }
  const tp = rd('space/web/assets/js/shell/topbar-panel.js');
  assert.match(tp, /\/\^#acct\(\?:=\(\[a-z\]\*\)\)\?\(\?:&app=\(\[a-z\]\+\)\)\?\$\//, '#acct=<层>&app=<应用>');
  assert.match(tp, /closest\('\[data-acct-open\]'\)/);
  const cu = rd('space/web/layouts/partials/curio/signin.html');
  assert.match(cu, /data-acct-open="" data-acct-app="curio"/);
  assert.match(cu, />sudo root</);
  const dm = rd('space/web/layouts/daymark/section.html');
  assert.equal((dm.match(/data-acct-open="" data-acct-app="daymark"/g) || []).length, 2);
  assert.doesNotMatch(dm + cu, />sudo login</);
  assert.doesNotMatch(rd('space/web/assets/curio/js/curio.js') + rd('space/web/assets/daymark/js/daymark.js'), /\?return=|\/account\//);
});
