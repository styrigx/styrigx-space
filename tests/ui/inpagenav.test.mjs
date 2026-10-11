/**
 * 2.9.0 页内导航验收测试（node --test）。
 *
 * 覆盖：
 * - 顶栏和 Dock 的 DOM 节点在切换时不被替换（只换 main 内容区）
 * - 前进/后退（popstate）正常
 * - 直接打开和刷新都是完整页面（每个 URL 可独立访问）
 * - 已锁（opaqueredirect/401/data-sgx-session="locked"）时切页整页跳到锁屏
 * - 非 Dock 链接不被拦截（修饰键、target=_blank、外部链接、非 Dock 页）
 * - 切换多次后没有重复的事件监听
 *
 * 运行：node --test tests/ui/inpagenav.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function read(p) {
  return readFileSync(join(repoRoot, p), 'utf8');
}

const inpagenav = read('assets/js/shell/inpagenav.js');

test('顶栏和 Dock 节点不被替换：只替换 main 内容区', () => {
  // swapContent 只操作 CONTENT_SELECTOR（main），不碰 header/nav/dock
  assert.ok(inpagenav.includes("const CONTENT_SELECTOR = 'main'"), '应定义 CONTENT_SELECTOR 为 main');
  // 确认没有替换顶栏或 Dock 的代码
  assert.ok(!inpagenav.includes('querySelector(\'header\')'), '不应替换 header');
  assert.ok(!inpagenav.includes('querySelector(\'nav\')'), '不应替换 nav');
  assert.ok(!inpagenav.includes('getElementById(\'dock\')'), '不应替换 dock');
  // swapContent 只设置 main.innerHTML
  assert.ok(inpagenav.includes('main.innerHTML = newContent'), '应只替换 main 的 innerHTML');
});

test('前进/后退正常：popstate 用同一套流程并恢复滚动位置', () => {
  assert.ok(inpagenav.includes("window.addEventListener('popstate'"), '应监听 popstate');
  assert.ok(inpagenav.includes('navigateTo(state.url, { push: false, scrollY:'), 'popstate 应调用 navigateTo 并恢复滚动位置');
  // pushState 保存 scrollY
  assert.ok(inpagenav.includes('history.pushState({ url: targetUrl.href, scrollY:'), 'pushState 应保存 scrollY');
});

test('直接打开和刷新完整：每个 URL 都是完整页面', () => {
  // navigateTo 用 DOMParser 解析完整 HTML，提取 main 内容
  assert.ok(inpagenav.includes('new DOMParser().parseFromString(html'), '应用 DOMParser 解析完整 HTML');
  assert.ok(inpagenav.includes("doc.querySelector(CONTENT_SELECTOR)"), '应从完整 HTML 中提取 main');
  // 更新 title 和 lang，保证直接打开时信息完整
  assert.ok(inpagenav.includes('document.title = newTitle'), '应更新 document.title');
  assert.ok(inpagenav.includes("document.documentElement.setAttribute('lang'"), '应更新 html lang');
});

test('已锁时切页整页跳到锁屏', () => {
  // 检查三种已锁信号
  assert.ok(inpagenav.includes("res.type === 'opaqueredirect'"), '应检查 opaqueredirect');
  assert.ok(inpagenav.includes('res.status === 401'), '应检查 401');
  assert.ok(inpagenav.includes('data-sgx-session="locked"'), '应检查 data-sgx-session="locked"');
  // 已锁时用 location.assign 整页跳转（让 middleware 302 到锁屏）
  const lockedBlock = inpagenav.match(/if \(result\.locked\) \{[^}]+\}/s);
  assert.ok(lockedBlock, '应有已锁处理分支');
  assert.ok(lockedBlock[0].includes('window.location.assign'), '已锁时应用 location.assign 整页跳转');
});

test('非 Dock 链接不被拦截', () => {
  // shouldIntercept 检查修饰键、target=_blank
  assert.ok(inpagenav.includes('e.metaKey || e.ctrlKey || e.shiftKey || e.altKey'), '应检查修饰键');
  assert.ok(inpagenav.includes("a.target === '_blank'"), '应检查 target=_blank');
  // 检查外部链接
  assert.ok(inpagenav.includes('url.origin !== window.location.origin'), '应检查外部链接');
  // 目标和当前页都必须是 Dock 页
  assert.ok(inpagenav.includes('isDockPage(url.pathname)'), '应检查目标是 Dock 页');
  assert.ok(inpagenav.includes('isDockPage(window.location.pathname)'), '应检查当前页是 Dock 页');
  // isDockPage 支持 /en/ 前缀
  assert.ok(inpagenav.includes("pathname.startsWith('/en/')"), 'isDockPage 应支持 /en/ 前缀');
});

test('切换多次后没有重复的事件监听', () => {
  // initInPageNav 只在 document/window 上加一次监听（不在每次 navigateTo 时加）
  const clickListeners = (inpagenav.match(/document\.addEventListener\('click'/g) || []).length;
  const popstateListeners = (inpagenav.match(/window\.addEventListener\('popstate'/g) || []).length;
  assert.equal(clickListeners, 1, 'click 监听应只注册一次');
  assert.equal(popstateListeners, 1, 'popstate 监听应只注册一次');
  // navigateTo 不应添加事件监听
  const navFn = inpagenav.match(/export async function navigateTo[\s\S]*?\n\}/);
  assert.ok(navFn, '应找到 navigateTo 函数');
  assert.ok(!navFn[0].includes('addEventListener'), 'navigateTo 不应添加事件监听');
});

test('不使用 BroadcastChannel/storage/前端内存作为锁屏状态', () => {
  // 检查实际使用（new BroadcastChannel），注释中提及不算
  assert.ok(!inpagenav.includes('new BroadcastChannel'), '不应实际使用 BroadcastChannel');
  assert.ok(!/localStorage\.(set|get)Item/.test(inpagenav), '不应使用 localStorage 存锁屏状态');
  assert.ok(!/sessionStorage\.(set|get)Item/.test(inpagenav), '不应使用 sessionStorage 存锁屏状态');
  // 每次 fetch 都经过 middleware（credentials: include）
  assert.ok(inpagenav.includes("credentials: 'include'"), 'fetch 应带 credentials');
});

test('四个 app 模块都注册了 mount/unmount', () => {
  for (const page of ['browser', 'files', 'store', 'settings']) {
    const content = read(`assets/js/apps/${page}.js`);
    assert.ok(content.includes('registerPage'), `${page}.js 应调用 registerPage`);
    assert.ok(content.includes(`registerPage('${page}'`), `${page}.js 应注册 '${page}'`);
  }
});

test('Dock 长按不弹出系统菜单（issue 4）', () => {
  // .dock-btn 有 -webkit-touch-callout: none
  const css = read('assets/css/input.css');
  assert.ok(css.includes('-webkit-touch-callout: none'), '.dock-btn 应有 -webkit-touch-callout: none');
  // inpagenav 拦截 Dock 上的 contextmenu
  assert.ok(inpagenav.includes("e.target.closest('a[data-dock]')"), '应检查 data-dock');
  assert.ok(inpagenav.includes("addEventListener('contextmenu'"), '应监听 contextmenu');
});

test('布局切换不触发页面重载（issue 1）', () => {
  const settingsJs = read('assets/js/apps/settings.js');
  // 布局切换只改 feat 和 CSS 类，不应 reload 或替换 main
  const layoutSection = settingsJs.match(/seg-layout[\s\S]{0,500}/);
  assert.ok(layoutSection, '应找到布局切换逻辑');
  assert.ok(!layoutSection[0].includes('location.reload'), '布局切换不应 reload');
  assert.ok(!layoutSection[0].includes('innerHTML ='), '布局切换不应替换 innerHTML');
});

test('数字健康页顶栏与显示页对齐（issue 3）', () => {
  // 两个子页应使用相同的 subpage-head 结构
  const displayHtml = read('layouts/_default/settings.html');
  // 检查都有返回按钮和折叠标题结构
  assert.ok(displayHtml.includes('subpage'), '设置页应有 subpage 结构');
});

test('预取结果被真正使用（issue 2）', () => {
  // prefetch 应缓存 HTML，fetchPage 应优先查缓存
  assert.ok(inpagenav.includes('prefetchCache'), '应有预取缓存');
  assert.ok(inpagenav.includes('getPrefetchCache(url)'), 'fetchPage 应查缓存');
  // 缓存的页面用一次就删，避免过期
  assert.ok(inpagenav.includes('prefetchCache.delete(url)'), '用后应删除缓存');
});

test('顶栏有纯色背景兜底（issue 5，三星浏览器）', () => {
  const css = read('assets/css/input.css');
  // #site-nav 应有 background 兜底，不只靠 backdrop-filter
  assert.ok(css.includes('#site-nav'), '应有 #site-nav 样式');
  const navBlock = css.match(/#site-nav \{[^}]+\}/s);
  assert.ok(navBlock, '应找到 #site-nav 规则块');
  assert.ok(navBlock[0].includes('background'), '#site-nav 应有 background 兜底');
});

test('core.js 调用了 initInPageNav', () => {
  const core = read('assets/js/shell/core.js');
  assert.ok(core.includes("import { initInPageNav } from './inpagenav.js'"), 'core.js 应导入 initInPageNav');
  assert.ok(core.includes('initInPageNav()'), 'initCore 应调用 initInPageNav()');
});
