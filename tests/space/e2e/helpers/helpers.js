/**
 * Hark：CI 测试共用 helper（tests/helpers.js）。
 * - blockExternalRequests(page)：拦截所有非 localhost 的外部请求
 *   （天气 API、Google favicon、外部字体/CDN），避免
 *   networkidle 永远等不到，也避免外部波动影响测试和截图。
 *   favicon 返回本地占位图，保证截图稳定。
 * - freezeTime(page)：冻结时间到 2026-10-09 12:00:00+08:00（init script 换掉 window.Date：Date.now / new Date() 恒为该时刻，
 *   计时器照常走；不用 page.clock，它会把 performance 一起换掉；时刻本身带 +08:00，与运行机时区无关；页面里的显示时区由 playwright.config.js 的 timezoneId 固定为 Asia/Shanghai）。
 * - 确定性等待（C8：替代固定时长的 waitForTimeout / networkidle）：
 *   nextFrames(page, n)       等页面再渲染 n 帧（同步事件处理之后的 rAF / 样式更新都已落地）；
 *   animationsDone(page)      等文档里所有有限时长的动画 / 过渡（含 view transition 伪元素）结束；
 *   scrolledTo(page, y)       等 scrollTo 落地（含 CSS smooth 滚动），y 省略 = 滚到底；
 *   flushRequests(page)       请求冲刷屏障：页面再发一个探针请求并等 Playwright 收到它——之前页面发出的请求事件都已投递，
 *                             用来断言「没有发某个请求」；
 *   armNavProbe(page)         在当前文档上记 Navigation API 的 navigate 事件（链接 / location.* / pushState 都会同步触发），
 *                             返回读取函数；用来断言「点了不跳转」。文档已被换掉时读取函数返回 null。
 *   langBootStayed(page)      首帧语言跳转（lang-boot.js，<head> 里同步跑）已跑完且没跳：用来断言「打开这页不换语言」；
 *   openPages(page)           这个浏览器上下文里现在有几个页面（CDP Target.getTargets，浏览器同步记账，不等 Playwright 的 page 事件）；
 *                             用来断言「没开第二个窗口」；
 *   musicHandshakes(page)     记本页之后发的播放器握手 player-hello，返回等待函数：等到每一次都有播放器回了 player-state
 *                             （交接 reach() 已收尾，不会再到点开窗）。
 *
 * - setHomeCards(page, { daymark })：模拟首页日刻有没有数据（true = 显示，false = .hidden）。
 *   测试构建（SGX_TEST_NO_WEATHER=1）不输出日刻卡，就在 [03] 日刻分节里补一个同 id 的占位（和真的一样是 .home-qt 引言，
 *   高度 96），再按参数切 .hidden —— 和 daymark-today.js 显隐真卡的方式一致。（P4-2c 起双时钟、天气已删）
 *
 * 注意：/api/* 的 mock 由各测试自己在测试体内注册（注册顺序靠后，
 * Playwright 按注册倒序匹配，mock 会优先于本 helper 的通配拦截生效）。
 */
const { expect } = require('@playwright/test');

/* 1x1 透明 PNG（favicon 占位） */
const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * 拦截外部请求：非 localhost 一律 abort；localhost 的 favicon
 * 返回本地占位图，其余放行。
 */
async function blockExternalRequests(page) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    try {
      const u = new URL(url);
      const host = u.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
        /* favicon 返回本地占位图，保证截图稳定 */
        if (u.pathname.endsWith('.ico') || u.pathname.includes('favicon')) {
          await route.fulfill({ contentType: 'image/png', body: FAVICON_PNG });
          return;
        }
        await route.continue();
        return;
      }
    } catch (e) {
      /* URL 解析失败的一律 abort */
    }
    await route.abort();
  });
}

/** 冻结的时刻（带时区偏移的 ISO 字符串：绝对时刻，不随运行机 TZ 变） */
const FROZEN_AT = '2026-10-09T12:00:00+08:00';

/**
 * 冻结时间：2026-10-09 12:00:00+08:00（只换 window.Date：Date.now / new Date() 恒为该时刻，计时器照常走）。
 * 不用 page.clock.setFixedTime：Playwright 的假时钟连 performance 一起换掉，getEntriesByType() 恒为空——
 * inpage-tabs 的 settle()（读 Resource Timing）、导航类型 / loadEventStart 断言全部拿不到东西（PR #228 CI，2026-10-28）。
 * 需要推进时间的用例直接用 page.clock，且不要和本函数同用（见 space-status / lock-reset-pk-busy）。
 */
async function freezeTime(page) {
  await page.addInitScript((at) => {
    const frozen = new Date(at).getTime();
    const RealDate = Date;
    // @ts-ignore
    window.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(frozen);
        else super(...args);
      }
      static now() { return frozen; }
    };
  }, FROZEN_AT);
}

/** 等页面再渲染 n 帧 @param {import('@playwright/test').Page} page @param {number} [n] */
async function nextFrames(page, n = 2) {
  await page.evaluate((k) => new Promise((resolve) => {
    let i = 0;
    const step = () => { if (++i >= k) resolve(undefined); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

/**
 * 等文档里正在跑的有限时长动画 / 过渡结束（无限循环的、暂停的不等）。结束时可能又起新的（过渡接过渡），最多复查几轮。
 * @param {import('@playwright/test').Page} page
 */
async function animationsDone(page) {
  await page.evaluate(async () => {
    for (let round = 0; round < 6; round++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      const list = document.getAnimations().filter((a) => {
        if (a.playState !== 'running' && a.playState !== 'pending') return false;
        const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : 0;
        return Number.isFinite(Number(end));
      });
      if (!list.length) return;
      await Promise.all(list.map((a) => a.finished.catch(() => {})));
    }
  });
}

/**
 * 等 window 滚动落地：y 给了就等 scrollY 到 min(y, 最大可滚)，没给就等滚到底（±1px）。
 * @param {import('@playwright/test').Page} page @param {number} [y]
 */
async function scrolledTo(page, y) {
  await page.waitForFunction((target) => {
    const se = document.scrollingElement || document.documentElement;
    const max = Math.max(0, se.scrollHeight - window.innerHeight);
    const want = target == null ? max : Math.min(target, max);
    return Math.abs(window.scrollY - want) <= 1;
  }, y == null ? null : y);
  /* 滚动事件按帧派发：再等一帧，scroll 监听（顶栏等）跑完 */
  await nextFrames(page, 1);
}

let barrierSeq = 0;
/**
 * 请求冲刷屏障：页面发一个同源探针请求（本函数自己 fulfill 204），等 Playwright 收到它的 request 事件。
 * 页面里先发出的请求，request 事件按发出顺序先投递——之后再看 page.on('request') 记下的东西就不会漏掉「已经发了但还没投递」的。
 * @param {import('@playwright/test').Page} page
 */
async function flushRequests(page) {
  const url = new URL('/__c8-barrier__/' + (++barrierSeq), page.url()).href;
  await page.route(url, (r) => r.fulfill({ status: 204, body: '' }), { times: 1 });
  const seen = page.waitForRequest(url);
  /* 发探针时文档正好被换掉（evaluate 抛错）：先给 seen 挂上空处理，免得它在用例结束时成了没人接的拒绝 */
  seen.catch(() => {});
  await page.evaluate((u) => { fetch(u, { cache: 'no-store' }).catch(() => {}); }, url);
  await seen;
}

/**
 * 在当前文档上记 navigate 事件（Navigation API；链接点击、location.assign/replace/href、history.pushState/replaceState 都会同步派发）。
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<() => Promise<string[]|null>>} 读取函数：本文档上记到的导航（[] = 没有）；文档已换（整页导航过）返回 null
 */
async function armNavProbe(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__c8navs = [];
    if (w.navigation) w.navigation.addEventListener('navigate', (/** @type {any} */ e) => w.__c8navs.push(e.navigationType + ' ' + e.destination.url));
  });
  return () => page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return Array.isArray(w.__c8navs) ? w.__c8navs.slice() : null;
  }).catch(() => null);
}

/**
 * 首帧语言跳转跑完且没跳（lang-boot.js 内联在 <head>，同步执行：先置 window.__sgxLangBoot = 1；要跳会先置 window.__sgxLangGo = 1 再 location.replace）。
 * 页面一旦解析过 <head>，跳不跳就已经定了——不用再等一段时间看地址变不变。
 * @param {import('@playwright/test').Page} page @returns {Promise<boolean>} true = 跑过且没跳
 */
async function langBootStayed(page) {
  await page.waitForFunction(() => /** @type {any} */ (window).__sgxLangBoot === 1);
  return page.evaluate(() => !(/** @type {any} */ (window).__sgxLangGo));
}

/**
 * 本页所在浏览器上下文里现在有几个页面（标签页 / 弹窗）。window.open 开窗是同步建 target 的，CDP 当场就数得到；
 * context.on('page') 要等 Playwright 初始化完新页才发，用它数「没开第二个窗口」得干等。只支持 Chromium（各配置都只跑 Chromium）。
 * @param {import('@playwright/test').Page} page @returns {Promise<number>}
 */
async function openPages(page) {
  const s = await page.context().newCDPSession(page);
  try {
    const me = (await s.send('Target.getTargetInfo')).targetInfo;
    const all = (await s.send('Target.getTargets')).targetInfos;
    return all.filter((t) => t.type === 'page' && t.browserContextId === me.browserContextId).length;
  } finally {
    await s.detach().catch(() => {});
  }
}

/**
 * 交接握手收尾（topbar/panel.js mountMusic reach()，HANDOFF_WAIT_MS）：记下本页之后发的每一次 player-hello（req），
 * 返回等待函数——等到每一个 req 都收到了播放器的 player-state 回答。
 * 本函数开的频道对象比页面自己的晚建，同一条消息按建立先后派发（BroadcastChannel 规范），这边收到时页面那边的等待已经了结、到点开窗的计时器已清。
 * 一次握手都没发（reach() 走了同步那条）也立即通过。
 * @param {import('@playwright/test').Page} page @returns {Promise<() => Promise<void>>}
 */
async function musicHandshakes(page) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__c8hello = [];
    w.__c8answered = [];
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (m) {
      if (m && m.type === 'player-hello' && typeof m.req === 'string') w.__c8hello.push(m.req);
      return post.call(this, m);
    };
    const ch = new BroadcastChannel('sgx-music');
    ch.addEventListener('message', (e) => { const d = e.data; if (d && d.type === 'player-state' && typeof d.req === 'string') w.__c8answered.push(d.req); });
  });
  return () => expect.poll(() => page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return w.__c8hello.every((/** @type {string} */ r) => w.__c8answered.includes(r));
  })).toBe(true);
}

/** 首页日刻卡显隐（见文件头）。2026-11 PR-2 首屏终端起日刻卡在 [02] 日刻分节 #daymark 里（测试构建不输出卡片时补一张占位） */
async function setHomeCards(page, { daymark }) {
  await page.evaluate((dm) => {
    const sec = document.getElementById('daymark');
    let el = document.getElementById('w-daymark');
    if (!el) {
      el = document.createElement('a');
      el.id = 'w-daymark';
      /* 对齐 PR-B：日刻是强调线引言 .home-qt（同 layouts/index.html #w-daymark），占位高度 96 */
      el.className = 'home-qt hidden';
      el.style.minHeight = '96px';
      sec.appendChild(el);
    }
    el.classList.toggle('hidden', !dm);
    void sec.offsetWidth;
  }, !!daymark);
}

module.exports = { blockExternalRequests, freezeTime, setHomeCards, nextFrames, animationsDone, scrolledTo, flushRequests, armNavProbe, langBootStayed, openPages, musicHandshakes, expect };
