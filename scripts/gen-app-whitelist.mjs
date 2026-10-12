#!/usr/bin/env node
/**
 * @fileoverview 从 functions/_kernel/app-registry.js 生成前端应用白名单。
 *
 * 背景：app-verify.html、应用列表页（/settings/security/apps/）等前端页面
 * 需要应用白名单（aud/name/scopes/origin/settingsPath），但分层规范禁止
 * 前端 import functions/ 模块。方案：构建时由本脚本从 app-registry.js 生成
 * data/app_whitelist.json，Hugo 模板经 site.Data.app_whitelist 注入页面。
 *
 * 用法：node scripts/gen-app-whitelist.mjs
 * 输出：data/app_whitelist.json（[{aud, name, scopes, origin, settingsPath}]）
 * CI 在 hugo 构建前运行本脚本（见 .github/workflows/deploy.yml）；
 * 生成文件同时提交到仓库，保证本地直接 hugo 构建也可用。
 *
 * 失败条件（exit 非 0，构建失败）：
 * - app-registry.js 导入失败
 * - 白名单为空，或任一条目缺少 aud/name/origin/settingsPath
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const { APP_WHITELIST } = await import(join(ROOT, 'functions/_kernel/app-registry.js'));

if (!Array.isArray(APP_WHITELIST) || APP_WHITELIST.length === 0) {
  console.error('gen-app-whitelist.mjs: APP_WHITELIST 为空');
  process.exit(1);
}

const out = APP_WHITELIST.map((a, i) => {
  for (const k of ['aud', 'name', 'origin', 'settingsPath']) {
    if (!a || typeof a[k] !== 'string' || a[k].length === 0) {
      console.error(`gen-app-whitelist.mjs: 第 ${i} 条缺少字段 ${k}`);
      process.exit(1);
    }
  }
  if (!Array.isArray(a.scopes) || a.scopes.length === 0) {
    console.error(`gen-app-whitelist.mjs: 第 ${i} 条 scopes 非法`);
    process.exit(1);
  }
  return { aud: a.aud, name: a.name, scopes: a.scopes, origin: a.origin, settingsPath: a.settingsPath };
});

writeFileSync(join(ROOT, 'data/app_whitelist.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`gen-app-whitelist.mjs: 生成 data/app_whitelist.json（${out.length} 个应用）`);
