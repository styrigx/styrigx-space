/**
 * P4-3 PR-4b（§6.4 / §6.5，§8 第 6 条）：主页和设置合成「旷野 / Space」，原设置子页去掉 settings 一层挂到根下。
 * - 单一数据源对得上：data/space-cats.yaml 的分类 ↔ content 的 url ↔ lib/wb-area.js SPACE_SUB_RE
 * - 根下新路径不和子站前缀、账号页、各 Worker 路由、网关转发表、静态目录、_redirects 的旧跳转撞名
 * - 构建产物（有才跑；CI 在拼树之后补跑）：没有 settings/ 目录；任何 HTML 都没有指向旧设置层的 href；新地址都在
 * - 全仓 git grep 旧设置层地址只剩历史文档
 * 运行：node --test tests/space/ui/build/space-merge.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const rd = (/** @type {string} */ p) => readFileSync(path.join(REPO, p), 'utf8');
/* 旧设置层（不直接写成字面量，免得本文件自己出现在 git grep 结果里） */
const OLD = 'settings';
const OLD_PATH = '/' + OLD + '/';

const cats = /** @type {any} */ (yaml.load(rd('space/web/data/space-cats.yaml'))).cats.map((/** @type {any} */ c) => String(c.id));
/** 旷野页之下的新地址（英文；中文前加 /zh，P4-3 PR-4c） */
const NEW_PATHS = [...cats.map((c) => '/' + c + '/'), '/security/lock/', '/security/tempkeys/'];

/**
 * 根下已被占用的首段：子站、账号、语言前缀、Worker 路由、网关转发表、静态目录、Hugo 产物目录、_redirects 旧跳转的来源。
 * @returns {Map<string, string>} 首段 → 来源
 */
export function reservedSegments() {
  /** @type {Map<string, string>} */
  const m = new Map();
  const add = (/** @type {string} */ seg, /** @type {string} */ why) => {
    if (!seg) return;
    m.set(seg, m.has(seg) ? m.get(seg) + '；' + why : why);
  };
  for (const s of ['blog', 'curio', 'daymark']) add(s, '子站前缀');
  add('account', '账号页（/account/… 不变）');
  for (const s of ['en', 'zh']) add(s, '语言前缀');
  /* 各 Worker 的 [[routes]]：styrigx.com/<段>/… */
  for (const w of readdirSync(path.join(REPO, 'workers'))) {
    const f = path.join(REPO, 'workers', w, 'wrangler.toml');
    if (!existsSync(f)) continue;
    for (const mm of readFileSync(f, 'utf8').matchAll(/pattern\s*=\s*"styrigx\.com\/([^"/*]*)/g)) add(mm[1], `Worker ${w} 路由`);
  }
  /* 网关转发表 FORWARDING（/api/…、/avatar/） */
  for (const mm of rd('workers/auth-gateway/src/router.js').matchAll(/path: '\/([^/']+)/g)) add(mm[1], '网关转发表');
  add('api', '网关 /api/*');
  /* Pages 静态目录（主站 static）和 Hugo 产物里的目录 */
  for (const n of readdirSync(path.join(REPO, 'space/web/static'))) add(n, 'space/web/static');
  for (const n of ['js', 'css', 'fonts', 'images', 'fav', 'avatar', 'categories', 'tags']) add(n, 'Hugo 产物目录');
  /* _redirects 的来源首段（新页面不能被旧跳转盖住） */
  for (const line of rd('space/web/static/_redirects').split('\n')) {
    const src = line.trim().split(/\s+/)[0] || '';
    if (!src.startsWith('/')) continue;
    add(src.replace(/^\/(en\/)?/, '').split('/')[0].replace(/\*$/, ''), '_redirects 来源 ' + src);
  }
  return m;
}

test('space-cats.yaml ↔ content url ↔ SPACE_SUB_RE 一致；没有 settings 一层', async () => {
  assert.deepEqual([...cats].sort(), ['security', 'wild'], '对齐 PR-B：数字健康 / 服务状态 / 关于本站并进 /wild/；对齐 PR-C：风格页 /theme/ 退役');
  const { SPACE_SUB_RE, wbAreaOf } = await import(pathToFileURL(path.join(REPO, 'space/web/assets/js/lib/wb-area.js')).href);
  for (const p of NEW_PATHS) {
    assert.ok(SPACE_SUB_RE.test(p) && SPACE_SUB_RE.test('/zh' + p), p + ' 应算旷野子页');
    assert.equal(wbAreaOf(p), 'space', p);
  }
  /* content：中英两份，url 都是新地址 */
  const urls = [];
  for (const dir of ['space/web/content', 'space/web/content/zh']) {
    for (const f of readdirSync(path.join(REPO, dir))) {
      if (!f.endsWith('.md')) continue;
      assert.ok(!f.startsWith(OLD), `${dir}/${f}：内容文件不再有 settings 前缀`);
      const m = rd(dir + '/' + f).match(/^url:\s*(\S+)/m);
      if (m) urls.push(m[1]);
    }
  }
  for (const p of NEW_PATHS) {
    assert.ok(urls.includes(p), 'content 里有 ' + p);
    assert.ok(urls.includes('/zh' + p), 'content 里有 /zh' + p);
  }
  assert.ok(!urls.some((u) => u.includes(OLD_PATH)), 'content 里没有旧设置层地址');
  /* 顶栏没有标签了（页名胶囊只显示页名，Gray 2026-11-07）：topbar-tabs 数据 / 模板删除 */
  assert.ok(!existsSync(path.join(REPO, 'space/web/data/topbar-tabs.yaml')), 'topbar-tabs.yaml 已删');
  assert.ok(!existsSync(path.join(REPO, 'space/web/layouts/partials/topbar-tabs.html')), 'topbar-tabs.html 已删');
  /* _redirects：/owner/ 指向新锁屏凭证页；没有任何一条跳到旧设置层 */
  const red = rd('space/web/static/_redirects');
  assert.match(red, /^\/owner\/\s+\/security\/lock\/\s+301$/m);
  /* P4-3 PR-4c：/en/… 旧地址删除不 301，_redirects 里没有 /en/ 开头的规则 */
  assert.doesNotMatch(red, /^\/en\//m);
  assert.ok(!red.includes(OLD_PATH), '_redirects 里没有旧设置层');
  /* 对齐 PR-B：旧的三页 301 到旷野对应的锚点（中英） */
  for (const [old, anchor] of [['status', 'status'], ['about', 'about'], ['wellbeing', 'screen-time']]) {
    assert.match(red, new RegExp(`^/${old}/\\s+/wild/#${anchor}\\s+301$`, 'm'), `/${old}/ → /wild/#${anchor}`);
    assert.match(red, new RegExp(`^/zh/${old}/\\s+/zh/wild/#${anchor}\\s+301$`, 'm'), `/zh/${old}/ → /zh/wild/#${anchor}`);
  }
});

test('根下新路径不和子站、账号、Worker 路由、转发表、静态目录、旧跳转撞名', () => {
  const reserved = reservedSegments();
  for (const c of cats) assert.ok(!reserved.has(c), `/${c}/ 撞上了 ${reserved.get(c)}`);
  /* /status/ 与状态 Worker：状态 Worker 没有 styrigx.com 路由，接口是网关的 /api/status（首段 api），不同名 */
  assert.ok(!/pattern/.test(rd('workers/status/wrangler.toml')), '状态 Worker 不占 styrigx.com 路由');
});

/* ---- 构建产物（npm run build / hugo 之后才有；CI 在拼树之后补跑这个文件） ---- */
const PUBS = ['space/web/public', 'space/web/public/blog', 'space/web/public/curio', 'space/web/public/daymark', 'space/web/public'].filter((p) => existsSync(path.join(REPO, p)));
const BUILT = existsSync(path.join(REPO, 'space/web/public/index.html'));

/** @param {string} dir @returns {string[]} */
function htmlFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (n.endsWith('.html')) out.push(p);
  }
  return out;
}

test('构建产物：没有 settings/ 目录，任何 HTML 都没有 href 指向旧设置层；新地址都在', { skip: !BUILT && '没构建 space/web/public' }, () => {
  for (const pub of PUBS) {
    for (const pre of ['', 'zh/', 'en/']) assert.ok(!existsSync(path.join(REPO, pub, pre + OLD)), `${pub}/${pre}${OLD}/ 不该存在`);
  }
  for (const p of NEW_PATHS) {
    for (const pre of ['', '/zh']) assert.ok(existsSync(path.join(REPO, 'space/web/public', pre + p, 'index.html')), '缺 ' + pre + p);
  }
  const bad = [];
  let n = 0;
  const re = new RegExp('href="?/((en|zh)/)?' + OLD + '/');
  for (const pub of PUBS) {
    for (const f of htmlFiles(path.join(REPO, pub))) {
      n++;
      if (re.test(readFileSync(f, 'utf8'))) bad.push(path.relative(REPO, f));
    }
  }
  assert.ok(n > 20, '应扫到一批 HTML');
  assert.deepEqual(bad, [], '这些页面还有指向旧设置层的链接');
  /* 主页：页名、顶栏没有标签；对齐 PR-B 起主页叫「主页 / Home」，安全（顶栏盾牌）和旷野（[04] 一节）有入口；旧三页不再生成 */
  /* P4-3 PR-4c：英文在根，中文在 /zh/ */
  const home = readFileSync(path.join(REPO, 'space/web/public/zh/index.html'), 'utf8');
  assert.match(home, /<title>主页 \| Styrigx<\/title>/);
  assert.match(home, /<span class="?sgx-tb-title"?>主页<\/span>/);
  assert.doesNotMatch(home, /sgx-tb-tab/);
  for (const c of ['security', 'wild']) assert.ok(home.includes(`href="/zh/${c}/"`), '主页有 /zh/' + c + '/ 入口');
  const en = readFileSync(path.join(REPO, 'space/web/public/index.html'), 'utf8');
  assert.match(en, /<title>Home \| Styrigx<\/title>/);
  for (const c of ['security', 'wild']) assert.ok(en.includes(`href="/${c}/"`), '主页有 /' + c + '/ 入口');
  for (const old of ['status', 'about', 'wellbeing']) for (const pre of ['', 'zh/']) {
    assert.ok(!existsSync(path.join(REPO, 'space/web/public', pre + old, 'index.html')), `${pre}${old}/ 不再生成（301 到旷野）`);
  }
});

/* ---- 全仓：旧设置层地址只允许出现在历史文档 ---- */
const HISTORY = new Set(['docs/styrigx-3.0-task.md']);
const HAS_GIT = existsSync(path.join(REPO, '.git'));

test('git grep 旧设置层地址：只剩历史文档', { skip: !HAS_GIT && '不是 git 工作区' }, () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-l', '-F', OLD_PATH], { cwd: REPO, encoding: 'utf8' });
  } catch (e) {
    /* 没有匹配时 git grep 退出码 1 */
    out = /** @type {any} */ (e).stdout || '';
  }
  const files = out.split('\n').filter(Boolean);
  assert.deepEqual(files.filter((f) => !HISTORY.has(f)), [], '除历史文档外不许再出现旧设置层地址');
});
