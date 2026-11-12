#!/usr/bin/env node
/**
 * sgx-ui cookie 契约夹具（2026-10-22）：tests/fixtures/ui-cookie-contract.json。
 *
 * - writer 用例：在 Node 里给主站真写端 space/web/assets/shell/js/lib/ui-cookie.js 搭一个最小 window / localStorage / document.cookie，
 *   按 local（localStorage）跑 syncUiCookie()，记下它写出的 cookie 值——夹具里的 cookie 就是写端的真实产出。
 * - handmade 用例：写端写不出来的（旧 v1、v4 之前写端写的 mode / accent / mat、未知版本、乱码、字段不合法），手写。
 * - 每个用例带读端 space/web/assets/shell/js/lib/ui-cookie-read.js 的期望：read()、resolve(系统浅 / 深)、apply() 后 <html> 的状态。
 *   期望值是这里按契约写死的，不是拿读端自己算的（读端改错了，单测会和夹具对不上）。
 * - 共享外壳（gen-shell.mjs）把夹具原样带给子站，子站仓库可以跑同一套断言。
 *
 * 用法：node space/scripts/gen-ui-cookie-contract.mjs          重新生成
 *       node space/scripts/gen-ui-cookie-contract.mjs --check  只核对（写端产出变了 / 夹具被手改 → exit 1）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE = path.join(REPO, 'tests/fixtures/ui-cookie-contract.json');
const WRITER = path.join(REPO, 'space/web/assets/shell/js/lib/ui-cookie.js');
const ROLES = path.join(REPO, 'space/web/data/palette-roles.json');
/** 夹具生成时写端看到的固定时间（v4 起写端不再写 mat，留着只为把 Date.now 钉住） */
export const NOW = 1761062400000;

/** 读端期望的默认值（没有 cookie / 字段不合法）。2026-11-12 调色板 v4：mode / accent / mat 删除，读端忽略旧 cookie 里的这些字段 */
const V2 = (o) => ({ v: 2, pal: 'terra', fs: 'standard', rm: 0, lang: 'system', ...o });
/** 深套 id（palette-roles.json 里 mode = dark 的） */
const ROLES_DATA = JSON.parse(readFileSync(ROLES, 'utf8'));
const DARK = Object.keys(ROLES_DATA.presets).filter((id) => ROLES_DATA.presets[id].mode === 'dark');

/* 写端用例：local = 主站 localStorage；expect = 读端 read() 期望（省略的字段 = V2 默认） */
const WRITER_CASES = [
  { name: '空 localStorage → 默认 terra（深套）', local: {}, expect: {} },
  { name: '旧 sgx-theme-mode 残留不再带出去（v4）', local: { 'sgx-theme-mode': 'light' }, expect: {} },
  { name: '湖蓝 lake（深套）', local: { 'sgx-palette': 'lake' }, expect: { pal: 'lake' } },
  { name: '雾霾蓝 dustyblue（浅套）', local: { 'sgx-palette': 'dustyblue' }, expect: { pal: 'dustyblue' } },
  { name: '旧撞色 xforest → forest', local: { 'sgx-palette': 'xforest' }, expect: { pal: 'forest' } },
  { name: '冰川蓝 glacier（浅套）', local: { 'sgx-palette': 'glacier' }, expect: { pal: 'glacier' } },
  { name: '旧自定义主题色残留不再带出去（v4）', local: { 'sgx-accent': '#1F8A70', 'sgx-palette': 'xrose' }, expect: { pal: 'rose' } },
  {
    /* 2026-10-23 PR-E：字体大小 / 减弱动效设置删除 —— 本地残留的旧值写端不再带出去，fs / rm 固定默认 */
    name: '旧的大字号 + 减弱动效 key、已删的时钟 / 天气 key 都不再带出去（P4-2c）',
    local: {
      'sgx-font-size': 'large', 'sgx-reduced-motion': '1', 'sgx-tz1-auto': '0', 'sgx-tz1': 'Asia/Shanghai', 'sgx-tz2': 'America/Los_Angeles',
      'sgx-hour12': '12', 'sgx-gl-clockstyle': '1', 'sgx-weather-show': '0', 'sgx-temp-unit': 'f', 'sgx-weather-loc': 'city',
      'sgx-weather-city': '{"name":"上海","lat":31.23,"lon":121.47}',
    },
    expect: {},
  },
  { name: '本地存了不认识的色板 id（写端写默认 terra）', local: { 'sgx-palette': 'neon' }, expect: {} },
  /* 2026-10-27：lang = 主站用户明确选的语言（sgx-lang）。语言清理（2026-11-07）：跟随系统明确写 'system'（旧版写 ''，读端照样当跟随系统） */
  { name: '语言：明确选了 English → lang en', local: { 'sgx-lang': 'en' }, expect: { lang: 'en' } },
  { name: '语言：明确选了中文 → lang zh', local: { 'sgx-lang': 'zh', 'sgx-palette': 'sage' }, expect: { pal: 'sage', lang: 'zh' } },
  { name: '语言：跟随系统 → lang system', local: { 'sgx-lang': 'system' }, expect: {} },
  { name: '语言：旧版没存 / 存了不认识的值 → lang system', local: { 'sgx-lang': 'klingon' }, expect: {} },
];

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* 手写用例：cookie = sgx-ui 的值；read = 期望（null = 当没有 cookie）。旧 cookie（v4 之前的写端写的 mode / accent / mat）照样能读，那几个字段忽略 */
const HANDMADE = [
  { name: '没有 cookie', cookie: '', read: null },
  {
    name: '旧 v1（只有时钟 / 天气，没有外观）',
    cookie: b64({ v: 1, tz1: 'auto', tz2: 'Europe/London', h12: 0, clock: 'digital', wx: 1, unit: 'c', loc: 'auto', city: null, precise: null }),
    read: { ...V2(), v: 1 },
  },
  { name: '旧 v1 带 fs / rm', cookie: b64({ v: 1, tz1: 'auto', fs: 'large', rm: 1 }), read: { ...V2({ fs: 'large', rm: 1 }), v: 1 } },
  {
    name: '旧 v2（PR3 前，没有 accent）：mode 忽略，深浅按 forest',
    cookie: b64({ v: 2, tz1: 'auto', tz2: '', h12: 0, clock: 'digital', wx: 1, unit: 'c', loc: 'auto', city: null, precise: null, mode: 'light', pal: 'forest', fs: 'small', rm: 0, mat: 1750000000000 }),
    read: V2({ pal: 'forest', fs: 'small' }),
  },
  {
    name: '字段不合法 → 各自按默认',
    cookie: b64({ v: 2, mode: 'blue', pal: 'neon', accent: '#GGGGGG', fs: 'huge', rm: true, mat: -5, lang: 'f1', tz1: '../../etc', tz2: 5, h12: '1', clock: 'sundial', wx: 'no', unit: 'k', loc: 'SOME PLACE', city: [1, 2], precise: 'x' }),
    read: V2(),
  },
  { name: '旧 cookie：浅套 dustyblue + mode dark → 仍是浅套（mode 忽略）', cookie: b64({ v: 2, mode: 'dark', pal: 'dustyblue', accent: '#d4a72c', mat: 1750000000000 }), read: V2({ pal: 'dustyblue' }) },
  { name: '旧 cookie：深套 lake + mode light → 仍是深套（mode 忽略）', cookie: b64({ v: 2, mode: 'light', pal: 'lake', accent: '#2f5f86', mat: 1750000000000 }), read: V2({ pal: 'lake' }) },
  { name: '旧 cookie：撞色 xforest → forest', cookie: b64({ v: 2, mode: 'light', pal: 'xforest', accent: '#2f6b4f', mat: 1750000000000 }), read: V2({ pal: 'forest' }) },
  { name: '旧 cookie：xrose + 自定义色 → rose，自定义色忽略', cookie: b64({ v: 2, mode: 'dark', pal: 'xrose', accent: '#d0a020', mat: 1750000000000 }), read: V2({ pal: 'rose' }) },
  { name: '不认识的 x 开头 id（xneon）→ 默认', cookie: b64({ v: 2, pal: 'xneon' }), read: V2() },
  { name: 'theme 别名（旧博客契约）不认', cookie: b64({ v: 2, theme: 'light' }), read: V2() },
  { name: 'lang 大写 EN → 不认，按跟随系统（写端只写小写语言代码 / system）', cookie: b64({ v: 2, lang: 'EN' }), read: V2() },
  { name: '旧版跟随系统写的空 lang → system', cookie: b64({ v: 2, lang: '' }), read: V2() },
  { name: '以后加的语言（小写语言代码）读端照样带出来，是否配置由首帧 lang-boot 判断', cookie: b64({ v: 2, lang: 'ja' }), read: V2({ lang: 'ja' }) },
  { name: '旧 v1 带 lang → 照样认（读端不按版本挑字段）', cookie: b64({ v: 1, tz1: 'auto', lang: 'en' }), read: { ...V2({ lang: 'en' }), v: 1 } },
  { name: '未知版本 v3', cookie: b64({ v: 3, pal: 'forest' }), read: null },
  { name: '未知版本 v3 带 lang → 当没有 cookie（不跳语言）', cookie: b64({ v: 3, lang: 'en' }), read: null },
  { name: '版本是字符串 "2"', cookie: b64({ v: '2', pal: 'lake' }), read: null },
  { name: '没有 v', cookie: b64({ pal: 'forest' }), read: null },
  { name: 'JSON 是数组', cookie: b64([2, 'dark']), read: null },
  { name: 'base64 里不是 JSON', cookie: b64('hello world'), read: null },
  { name: '乱码（非 base64url 字符）', cookie: 'not%20base64!!', read: null },
  { name: '截断的 base64', cookie: b64({ v: 2, pal: 'lake' }).slice(0, 9), read: null },
];

/** 读端期望 → resolve / <html> 状态（契约：和主站 baseof 内联脚本一致）。
 *  v4：深浅只由调色板决定，系统浅 / 深两种情况的期望完全一样（夹具保留 light / dark 两份，单测据此核对不读 prefers-color-scheme） */
function expectations(read) {
  const out = {};
  for (const sys of ['light', 'dark']) {
    const pal = read ? read.pal : 'terra';
    const dark = DARK.includes(pal);
    const fs = read ? read.fs : 'standard';
    const rm = !!(read && read.rm === 1);
    out[sys] = {
      resolve: { dark, pal, fs, rm },
      root: {
        dark,
        'data-dark': dark ? '1' : '0',
        'data-font-size': fs,
        fontSize: fs === 'large' ? '112.5%' : fs === 'small' ? '87.5%' : '',
        'data-palette': pal === 'terra' ? null : pal,
        'reduced-motion': rm,
        'data-reduced-motion': rm ? '1' : '0',
      },
    };
  }
  return out;
}

/** 在最小 DOM 桩里跑主站真写端，返回它写出的 sgx-ui 值 */
async function runWriter(cases) {
  const store = new Map();
  let jar = '';
  const g = /** @type {any} */ (globalThis);
  const saved = { window: g.window, document: g.document, localStorage: g.localStorage, getComputedStyle: g.getComputedStyle, now: Date.now };
  g.window = g;
  g.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  g.document = {
    documentElement: {},
    get cookie() { return jar; },
    set cookie(v) { const m = String(v).match(/^sgx-ui=([^;]*)/); if (m) jar = 'sgx-ui=' + m[1]; },
  };
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  Date.now = () => NOW;
  try {
    const { syncUiCookie } = await import(pathToFileURL(WRITER).href + '?contract=' + process.pid);
    const out = [];
    for (const c of cases) {
      store.clear();
      jar = '';
      for (const [k, v] of Object.entries(c.local)) store.set(k, v);
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
  const written = await runWriter(WRITER_CASES);
  const cases = [
    ...WRITER_CASES.map((c, i) => {
      const read = V2(c.expect);
      return { name: c.name, source: 'writer', local: c.local, cookie: written[i], read, ...expectations(read) };
    }),
    ...HANDMADE.map((c) => ({ name: c.name, source: 'handmade', cookie: c.cookie, read: c.read, ...expectations(c.read) })),
  ];
  const doc = {
    _generated: 'styrigx-space space/scripts/gen-ui-cookie-contract.mjs ← space/web/assets/shell/js/lib/ui-cookie.js（写端真实产出）；勿手改',
    _doc: 'cookie = sgx-ui 的值（document.cookie 里 sgx-ui= 后面那段）。read = SgxUI.read() 的期望（null = 当没有 cookie）；light / dark = 系统浅 / 深色时 SgxUI.resolve() 和 SgxUI.apply() 后 <html> 的期望（v4 起两者相同：深浅只由调色板决定）。root.dark / reduced-motion = class；fontSize = style.fontSize；data-palette null = 不写。',
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
      console.error('tests/fixtures/ui-cookie-contract.json 和写端产出不一致；运行 node space/scripts/gen-ui-cookie-contract.mjs');
      process.exit(1);
    }
    console.log('ui-cookie contract in sync:', JSON.parse(text).cases.length, 'cases');
  } else {
    writeFileSync(FIXTURE, text);
    console.log('tests/fixtures/ui-cookie-contract.json regenerated:', JSON.parse(text).cases.length, 'cases');
  }
}
