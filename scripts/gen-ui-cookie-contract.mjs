#!/usr/bin/env node
/**
 * sgx-ui cookie 契约夹具（2026-10-22）：tests/fixtures/ui-cookie-contract.json。
 *
 * - writer 用例：在 Node 里给主站真写端 web/assets/js/lib/ui-cookie.js 搭一个最小 window / localStorage / document.cookie，
 *   按 local（localStorage）跑 syncUiCookie()，记下它写出的 cookie 值——夹具里的 cookie 就是写端的真实产出。
 * - handmade 用例：写端写不出来的（旧 v1、旧 v2 没有 accent、未知版本、乱码、字段不合法），手写。
 * - 每个用例带读端 web/assets/js/lib/ui-cookie-read.js 的期望：read()、resolve(系统浅 / 深)、apply() 后 <html> 的状态。
 *   期望值是这里按契约写死的，不是拿读端自己算的（读端改错了，单测会和夹具对不上）。
 * - 共享外壳（gen-shell.mjs）把夹具原样带给子站，子站仓库可以跑同一套断言。
 *
 * 用法：node scripts/gen-ui-cookie-contract.mjs          重新生成
 *       node scripts/gen-ui-cookie-contract.mjs --check  只核对（写端产出变了 / 夹具被手改 → exit 1）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(REPO, 'tests/fixtures/ui-cookie-contract.json');
const WRITER = path.join(REPO, 'web/assets/js/lib/ui-cookie.js');
const ROLES = path.join(REPO, 'web/data/palette-roles.json');
/** 夹具里 mat 用的固定时间（写端第一次写时记 Date.now()） */
export const NOW = 1761062400000;

/** 读端期望的默认值（没有 cookie / 字段不合法） */
const BASE = { tz1: 'auto', tz2: '', h12: 0, clock: 'digital', wx: 1, unit: 'c', loc: 'auto', city: null, precise: null };
const V2 = (o) => ({ v: 2, mode: 'system', pal: 'lake', accent: '', fs: 'standard', rm: 0, mat: NOW, ...BASE, ...o });

/* 写端用例：local = 主站 localStorage；expect = 读端 read() 期望（省略的字段 = V2 默认） */
const WRITER_CASES = [
  { name: 'lake 亮色', local: { 'sgx-theme-mode': 'light' }, expect: { mode: 'light', accent: '#2f5f86' } },
  { name: 'lake 深色', local: { 'sgx-theme-mode': 'dark' }, expect: { mode: 'dark', accent: '#2f5f86' } },
  { name: '跟随系统（空 localStorage）', local: {}, expect: { accent: '#2f5f86' } },
  { name: '撞色 xforest 亮色', local: { 'sgx-theme-mode': 'light', 'sgx-palette': 'xforest' }, expect: { mode: 'light', pal: 'xforest', accent: '#2f6b4f' } },
  { name: '撞色 xforest 深色', local: { 'sgx-theme-mode': 'dark', 'sgx-palette': 'xforest' }, expect: { mode: 'dark', pal: 'xforest', accent: '#2f6b4f' } },
  { name: '单色 violet 跟随系统', local: { 'sgx-theme-mode': 'system', 'sgx-palette': 'violet' }, expect: { pal: 'violet', accent: '#6750a4' } },
  { name: '自定义主题色（lake 上）', local: { 'sgx-accent': '#1F8A70' }, expect: { accent: '#1f8a70' } },
  { name: '自定义主题色（撞色 xrose 上，深色）', local: { 'sgx-theme-mode': 'dark', 'sgx-palette': 'xrose', 'sgx-accent': '#d0a020' }, expect: { mode: 'dark', pal: 'xrose', accent: '#d0a020' } },
  {
    /* 2026-10-23 PR-E：字体大小 / 减弱动效设置删除 —— 本地残留的旧值写端不再带出去，fs / rm 固定默认 */
    name: '旧的大字号 + 减弱动效 key 不再生效 + 时钟 / 天气字段（中文城市名）',
    local: {
      'sgx-font-size': 'large', 'sgx-reduced-motion': '1', 'sgx-tz1-auto': '0', 'sgx-tz1': 'Asia/Shanghai', 'sgx-tz2': 'America/Los_Angeles',
      'sgx-hour12': '12', 'sgx-gl-clockstyle': '1', 'sgx-weather-show': '0', 'sgx-temp-unit': 'f', 'sgx-weather-loc': 'city',
      'sgx-weather-city': '{"name":"上海","lat":31.23,"lon":121.47}',
    },
    expect: { accent: '#2f5f86', tz1: 'Asia/Shanghai', tz2: 'America/Los_Angeles', h12: 1, clock: 'analog', wx: 0, unit: 'f', loc: 'city', city: { name: '上海', lat: 31.23, lon: 121.47 } },
  },
  { name: '旧的小字号 key 不再生效', local: { 'sgx-font-size': 'small', 'sgx-theme-mode': 'light' }, expect: { mode: 'light', accent: '#2f5f86' } },
  { name: '本地存了不认识的色板 id（写端写 lake）', local: { 'sgx-palette': 'neon', 'sgx-theme-mode': 'dark' }, expect: { mode: 'dark', accent: '#2f5f86' } },
];

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* 手写用例：cookie = sgx-ui 的值；read = 期望（null = 当没有 cookie） */
const HANDMADE = [
  { name: '没有 cookie', cookie: '', read: null },
  {
    name: '旧 v1（只有时钟 / 天气，没有外观）',
    cookie: b64({ v: 1, tz1: 'auto', tz2: 'Europe/London', h12: 0, clock: 'digital', wx: 1, unit: 'c', loc: 'auto', city: null, precise: null }),
    read: { ...V2({ tz2: 'Europe/London' }), v: 1, mat: 0, accent: '' },
  },
  {
    name: '旧 v1 带 fs / rm',
    cookie: b64({ v: 1, tz1: 'auto', fs: 'large', rm: 1 }),
    read: { ...V2({ fs: 'large', rm: 1 }), v: 1, mat: 0 },
  },
  {
    name: '旧 v2（PR3 前，没有 accent）',
    cookie: b64({ v: 2, tz1: 'auto', tz2: '', h12: 0, clock: 'digital', wx: 1, unit: 'c', loc: 'auto', city: null, precise: null, mode: 'dark', pal: 'forest', fs: 'small', rm: 0, mat: 1750000000000 }),
    read: V2({ mode: 'dark', pal: 'forest', fs: 'small', mat: 1750000000000 }),
  },
  {
    name: '字段不合法 → 各自按默认',
    cookie: b64({ v: 2, mode: 'blue', pal: 'neon', accent: '#GGGGGG', fs: 'huge', rm: true, mat: -5, tz1: '../../etc', tz2: 5, h12: '1', clock: 'sundial', wx: 'no', unit: 'k', loc: 'SOME PLACE', city: [1, 2], precise: 'x' }),
    read: { ...V2({ mat: 0 }), wx: 1 },
  },
  { name: 'accent 大写 → 严格校验不认（写端永远写小写）', cookie: b64({ v: 2, pal: 'lake', accent: '#2F5F86', mode: 'light' }), read: V2({ mode: 'light', mat: 0 }) },
  { name: 'accent 简写 #abc → 不认', cookie: b64({ v: 2, accent: '#abc' }), read: V2({ mat: 0 }) },
  { name: 'theme 别名（旧博客契约）不认，只看 mode', cookie: b64({ v: 2, theme: 'dark' }), read: V2({ mat: 0 }) },
  { name: '未知版本 v3', cookie: b64({ v: 3, mode: 'dark', pal: 'forest' }), read: null },
  { name: '版本是字符串 "2"', cookie: b64({ v: '2', mode: 'dark' }), read: null },
  { name: '没有 v', cookie: b64({ mode: 'dark', pal: 'forest' }), read: null },
  { name: 'JSON 是数组', cookie: b64([2, 'dark']), read: null },
  { name: 'base64 里不是 JSON', cookie: b64('hello world'), read: null },
  { name: '乱码（非 base64url 字符）', cookie: 'not%20base64!!', read: null },
  { name: '截断的 base64', cookie: b64({ v: 2, mode: 'dark' }).slice(0, 9), read: null },
];

/** 读端期望 → resolve / <html> 状态（契约：和主站 baseof 内联脚本一致） */
function expectations(read, seeds) {
  const out = {};
  for (const sys of ['light', 'dark']) {
    const mode = read ? read.mode : 'system';
    const pal = read ? read.pal : 'lake';
    const acc = read ? read.accent : '';
    const dark = mode === 'dark' || (mode === 'system' && sys === 'dark');
    const fs = read ? read.fs : 'standard';
    const rm = !!(read && read.rm === 1);
    const seed = acc && acc !== seeds[pal] ? acc : '';
    out[sys] = {
      resolve: { mode, dark, pal, fs, rm, seed },
      root: {
        dark,
        'data-theme-mode': mode,
        'data-dark': dark ? '1' : '0',
        'data-font-size': fs,
        fontSize: fs === 'large' ? '112.5%' : fs === 'small' ? '87.5%' : '',
        'data-palette': pal === 'lake' ? null : pal,
        '--sgx-seed': seed,
        'reduced-motion': rm,
        'data-reduced-motion': rm ? '1' : '0',
      },
    };
  }
  return out;
}

/** 在最小 DOM 桩里跑主站真写端，返回它写出的 sgx-ui 值 */
async function runWriter(cases, seeds) {
  const store = new Map();
  let jar = '';
  let pal = 'lake';
  const g = /** @type {any} */ (globalThis);
  const saved = { window: g.window, document: g.document, localStorage: g.localStorage, getComputedStyle: g.getComputedStyle, now: Date.now };
  g.window = g;
  g.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  g.document = {
    documentElement: {},
    get cookie() { return jar; },
    set cookie(v) { const m = String(v).match(/^sgx-ui=([^;]*)/); if (m) jar = 'sgx-ui=' + m[1]; },
  };
  /* 主站页面上 <html> 的 --sgx-seed = 当前预设的种子（tokens 层；未知 id 没有匹配的规则 → 默认 lake） */
  g.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--sgx-seed' ? ' ' + (seeds[pal] || seeds.lake) : '') });
  Date.now = () => NOW;
  try {
    const { syncUiCookie } = await import(pathToFileURL(WRITER).href + '?contract=' + process.pid);
    const out = [];
    for (const c of cases) {
      store.clear();
      jar = '';
      for (const [k, v] of Object.entries(c.local)) store.set(k, v);
      pal = c.local['sgx-palette'] || 'lake';
      syncUiCookie();
      out.push(jar.replace(/^sgx-ui=/, ''));
    }
    return out;
  } finally {
    Object.assign(g, { window: saved.window, document: saved.document, localStorage: saved.localStorage, getComputedStyle: saved.getComputedStyle });
    for (const k of ['window', 'document', 'localStorage', 'getComputedStyle']) if (saved[k] === undefined) delete g[k];
    Date.now = saved.now;
  }
}

export async function renderContract() {
  const roles = JSON.parse(readFileSync(ROLES, 'utf8'));
  const seeds = Object.fromEntries(Object.entries(roles.presets).map(([id, p]) => [id, p.seed]));
  const written = await runWriter(WRITER_CASES, seeds);
  const cases = [
    ...WRITER_CASES.map((c, i) => {
      const read = V2(c.expect);
      return { name: c.name, source: 'writer', local: c.local, cookie: written[i], read, ...expectations(read, seeds) };
    }),
    ...HANDMADE.map((c) => ({ name: c.name, source: 'handmade', cookie: c.cookie, read: c.read, ...expectations(c.read, seeds) })),
  ];
  const doc = {
    _generated: 'styrigx-space scripts/gen-ui-cookie-contract.mjs ← web/assets/js/lib/ui-cookie.js（写端真实产出）；勿手改',
    _doc: 'cookie = sgx-ui 的值（document.cookie 里 sgx-ui= 后面那段）。read = SgxUI.read() 的期望（null = 当没有 cookie）；light / dark = 系统浅 / 深色时 SgxUI.resolve() 和 SgxUI.apply() 后 <html> 的期望。root.dark / reduced-motion = class；fontSize = style.fontSize；--sgx-seed = 内联变量（\'\' = 没有）；data-palette null = 不写。',
    now: NOW,
    cases,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const text = await renderContract();
  if (process.argv.includes('--check')) {
    if (!existsSync(FIXTURE) || readFileSync(FIXTURE, 'utf8') !== text) {
      console.error('tests/fixtures/ui-cookie-contract.json 和写端产出不一致；运行 node scripts/gen-ui-cookie-contract.mjs');
      process.exit(1);
    }
    console.log('ui-cookie contract in sync:', JSON.parse(text).cases.length, 'cases');
  } else {
    writeFileSync(FIXTURE, text);
    console.log('tests/fixtures/ui-cookie-contract.json regenerated:', JSON.parse(text).cases.length, 'cases');
  }
}
