/**
 * 顶栏统一规格 v1.0：卡片式顶栏与页面头部。
 * - 卡片：fixed，top 16+safe-top，宽 min(100vw-32px,1068px)，高 52px，圆角 26px；
 *   品牌组（头像 28px + Styrigx 15px/700），右侧默认无内容。
 * - #site-nav 全透明（背景/边框/阴影全无），pointer-events:none，卡片 auto。
 * - 时钟 #nav-time-center、天气 #nav-wx 及其弹出卡片已删除。
 * - 子页面标题区：手机高 max(240px,30%视口)，大标题底边距底边 76px，
 *   ←/⋮ 44×44 距左右 16px、距底边 8px。
 * - 滚动后：品牌组 opacity 0 不可点；卡片内 ←/⋮（40×40）+ 居中小标题淡入；
 *   卡片按钮调用原按钮 click()；滚回顶部还原。
 * - DeX：卡片宽 1068px 居中。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 390, height: 844 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

async function gotoPage(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#sgx-topcard', { timeout: 15000 });
  await pg.waitForTimeout(500);
}

/* ---------- 卡片几何（验收 1、2） ---------- */
test('v1.0 card geometry: home', async ({ page: pg }) => {
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/');
  const m = await pg.evaluate(() => {
    const card = document.getElementById('sgx-topcard').getBoundingClientRect();
    const cardCS = getComputedStyle(document.getElementById('sgx-topcard'));
    const brand = document.getElementById('nav-brand').getBoundingClientRect();
    const img = document.querySelector('.sgx-topcard-avatar').getBoundingClientRect();
    const name = document.querySelector('.sgx-topcard-name').getBoundingClientRect();
    return {
      card: { x: card.x, top: card.top, w: card.width, h: card.height },
      radius: cardCS.borderRadius,
      avatarLeftGap: img.x - card.x,
      avatarNameGap: name.x - (img.x + img.width),
      avatarSize: { w: img.width, h: img.height },
      cyErr: Math.max(
        Math.abs(img.y + img.height / 2 - (card.y + card.height / 2)),
        Math.abs(name.y + name.height / 2 - (card.y + card.height / 2))
      ),
      brandW: brand.width,
    };
  });
  expect(m.card.x, 'card left').toBeGreaterThanOrEqual(15);
  expect(m.card.x, 'card left').toBeLessThanOrEqual(17);
  expect(m.card.top, 'card top').toBeGreaterThanOrEqual(15);
  expect(m.card.top, 'card top').toBeLessThanOrEqual(17);
  expect(390 - (m.card.x + m.card.w), 'card right gap').toBeGreaterThanOrEqual(15);
  expect(390 - (m.card.x + m.card.w), 'card right gap').toBeLessThanOrEqual(17);
  expect(m.card.h, 'card height').toBeGreaterThanOrEqual(51);
  expect(m.card.h, 'card height').toBeLessThanOrEqual(53);
  expect(m.radius, 'card radius').toBe('26px');
  expect(m.avatarLeftGap, 'avatar 12px from card left').toBeGreaterThanOrEqual(11);
  expect(m.avatarLeftGap, 'avatar 12px from card left').toBeLessThanOrEqual(13);
  expect(m.avatarNameGap, 'avatar-name 8px gap').toBeGreaterThanOrEqual(7);
  expect(m.avatarNameGap, 'avatar-name 8px gap').toBeLessThanOrEqual(9);
  expect(m.avatarSize.w, 'avatar 28px').toBeGreaterThanOrEqual(27.5);
  expect(m.avatarSize.w, 'avatar 28px').toBeLessThanOrEqual(28.5);
  expect(m.cyErr, 'vertical center error').toBeLessThanOrEqual(1);
  expect(errs, 'pageerrors').toEqual([]);
});

test('v1.0 card geometry: en', async ({ page: pg }) => {
  await pinLang(pg, 'en');
  await gotoPage(pg, '/en/');
  const m = await pg.evaluate(() => {
    const card = document.getElementById('sgx-topcard').getBoundingClientRect();
    const img = document.querySelector('.sgx-topcard-avatar').getBoundingClientRect();
    const name = document.querySelector('.sgx-topcard-name').getBoundingClientRect();
    return {
      avatarLeftGap: img.x - card.x,
      avatarNameGap: name.x - (img.x + img.width),
      nameText: name.width > 0 ? document.querySelector('.sgx-topcard-name').textContent : '',
    };
  });
  expect(m.nameText, 'brand text not translated').toBe('Styrigx');
  expect(m.avatarLeftGap, 'avatar gap en').toBeGreaterThanOrEqual(11);
  expect(m.avatarLeftGap, 'avatar gap en').toBeLessThanOrEqual(13);
  expect(m.avatarNameGap, 'avatar-name gap en').toBeGreaterThanOrEqual(7);
  expect(m.avatarNameGap, 'avatar-name gap en').toBeLessThanOrEqual(9);
});

/* ---------- #site-nav 透明（验收 3） ---------- */
test('v1.0 site-nav transparent', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  for (const path of ['/', '/settings/']) {
    await gotoPage(pg, path);
    const bg = await pg.evaluate(() => getComputedStyle(document.getElementById('site-nav')).backgroundColor);
    expect(bg, `${path} nav transparent`).toBe('rgba(0, 0, 0, 0)');
    const pe = await pg.evaluate(() => getComputedStyle(document.getElementById('site-nav')).pointerEvents);
    expect(pe, `${path} nav pointer-events none`).toBe('none');
    const cardPE = await pg.evaluate(() => getComputedStyle(document.getElementById('sgx-topcard')).pointerEvents);
    expect(cardPE, `${path} card pointer-events auto`).toBe('auto');
  }
});

/* ---------- 时钟/天气已删除（验收 4） ---------- */
test('v1.0 clock and weather removed', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/');
  const n = await pg.evaluate(() => ({
    time: document.querySelectorAll('#nav-time-center').length,
    wx: document.querySelectorAll('#nav-wx').length,
    wxPop: document.querySelectorAll('#nav-wx-pop').length,
    clockPop: document.querySelectorAll('#dex-clock-pop').length,
  }));
  expect(n.time, 'no #nav-time-center').toBe(0);
  expect(n.wx, 'no #nav-wx').toBe(0);
  expect(n.wxPop, 'no #nav-wx-pop').toBe(0);
  expect(n.clockPop, 'no #dex-clock-pop').toBe(0);
});

/* ---------- 子页面标题区几何（验收 5） ---------- */
test('v1.0 subpage head geometry: settings', async ({ page: pg }) => {
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/settings/');
  const m = await pg.evaluate(() => {
    const headEl = document.querySelector('[data-subpage-head]');
    const head = headEl.getBoundingClientRect();
    const title = headEl.querySelector('.subpage-title');
    const tr = title.getBoundingClientRect();
    const tcs = getComputedStyle(title);
    const back = headEl.querySelector('.subpage-back').getBoundingClientRect();
    const more = headEl.querySelector('.subpage-actions button').getBoundingClientRect();
    return {
      headH: head.height,
      titleBottomGap: head.bottom - tr.bottom,
      titleFont: tcs.fontSize,
      titleWeight: tcs.fontWeight,
      titleColor: tcs.color,
      back: { x: back.x, w: back.width, h: back.height, bottomGap: head.bottom - back.bottom },
      more: { rightGap: 390 - (more.x + more.width), w: more.width, h: more.height, bottomGap: head.bottom - more.bottom },
    };
  });
  // 标题区高 = max(240, 0.3×844=253.2)
  expect(m.headH, 'head height').toBeGreaterThanOrEqual(252.2);
  expect(m.headH, 'head height').toBeLessThanOrEqual(254.2);
  // 大标题底边距标题区底边 76px
  expect(m.titleBottomGap, 'title bottom gap 76').toBeGreaterThanOrEqual(75);
  expect(m.titleBottomGap, 'title bottom gap 76').toBeLessThanOrEqual(77);
  expect(m.titleFont, 'title 40px').toBe('40px');
  expect(m.titleWeight, 'title 800').toBe('800');
  // ←/⋮ 44×44，距左右 16px，距底边 8px
  for (const [k, b] of [['back', m.back], ['more', m.more]]) {
    expect(b.w, `${k} 44px`).toBeGreaterThanOrEqual(43.5);
    expect(b.w, `${k} 44px`).toBeLessThanOrEqual(44.5);
    expect(b.h, `${k} 44px`).toBeGreaterThanOrEqual(43.5);
    expect(b.h, `${k} 44px`).toBeLessThanOrEqual(44.5);
    expect(b.bottomGap, `${k} 8px from bottom`).toBeGreaterThanOrEqual(7);
    expect(b.bottomGap, `${k} 8px from bottom`).toBeLessThanOrEqual(9);
  }
  expect(m.back.x, 'back 16px from left').toBeGreaterThanOrEqual(15);
  expect(m.back.x, 'back 16px from left').toBeLessThanOrEqual(17);
  expect(m.more.rightGap, 'more 16px from right').toBeGreaterThanOrEqual(15);
  expect(m.more.rightGap, 'more 16px from right').toBeLessThanOrEqual(17);
  expect(errs, 'pageerrors').toEqual([]);
});

/* ---------- 滚动后卡片状态（验收 6） ---------- */
test('v1.0 scrolled: brand fades, mini-title and card buttons appear', async ({ page: pg }) => {
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/settings/');
  await pg.evaluate(() => window.scrollTo(0, 400));
  await pg.waitForTimeout(700);
  const m = await pg.evaluate(() => {
    const card = document.getElementById('sgx-topcard').getBoundingClientRect();
    const brand = document.getElementById('nav-brand');
    const bcs = getComputedStyle(brand);
    const mini = document.querySelector('.subpage-mini-title');
    const mr = mini.getBoundingClientRect();
    const mcs = getComputedStyle(mini);
    const cb = document.getElementById('sgx-topcard-back').getBoundingClientRect();
    const cm = document.getElementById('sgx-topcard-more').getBoundingClientRect();
    const cbs = getComputedStyle(document.getElementById('sgx-topcard-back'));
    return {
      brandOpacity: parseFloat(bcs.opacity),
      brandPE: bcs.pointerEvents,
      miniOpacity: parseFloat(mcs.opacity),
      miniCX: mr.x + mr.width / 2,
      miniCY: mr.y + mr.height / 2,
      cardCX: card.x + card.width / 2,
      cardCY: card.y + card.height / 2,
      backLeftGap: cb.x - card.x,
      moreRightGap: card.x + card.width - (cm.x + cm.width),
      backOpacity: parseFloat(cbs.opacity),
      backSize: { w: cb.width, h: cb.height },
      moreSize: { w: cm.width, h: cm.height },
    };
  });
  expect(m.brandOpacity, 'brand opacity 0').toBe(0);
  expect(m.brandPE, 'brand not clickable').toBe('none');
  expect(m.miniOpacity, 'mini-title opacity 1').toBe(1);
  expect(Math.abs(m.miniCX - m.cardCX), 'mini-title centered x').toBeLessThanOrEqual(1);
  expect(Math.abs(m.miniCY - m.cardCY), 'mini-title centered y').toBeLessThanOrEqual(1);
  expect(m.backLeftGap, 'card back 6px from card left').toBeGreaterThanOrEqual(5);
  expect(m.backLeftGap, 'card back 6px from card left').toBeLessThanOrEqual(7);
  expect(m.moreRightGap, 'card more 6px from card right').toBeGreaterThanOrEqual(5);
  expect(m.moreRightGap, 'card more 6px from card right').toBeLessThanOrEqual(7);
  expect(m.backOpacity, 'card back visible').toBe(1);
  expect(m.backSize.w, 'card back 40px').toBeGreaterThanOrEqual(39.5);
  expect(m.backSize.w, 'card back 40px').toBeLessThanOrEqual(40.5);
  expect(m.moreSize.w, 'card more 40px').toBeGreaterThanOrEqual(39.5);
  expect(m.moreSize.w, 'card more 40px').toBeLessThanOrEqual(40.5);
  expect(errs, 'pageerrors').toEqual([]);
});

test('v1.0 scrolled: card buttons proxy original clicks, restore on scroll top', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/files/');
  await pg.evaluate(() => window.scrollTo(0, 500));
  await pg.waitForTimeout(700);
  // 卡片 ⋮ 调用原 #files-more 的 click() → 打开同一菜单
  await pg.locator('#sgx-topcard-more').click({ force: true });
  await expect(pg.locator('#sheet-panel')).toBeVisible({ timeout: 5000 });
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);
  // 卡片 ← 调用原 .subpage-back 的 click()
  const proxied = await pg.evaluate(() => {
    const orig = document.querySelector('[data-subpage-head] .subpage-back');
    let hit = false;
    orig.addEventListener('click', () => { hit = true; }, { once: true });
    document.getElementById('sgx-topcard-back').click();
    return hit;
  });
  expect(proxied, 'card back proxies original click').toBe(true);
  // 滚回顶部还原
  await pg.goto('/settings/', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#sgx-topcard', { timeout: 15000 });
  await pg.waitForTimeout(500);
  const top = await pg.evaluate(() => ({
    brandOpacity: parseFloat(getComputedStyle(document.getElementById('nav-brand')).opacity),
    miniOpacity: parseFloat(getComputedStyle(document.querySelector('.subpage-mini-title')).opacity),
    backOpacity: parseFloat(getComputedStyle(document.getElementById('sgx-topcard-back')).opacity),
  }));
  expect(top.brandOpacity, 'brand restored').toBe(1);
  expect(top.miniOpacity, 'mini-title hidden').toBe(0);
  expect(top.backOpacity, 'card back hidden').toBe(0);
});

/* ---------- DeX 卡片（验收 7） ---------- */
test('v1.0 dex card: 1068px centered', async ({ page: pg }) => {
  await pg.setViewportSize({ width: 1280, height: 800 });
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/');
  const m = await pg.evaluate(() => {
    const card = document.getElementById('sgx-topcard').getBoundingClientRect();
    const layout = document.documentElement.classList.contains('layout-dex') ? 'dex'
      : document.documentElement.classList.contains('layout-pc') ? 'pc' : 'mobile';
    return { layout, w: card.width, x: card.x, centered: Math.abs(card.x - (1280 - card.width) / 2) };
  });
  expect(m.layout, 'dex layout').toBe('dex');
  expect(m.w, 'card 1068px').toBeGreaterThanOrEqual(1067);
  expect(m.w, 'card 1068px').toBeLessThanOrEqual(1069);
  expect(m.centered, 'card centered').toBeLessThanOrEqual(1);
});

/* ---------- 原按钮不再吸顶，跟着标题区滚走 ---------- */
test('v1.0 original buttons scroll away with head', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/settings/');
  const before = await pg.evaluate(() => document.querySelector('[data-subpage-head] .subpage-back').getBoundingClientRect().top);
  await pg.evaluate(() => window.scrollTo(0, 500));
  await pg.waitForTimeout(500);
  const after = await pg.evaluate(() => document.querySelector('[data-subpage-head] .subpage-back').getBoundingClientRect().top);
  // 原按钮跟着标题区上移（滚走），而不是 fixed 吸顶
  expect(after, 'original back scrolls away').toBeLessThan(before - 100);
  const pos = await pg.evaluate(() => getComputedStyle(document.querySelector('[data-subpage-head] .subpage-back')).position);
  expect(pos, 'original back not fixed').not.toBe('fixed');
});
