/**
 * 预览 / 测试资源统一（Sloan 2026-10-30 定）：所有 Worker 的预览 / 测试资源（KV、D1，以后的 R2）都用同一个 styrigx-test-preview，
 * 不许再出现按 Worker 分的预览资源（styrigx-auth-gateway-preview、styrigx-account-preview 库等）。
 *
 * - 每份 wrangler.toml 的 [env.preview]：D1 只许 styrigx-test-preview（1339bb0b-f9f8-4e3d-b413-ff07ca28ce69），
 *   KV 只许 193b4d68b8ac4c6f8c0ba16b5ea78b14，R2 只许 bucket styrigx-test-preview
 * - 正式块（非 [env.preview]）绝不引用测试资源的 id / 名字
 * - deploy.yml、scripts/：wrangler d1 命令只对 styrigx-test-preview 加 --env preview；不出现别的 *-preview 资源名
 *
 * 运行：node --test tests/workers/auth-gateway/preview-resources.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const REPO = new URL('../../../', import.meta.url).pathname;
const read = (p) => readFileSync(REPO + p, 'utf8');

export const TEST_PREVIEW_NAME = 'styrigx-test-preview';
export const TEST_PREVIEW_D1_ID = '1339bb0b-f9f8-4e3d-b413-ff07ca28ce69';
export const TEST_PREVIEW_KV_ID = '193b4d68b8ac4c6f8c0ba16b5ea78b14';

/** 仓库里所有 wrangler.toml：web/ 和 workers/<名字>/ */
function wranglerFiles() {
  const out = ['web/wrangler.toml'];
  for (const d of readdirSync(REPO + 'workers', { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(REPO + 'workers/' + d.name + '/wrangler.toml')) out.push('workers/' + d.name + '/wrangler.toml');
  }
  return out;
}

/** 去掉 # 注释（注释里可以提旧名字，配置里不行） */
const code = (s) => s.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

/**
 * 按表头切块：[[x]] / [x] 开头到下一个表头前。
 * @returns {{header:string, body:string}[]}
 */
function blocks(toml) {
  const out = [];
  let cur = { header: '', body: '' };
  for (const line of code(toml).split('\n')) {
    const h = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*$/);
    if (h) { out.push(cur); cur = { header: h[1], body: '' }; } else cur.body += line + '\n';
  }
  out.push(cur);
  return out;
}

const field = (body, k) => { const m = body.match(new RegExp('^\\s*' + k + '\\s*=\\s*"([^"]*)"', 'm')); return m ? m[1] : null; };

test('wrangler.toml 的 [env.preview]：D1 / KV / R2 只用 styrigx-test-preview', () => {
  let d1 = 0;
  let kv = 0;
  for (const p of wranglerFiles()) {
    for (const b of blocks(read(p))) {
      if (b.header === '[[env.preview.d1_databases]]') {
        d1++;
        assert.equal(field(b.body, 'database_name'), TEST_PREVIEW_NAME, p + '：预览 D1 名字');
        assert.equal(field(b.body, 'database_id'), TEST_PREVIEW_D1_ID, p + '：预览 D1 id');
      } else if (b.header === '[[env.preview.kv_namespaces]]') {
        kv++;
        assert.equal(field(b.body, 'id'), TEST_PREVIEW_KV_ID, p + '：预览 KV id');
        assert.equal(field(b.body, 'preview_id'), null, p + '：预览 KV 不另配 preview_id');
      } else if (b.header === '[[env.preview.r2_buckets]]') {
        assert.equal(field(b.body, 'bucket_name'), TEST_PREVIEW_NAME, p + '：预览 R2 bucket');
      } else if (/^\[\[(?:env\.[a-z]+\.)?(d1_databases|kv_namespaces|r2_buckets)\]\]$/.test(b.header) && !b.header.startsWith('[[env.preview.')) {
        /* 正式块（及其他环境）绝不引用测试资源 */
        assert.notEqual(field(b.body, 'database_id'), TEST_PREVIEW_D1_ID, p + ' ' + b.header + '：正式块指向了测试库');
        assert.notEqual(field(b.body, 'database_name'), TEST_PREVIEW_NAME, p + ' ' + b.header + '：正式块指向了测试库');
        assert.notEqual(field(b.body, 'id'), TEST_PREVIEW_KV_ID, p + ' ' + b.header + '：正式块指向了测试 KV');
        assert.notEqual(field(b.body, 'bucket_name'), TEST_PREVIEW_NAME, p + ' ' + b.header + '：正式块指向了测试 bucket');
      }
    }
  }
  assert.ok(d1 >= 1, '至少登记了一个预览 D1');
  assert.ok(kv >= 1, '至少登记了一个预览 KV');
});

test('wrangler.toml：配置里（注释除外）只有 styrigx-test-preview 这一个 *-preview 资源名；预览 Worker 名只许出现在 [env.preview] 的 name', () => {
  for (const p of wranglerFiles()) {
    for (const b of blocks(read(p))) {
      for (const m of b.body.matchAll(/^\s*([a-z_]+)\s*=\s*"([^"]*-preview)"/gm)) {
        if (m[2] === TEST_PREVIEW_NAME) continue;
        assert.ok(b.header === '[env.preview]' && m[1] === 'name', p + ' ' + b.header + ' ' + m[1] + ' = "' + m[2] + '"：不许按 Worker 另起预览资源');
      }
    }
  }
});

test('deploy.yml / scripts：对预览跑的 wrangler d1 命令只碰 styrigx-test-preview，不出现别的 *-preview 库名', () => {
  const files = ['.github/workflows/deploy.yml', ...readdirSync(REPO + 'scripts').filter((f) => /\.(mjs|cjs|js)$/.test(f)).map((f) => 'scripts/' + f)];
  let previewCmds = 0;
  for (const p of files) {
    const s = read(p);
    for (const line of s.split('\n')) {
      const m = line.match(/\bd1\s+(?:migrations\s+apply|execute)\s+([A-Za-z0-9_-]+)/);
      if (m && /--env\s+preview\b/.test(line)) {
        previewCmds++;
        assert.equal(m[1], TEST_PREVIEW_NAME, p + '：' + line.trim());
      }
    }
    for (const m of s.matchAll(/\bstyrigx-(?:auth-gateway|account|share|chat|search-index|status)-preview\b/g)) {
      assert.fail(p + '：不许再出现按 Worker 分的预览资源名 ' + m[0]);
    }
  }
  assert.ok(previewCmds >= 1, 'deploy.yml 至少对测试库跑一次预览迁移');
});
