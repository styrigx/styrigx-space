#!/usr/bin/env node
/**
 * @fileoverview 部署后核对 styrigx.com 的 Worker 路由（deploy.yml 的 deploy-space-core「Verify routes」用）：
 *   styrigx.com/* 正好一条、挂在 styrigx-space-core；不再有单独的短链路由 styrigx.com/s/*、styrigx.com/api/share*
 *   （进站 v3 L2 起 /s/*、/api/share 由整站路由接，src/router.js routeShare 按路径分）。
 * 只读，不改任何路由。进站 v3 L2 的一次性路由接管（plan / takeover / restore，原 route-takeover.mjs）在 L3 删旧 Worker 后去掉，见 git 历史（PR #337）。
 *
 * 用法：node space/scripts/verify-core-routes.mjs
 * 环境变量：CLOUDFLARE_API_TOKEN（同部署那一步：styrigx-space-core-deploy，有 styrigx.com 的 Workers Routes 编辑）；
 *   CLOUDFLARE_ACCOUNT_ID（区域查询带上 account.id，同 wrangler）；CF_ZONE_ID（可选，给了就不查区域）；
 *   CF_API_BASE（默认 https://api.cloudflare.com/client/v4，测试用）；ZONE_NAME（默认 styrigx.com）。
 * 只打印路由的 pattern / script / id，不打印 token。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const TARGET = 'styrigx-space-core';
export const MAIN_PATTERN = 'styrigx.com/*';
/** 原来分享短链 Worker 的两条路由：不该再有（/s/*、/api/share 由 styrigx-space-core 的 styrigx.com/* 接） */
export const SHARE_PATTERNS = Object.freeze(['styrigx.com/s/*', 'styrigx.com/api/share*']);

const DEFAULT_API = 'https://api.cloudflare.com/client/v4';

/**
 * 核对：styrigx.com/* → styrigx-space-core；没有短链两条。
 * @param {{pattern:string, script?:string}[]} routes
 * @returns {string[]} 错误
 */
export function verifyRoutes(routes) {
  const errors = [];
  const main = routes.filter((r) => r.pattern === MAIN_PATTERN);
  if (main.length !== 1) errors.push(MAIN_PATTERN + ' 应该正好一条，现在 ' + main.length + ' 条');
  else if (main[0].script !== TARGET) errors.push(MAIN_PATTERN + ' 应该挂 ' + TARGET + '，现在是 ' + (main[0].script || '（没有）'));
  for (const r of routes) if (SHARE_PATTERNS.includes(r.pattern)) errors.push('短链路由还在：' + r.pattern + ' → ' + (r.script || '（没有）'));
  return errors;
}

/* ---------------- Cloudflare API ---------------- */

function api() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN not set');
  const base = process.env.CF_API_BASE || DEFAULT_API;
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let j = null;
    try { j = await res.json(); } catch (e) { /* 不是 JSON */ }
    if (!res.ok || !j || j.success !== true) {
      const msg = j && Array.isArray(j.errors) ? j.errors.map((e) => e.code + ' ' + e.message).join('; ') : 'HTTP ' + res.status;
      throw new Error(method + ' ' + p.replace(/\/zones\/[0-9a-f]+/, '/zones/<zone>').replace(/account\.id=[0-9a-f]+/, 'account.id=<account>') + ' failed: ' + msg);
    }
    return j.result;
  };
}

/**
 * 区域 id：先认环境变量 CF_ZONE_ID（区域 id 不是密值；有就不查）；没有就照 wrangler 部署带 zone_name 的路由时的查法
 * （wrangler 4.x deploy-helpers/src/triggers/zones.ts getZoneIdFromHost：GET /zones?name=<区域>&account.id=<账户>）。
 * 站点核心、奇趣 / 日刻的部署 job 都用 zone_name 路由经同一个查询成功过，部署 token 只要有 styrigx.com 的 Workers Routes 编辑就够。
 * @param {(method:string, p:string, body?:any)=>Promise<any>} call
 */
async function zoneId(call) {
  const fixed = (process.env.CF_ZONE_ID || '').trim();
  if (fixed) {
    if (!/^[0-9a-f]{32}$/.test(fixed)) throw new Error('CF_ZONE_ID is not a zone id');
    return fixed;
  }
  const name = process.env.ZONE_NAME || 'styrigx.com';
  const q = new URLSearchParams({ name });
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (account) q.set('account.id', account);
  const zones = await call('GET', '/zones?' + q.toString());
  if (!Array.isArray(zones) || zones.length !== 1 || !/^[0-9a-f]{32}$/.test(zones[0].id)) throw new Error('zone ' + name + ' not found (token needs a styrigx.com zone permission, or set CF_ZONE_ID)');
  return zones[0].id;
}

/** @returns {Promise<{id:string, pattern:string, script?:string}[]>} */
async function listRoutes(call, zone) {
  const r = await call('GET', '/zones/' + zone + '/workers/routes');
  return Array.isArray(r) ? r.map((x) => ({ id: x.id, pattern: x.pattern, script: x.script })) : [];
}

function show(routes) {
  for (const r of routes) console.log('  ' + r.pattern + ' → ' + (r.script || '（没有）') + ' [' + r.id + ']');
}

async function main() {
  const call = api();
  const zone = await zoneId(call);
  const routes = await listRoutes(call, zone);
  console.log('routes on the zone:');
  show(routes);
  const errors = verifyRoutes(routes);
  for (const x of errors) console.error('::error::' + x);
  if (errors.length) process.exit(1);
  console.log('OK: ' + MAIN_PATTERN + ' → ' + TARGET + ', no share routes');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('::error::verify-core-routes: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}
