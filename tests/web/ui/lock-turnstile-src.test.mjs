/**
 * PR3 访客进入（Turnstile）静态守护：shell/lock.js 只用 Cloudflare 官方小组件的行为。
 * - render 用 appearance 'always'，不用 interaction-only
 * - 没有本站的验证计时器（以前的 VERIFY_TIMEOUT_MS / verifyTimer 15 秒兜底）
 * - 渲染容器 #sgx-ts-wrap 不带 hidden（display:none 里的挑战不会弹勾选框）
 * - 失败的 <script data-sgx-ts> 会被摘掉；重渲染前 turnstile.remove
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../../web/assets/js/shell/lock.js', import.meta.url), 'utf8');
/* 去掉注释再查（注释里会提到旧做法） */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('Turnstile 渲染用 appearance always，没有 interaction-only', () => {
  assert.match(code, /appearance:\s*'always'/);
  assert.doesNotMatch(code, /interaction-only/);
});

test('没有本站的验证超时计时器', () => {
  assert.doesNotMatch(code, /VERIFY_TIMEOUT|verifyTimer|clearVerifyTimer/);
});

test('渲染容器不带 hidden', () => {
  assert.match(code, /id="sgx-ts-wrap" class="sgx-ts-wrap">/);
  assert.doesNotMatch(code, /id="sgx-ts-wrap"[^>]*hidden/);
});

test('加载失败摘掉脚本标签；重渲染前 remove；旧回调按 attempt 丢弃', () => {
  assert.match(code, /s\.remove\(\)/);
  assert.match(code, /ts\.remove\(widgetId\)/);
  assert.match(code, /attempt === tsAttempt/);
});
