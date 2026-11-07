// 主站共享外壳副本（atlas/scripts/blog/sync-shell.mjs 写入）：没被手改，sgx-shell.lock.json 的指纹对得上；渲染逻辑稳定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readBlock, renderTargets, BEGIN, END } from '../../atlas/scripts/blog/sync-shell.mjs';

/* 2026-11-02 并进 styrigx-space：lock 在 atlas/web/blog/，副本路径（站内相对）映到 atlas/web/blog/…、tests/blog/… */
const repo = new URL('../../', import.meta.url);
const siteUrl = (p) => new URL(p.replace(/^web\//, 'atlas/web/blog/').replace(/^tests\//, 'tests/blog/'), repo);
const lock = JSON.parse(readFileSync(siteUrl('web/sgx-shell.lock.json'), 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('副本和 lock 一致（改外壳请改主站，再跑 node atlas/scripts/blog/sync-shell.mjs）', () => {
  for (const [p, h] of Object.entries(lock.vendored)) {
    const text = readFileSync(siteUrl(p), 'utf8');
    /* .json、外壳字符串表 .yaml（语言包化 2026-11-07）和 Hugo partial（kind raw，2026-11-04 P5-1 顶栏标记）原样复制、不加标记 */
    const body = p.endsWith('.json') || p.endsWith('.html') || p.endsWith('.yaml') ? text : readBlock(text);
    assert.ok(body !== null, p + ' 缺少 @sgx-shell 标记');
    assert.equal(sha(body), h, p);
  }
});

test('JSON 副本就是主站文件原样（sha 同 manifest）', () => {
  for (const [p] of Object.entries(lock.vendored)) {
    if (!p.endsWith('.json')) continue;
    const name = p.split('/').pop();
    assert.equal(sha(readFileSync(siteUrl(p), 'utf8')), lock.files[name], p);
  }
});

test('renderTargets：标记段带来源和版本，内容按 manifest 拼接', () => {
  const files = {
    'tokens.css': ':root{--sgx-primary:#000}\n',
    'shell.css': '.sgx-topbar{}\n',
    'palette-scheme.js': 'export const x = 1;\n',
    'search.js': 'export function mountSearch() {}\n',
    'share.js': 'export function mountShare() {}\n',
    'topbar.html': '<header id="site-nav"></header>\n',
    'entries.html': '<section class="sgx-ents"></section>\n',
    'topbar.js': 'export function mountTopbar() {}\n',
    'modal-sheet.js': 'export function createModalSheet() {}\n',
    'ai.js': 'export function mountAi() {}\n',
    'vk.js': 'export function onKeyboardHeight() {}\n',
    'prefs-write.js': 'export function syncUiCookie() {}\n',
    'nav.json': '{"items":[]}\n',
    'palettes.json': '{"presets":[]}\n',
    'ui-cookie-read.js': '(function (g) { g.SgxUI = {}; })(this);\n',
    'layout-mode.js': 'function __sgxLayout(){return "phone"}\n',
    'ui-cookie-contract.json': '{"cases":[]}\n',
    'lang-path.js': 'export function langPath() {}\n',
    'lang-path.html': '{{- return . -}}\n',
    'lang-boot.js': 'export function langBoot() {}\n',
    'tr.html': '{{- return dict -}}\n',
    'i18n-en.yaml': 'topbar: {}\n',
    'i18n-zh.yaml': 'topbar: {}\n',
  };
  const { out } = renderTargets({ manifest: { version: 'abc', files: {} }, files }, 'main', () => `a\n${BEGIN} x */\nold\n${END}\nb\n`);
  for (const [p, text] of Object.entries(out)) {
    if (p.endsWith('.json')) continue;
    if (p.endsWith('.yaml')) { assert.equal(text, files['i18n-' + p.split('/').pop()], p + '：外壳字符串表原样'); continue; }
    if (p.endsWith('.html')) { assert.equal(text, files[p.endsWith('-entries.html') ? 'entries.html' : p.endsWith('sgx-lang-path.html') ? 'lang-path.html' : p.endsWith('sgx-tr.html') ? 'tr.html' : 'topbar.html'], p + '：raw 原样'); continue; }
    assert.ok(text.includes(BEGIN + ' styrigx/styrigx-space@main web/shared/shell vabc'), p);
    assert.ok(text.includes(END), p);
    assert.doesNotMatch(text, /\nold\n/, p);
  }
});

test('lock 锁定主站外壳目录的 git tree 哈希（squash 合并后提交没了，tree 仍在；--check 只和这个 tree 比，不跟主站 main 走）', () => {
  assert.match(lock.tree, /^[0-9a-f]{40}$/, 'sgx-shell.lock.json 的 tree 要是 40 位 git tree 哈希：运行 node atlas/scripts/blog/sync-shell.mjs --migrate-lock（旧格式）或重新同步');
  assert.equal(lock.ref, undefined, '新格式 lock 不再有 ref（from 只作记录）');
});
