#!/usr/bin/env node
/**
 * @fileoverview 进站 v3 L2 的一次性路由接管（deploy.yml 的 deploy-space-core 用）：styrigx.com 上原来挂在旧 Worker 的路由挪给 styrigx-space-core。
 *
 * 为什么要它：Cloudflare 一条路由只能挂一个 Worker。L2 之前
 *   styrigx.com/*            → styrigx-auth-gateway（旧鉴权网关）
 *   styrigx.com/s/*          → styrigx-share（旧分享短链 Worker）
 *   styrigx.com/api/share*   → styrigx-share
 * styrigx-space-core 带 styrigx.com/* 直接 wrangler deploy 会被拒（路由已经挂在别的 Worker 上）；短链那两条更具体的路由如果留着，
 * /s/*、/api/share 会继续进旧的 styrigx-share（它问旧网关的会话，认不出新的 sgx-space-session）。
 * 旧 Worker 本身不删（L3 再删，先给 Gray 清单），回退时把路由原样还给它们就能回到 L2 之前。
 *
 * 用法（都在 workers/space-core 目录或任意目录跑，不读 wrangler.toml）：
 *   node space/scripts/route-takeover.mjs plan                       看现状 → $GITHUB_OUTPUT needed=true|false（不改任何东西）
 *   node space/scripts/route-takeover.mjs takeover --state <文件>    记下现状写进 <文件>，styrigx.com/* 改挂 styrigx-space-core，删掉短链两条；再核对一遍
 *   node space/scripts/route-takeover.mjs restore --state <文件>     按 <文件> 把路由还回去（styrigx.com/* 改回原来的 Worker，短链两条重新建上），再核对
 *   node space/scripts/route-takeover.mjs verify                     核对：styrigx.com/* 挂在 styrigx-space-core，没有短链两条
 * 先改 styrigx.com/* 再删短链两条：中间那几秒 /s/* 还在旧短链 Worker 上（和改之前一样），不会出现 /s/* 没人接的窗口。
 * 本 Worker 必须先存在（deploy.yml 先不带路由部署一次），不然改挂会被 Cloudflare 拒。
 *
 * 环境变量：CLOUDFLARE_API_TOKEN（同部署那一步：styrigx-space-core-deploy，有 styrigx.com 的 Workers Routes 编辑）；
 *   CLOUDFLARE_ACCOUNT_ID（区域查询带上 account.id，同 wrangler）；CF_ZONE_ID（可选，给了就不查区域）；
 *   CF_API_BASE（默认 https://api.cloudflare.com/client/v4，测试用）；ZONE_NAME（默认 styrigx.com）。
 * 只打印路由的 pattern / script / id，不打印 token。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const TARGET = 'styrigx-space-core';
export const MAIN_PATTERN = 'styrigx.com/*';
/** 原来 styrigx-share 的两条路由：接管后不该再有（/s/*、/api/share 由 styrigx-space-core 的 styrigx.com/* 接） */
export const SHARE_PATTERNS = Object.freeze(['styrigx.com/s/*', 'styrigx.com/api/share*']);
/** 只认这几个旧 Worker 名（别的 Worker 挂着这些路由 = 不认识的状态，停下来人工看） */
export const OLD_SCRIPTS = Object.freeze(['styrigx-auth-gateway', 'styrigx-share']);

const DEFAULT_API = 'https://api.cloudflare.com/client/v4';

/**
 * 现状 → 要做的事。
 * @param {{id:string, pattern:string, script?:string}[]} routes 区域里的全部 Worker 路由
 * @returns {{needed:boolean, main:any, share:any[], errors:string[]}}
 */
export function planOf(routes) {
  const errors = [];
  const main = routes.find((r) => r.pattern === MAIN_PATTERN) || null;
  const share = routes.filter((r) => SHARE_PATTERNS.includes(r.pattern));
  if (main && main.script && main.script !== TARGET && !OLD_SCRIPTS.includes(main.script)) {
    errors.push(MAIN_PATTERN + ' 挂在不认识的 Worker 上：' + main.script);
  }
  for (const r of share) {
    if (r.script && r.script !== TARGET && !OLD_SCRIPTS.includes(r.script)) errors.push(r.pattern + ' 挂在不认识的 Worker 上：' + r.script);
  }
  const needed = !!(main && main.script !== TARGET) || share.length > 0;
  return { needed, main, share, errors };
}

/**
 * 接管后的核对：styrigx.com/* → styrigx-space-core；没有短链两条。
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

/**
 * 回退时要还原的路由（只还原记下来时挂在旧 Worker 上的）。
 * @param {{main:any, share:any[]}} state takeover 记下的现状
 */
export function restorePlan(state) {
  const main = state && state.main && OLD_SCRIPTS.includes(state.main.script) ? { pattern: MAIN_PATTERN, script: state.main.script } : null;
  const share = ((state && state.share) || []).filter((r) => OLD_SCRIPTS.includes(r.script)).map((r) => ({ pattern: r.pattern, script: r.script }));
  return { main, share };
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
 * 旧网关、奇趣 / 日刻的部署 job 都用 zone_name 路由经同一个查询成功过，部署 token 只要有 styrigx.com 的 Workers Routes 编辑就够。
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

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n');
}

function arg(argv, name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : '';
}

async function main(argv) {
  const cmd = argv[0];
  const call = api();
  const zone = await zoneId(call);
  const before = await listRoutes(call, zone);
  console.log('routes on the zone (before):');
  show(before);
  if (cmd === 'plan') {
    const p = planOf(before);
    for (const e of p.errors) console.error('::error::' + e);
    if (p.errors.length) process.exit(1);
    console.log(p.needed ? 'takeover needed' : 'routes already belong to ' + TARGET);
    setOutput('needed', p.needed ? 'true' : 'false');
    return;
  }
  if (cmd === 'verify') {
    const errors = verifyRoutes(before);
    for (const e of errors) console.error('::error::' + e);
    if (errors.length) process.exit(1);
    console.log('OK: ' + MAIN_PATTERN + ' → ' + TARGET + ', no share routes');
    return;
  }
  const stateFile = arg(argv, 'state');
  if (!stateFile) throw new Error('--state <file> required');
  if (cmd === 'takeover') {
    const p = planOf(before);
    for (const e of p.errors) console.error('::error::' + e);
    if (p.errors.length) process.exit(1);
    writeFileSync(stateFile, JSON.stringify({ main: p.main, share: p.share }, null, 2));
    setOutput('taken', 'true');
    if (p.main && p.main.script !== TARGET) {
      await call('PUT', '/zones/' + zone + '/workers/routes/' + p.main.id, { pattern: MAIN_PATTERN, script: TARGET });
      console.log('moved ' + MAIN_PATTERN + ': ' + p.main.script + ' → ' + TARGET);
    } else if (!p.main) {
      await call('POST', '/zones/' + zone + '/workers/routes', { pattern: MAIN_PATTERN, script: TARGET });
      console.log('created ' + MAIN_PATTERN + ' → ' + TARGET);
    }
    for (const r of p.share) {
      await call('DELETE', '/zones/' + zone + '/workers/routes/' + r.id);
      console.log('deleted ' + r.pattern + ' (was → ' + (r.script || 'none') + ')');
    }
  } else if (cmd === 'restore') {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const want = restorePlan(state);
    const main = before.find((r) => r.pattern === MAIN_PATTERN);
    if (want.main && main && main.script !== want.main.script) {
      await call('PUT', '/zones/' + zone + '/workers/routes/' + main.id, want.main);
      console.log('restored ' + MAIN_PATTERN + ' → ' + want.main.script);
    }
    for (const r of want.share) {
      if (before.some((x) => x.pattern === r.pattern)) continue;
      await call('POST', '/zones/' + zone + '/workers/routes', r);
      console.log('re-created ' + r.pattern + ' → ' + r.script);
    }
  } else {
    throw new Error('usage: route-takeover.mjs plan | verify | takeover --state <file> | restore --state <file>');
  }
  const after = await listRoutes(call, zone);
  console.log('routes on the zone (after):');
  show(after);
  if (cmd === 'takeover') {
    const errors = verifyRoutes(after);
    for (const e of errors) console.error('::error::' + e);
    if (errors.length) process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('::error::route-takeover: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}
