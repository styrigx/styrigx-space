/**
 * sgx-ui cookie 契约：主站写端（styrigx-space lib/ui-cookie.js）↔ 本站读端（共享外壳 ui-cookie-read.js，sync-shell 原样同步，baseof.html 内联）。
 * 夹具 tests/fixtures/ui-cookie-contract.json = 主站写端真实写出的 cookie + 读端期望（sync-shell 原样同步，勿手改）；
 * 这里对每个用例断言：本站内联的读端 read / resolve / apply 得到夹具里的期望（系统浅色、深色各一遍），且读端从不写 cookie。
 * 主站改了契约 → 2026-11 合站后读端和夹具都只有主站一份（没有 sync-shell），直接再跑本测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sandbox } from './ui-cookie-sandbox.mjs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const fx = JSON.parse(read('tests/fixtures/ui-cookie-contract.json'));
const palettes = JSON.parse(read('space/web/data/shell/palettes.json'));

/** <html> 状态，和夹具 root 同形 */
function rootState(html) {
  return {
    dark: html.classList.contains('dark'),
    'data-dark': html.getAttribute('data-dark'),
    'data-font-size': html.getAttribute('data-font-size'),
    fontSize: html.style.fontSize,
    'data-palette': html.getAttribute('data-palette'),
    'reduced-motion': html.classList.contains('reduced-motion'),
    'data-reduced-motion': html.getAttribute('data-reduced-motion'),
  };
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('夹具来自主站写端：覆盖默认 terra、深套 lake / 浅套 dustyblue、旧撞色、旧 mode / accent 残留、旧 v1 / v2、theme 别名、lang、未知版本、乱码（2026-11-12 调色板 v4）', () => {
  assert.match(fx._generated, /styrigx-space space\/scripts\/gen\/gen-ui-cookie-contract\.mjs/);
  assert.equal(fx.cases.length, 36);
  const names = fx.cases.map((c) => c.name).join('|');
  for (const k of ['默认 terra', '湖蓝 lake', '雾霾蓝 dustyblue', '旧撞色 xforest', '旧 sgx-theme-mode 残留', '旧自定义主题色残留', '旧 v1', '旧 v2', 'theme 别名', 'lang en', 'lang zh', 'lang system', 'lang 大写', '未知版本 v3 带 lang', '未知版本', '版本是字符串', '没有 v', '乱码']) {
    assert.match(names, new RegExp(k), k);
  }
});

for (const c of fx.cases) {
  test(`契约：${c.name}`, () => {
    for (const sys of ['light', 'dark']) {
      const s = sandbox({ cookie: 'sgx-space-session=x; sgx-ui=' + c.cookie + '; other=1', dark: sys === 'dark' });
      assert.deepEqual(plain(s.U.read()), c.read, 'read');
      assert.deepEqual(plain(s.U.read('sgx-ui=' + c.cookie)), c.read, 'read(串)');
      assert.deepEqual(plain(s.U.resolve(s.U.read())), c[sys].resolve, sys + ' resolve');
      const a = s.U.apply(s.html);
      assert.deepEqual(plain(a), c[sys].resolve, sys + ' apply 返回');
      assert.deepEqual(rootState(s.html), c[sys].root, sys + ' <html>');
      assert.equal(s.cookieWrites, 0, '读端不许写 cookie');
    }
  });
}

test('读端预设表 / 深套表 / 默认色板 = 共享外壳 palettes.json（默认 terra，深套）', () => {
  const s = sandbox();
  assert.deepEqual(plain(s.U.PRESETS), Object.fromEntries(palettes.presets.map((p) => [p.id, p.seed])));
  assert.equal(Object.keys(s.U.PRESETS).length, 25);
  assert.deepEqual(plain(s.U.DARK), palettes.presets.filter((p) => p.mode === 'dark').map((p) => p.id));
  assert.equal(s.U.DEFAULT_PAL, palettes.default);
  assert.equal(s.U.DEFAULT_PAL, 'terra');
  assert.equal(s.U.isDark('terra'), true);
  assert.deepEqual(plain(s.U.VERSIONS), [1, 2]);
});
test('夹具：每个能读的 cookie 都带 lang 字段（小写语言代码 / system；语言清理 2026-11-07 起跟随系统明确是 system）；写端产出的 cookie 不带时钟 / 天气 / 坐标字段（P4-2c）', () => {
  for (const c of fx.cases) {
    if (!c.read) continue;
    assert.ok(c.read.lang === 'system' || /^[a-z]{2,3}$/.test(c.read.lang), c.name + ' lang');
    if (c.source !== 'writer') continue;
    const raw = JSON.parse(Buffer.from(c.cookie, 'base64url').toString('utf8'));
    for (const k of ['tz1', 'tz2', 'h12', 'clock', 'wx', 'unit', 'loc', 'city', 'precise']) {
      assert.ok(!(k in raw), c.name + ' ' + k);
      assert.ok(!(k in c.read), c.name + ' read.' + k);
    }
  }
});

const cookieOf = (name) => 'sgx-ui=' + fx.cases.find((c) => c.name.startsWith(name)).cookie;

test('旧版自定义色留下的 <style id="sgx-accent-roles"> / 本站缓存首帧清掉；换调色板就换深浅', () => {
  const s = sandbox({ cookie: cookieOf('湖蓝 lake'), store: { 'sgx-shell-accent-css': 'old|#1f8a70\nCSS' } });
  const st = s.ctx.document.createElement('style');
  st.id = 'sgx-accent-roles';
  s.ctx.document.head.appendChild(st);
  s.U.apply(s.html);
  assert.equal(s.ctx.document.getElementById('sgx-accent-roles'), null);
  assert.equal(s.ls.has('sgx-shell-accent-css'), false);
  assert.equal(s.html.getAttribute('data-palette'), 'lake');
  assert.equal(s.html.classList.contains('dark'), true);
  s.setCookie(cookieOf('雾霾蓝 dustyblue'));
  s.U.apply(s.html);
  assert.equal(s.html.classList.contains('dark'), false);
});
test('不跟系统：读端不挂系统深浅色监听，系统一变也不重落（深浅只由调色板决定）', () => {
  const s = sandbox({ cookie: cookieOf('雾霾蓝 dustyblue'), dark: true });
  s.U.apply(s.html);
  assert.equal(s.listeners.length, 0);
  assert.equal(s.html.classList.contains('dark'), false);
  s.flip(false);
  assert.equal(s.html.classList.contains('dark'), false);
  assert.equal(s.html.getAttribute('data-dark'), '0');
});
