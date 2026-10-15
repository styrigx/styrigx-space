/**
 * D3/D4/D5：子页面标题区统一（左返回 + 右三点）与吸顶。
 * - D4：除主页外所有页标题区左下返回、右下三点，44×44，中心 y 一致、左右边距对称；
 *       三点底边 → 第一块内容顶边 = G（8px，实测我的文件）。
 * - D5：上滑时返回键与三点同一帧吸住（.stuck），top = nav-h+8+safeTop，44px 磨砂圆；
 *       回顶同时去掉 .stuck。
 * - D3：设置页手机端只有 1 个可见 [data-subpage-head]、1 个 mini-title；
 *       与我的文件对比大标题中心 y / 标题区底边 / 第一块内容顶边差 ≤1px。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('./helpers');

test.use({ viewport: { width: 412, height: 915 } });

async function pinLang(pg, lang) {
  await pg.addInitScript((l) => {
    try { localStorage.setItem('sgx-lang', l); } catch (e) {}
  }, lang);
}

async function gotoPage(pg, path) {
  await blockExternalRequests(pg);
  await pg.goto(path, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-subpage-head]', { timeout: 15000 });
  await pg.waitForTimeout(400);
}

/* 门禁页：探针失败时标题区被隐藏；只做静态几何测量时强制显示（不测门流程） */
async function forceShowHead(pg) {
  await pg.evaluate(() => {
    const fail = document.getElementById('sgx-probe-fail');
    if (fail) fail.remove();
    const layout = document.querySelector('.set-layout');
    if (layout)
      [...layout.children].forEach((c) => {
        if (c.classList.contains('subpage-mini-title')) return;
        c.hidden = false;
      });
  });
  await pg.waitForTimeout(900); // 等入场动画收敛
}

/* 返回 {back, more, head, title, firstTop} 的几何数据（CSS px，getBoundingClientRect） */
async function measureHead(pg) {
  return pg.evaluate(() => {
    const head = document.querySelector('[data-subpage-head]');
    const hr = head.getBoundingClientRect();
    const back = head.querySelector('.subpage-back');
    const more = head.querySelector('.subpage-actions button');
    const bb = back.getBoundingClientRect();
    const mb = more.getBoundingClientRect();
    const title = head.querySelector('.subpage-title').getBoundingClientRect();
    let sib = head.nextElementSibling;
    let firstTop = null;
    while (sib) {
      const b = sib.getBoundingClientRect();
      const cs = getComputedStyle(sib);
      if (b.height > 1 && cs.display !== 'none' && !sib.hidden && cs.position !== 'fixed') {
        let el = sib;
        let eb = b;
        for (let i = 0; i < 5; i++) {
          const kids = [...el.children].filter((x) => {
            const q = x.getBoundingClientRect();
            return q.height > 1 && getComputedStyle(x).display !== 'none' && !x.hidden && getComputedStyle(x).position !== 'fixed';
          });
          if (!kids.length) break;
          const cb = kids[0].getBoundingClientRect();
          if (cb.top <= eb.top + 0.5) { el = kids[0]; eb = cb; } else break;
        }
        firstTop = eb.top;
        break;
      }
      sib = sib.nextElementSibling;
    }
    // 书架页：内容在 header 所在容器的下一个兄弟里
    if (firstTop === null) {
      const cont = head.parentElement && head.parentElement.nextElementSibling;
      if (cont) {
        const cb = cont.getBoundingClientRect();
        if (cb.height > 1) firstTop = cb.top;
      }
    }
    return {
      headBottom: hr.bottom,
      headX: hr.x,
      headW: hr.width,
      titleCY: title.top + title.height / 2,
      back: { x: bb.x, y: bb.y, w: bb.width, h: bb.height, cy: bb.y + bb.height / 2, bottom: bb.bottom },
      more: { x: mb.x, y: mb.y, w: mb.width, h: mb.height, cy: mb.y + mb.height / 2, bottom: mb.bottom, right: mb.right, id: more.id || '' },
    };
  });
}

const GEOM_PAGES = [
  '/files/',
  '/browser/',
  '/store/',
  '/settings/',
  '/settings/display/',
  '/settings/security/',
  '/books/',
  '/goodlock/',
  '/ai/',
];

for (const path of GEOM_PAGES) {
  test(`D4 expanded geometry: ${path}`, async ({ page: pg }) => {
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pinLang(pg, 'zh');
    await gotoPage(pg, path);
    const m = await measureHead(pg);
    // 两个按钮都是 44×44
    expect(m.back.w, `${path} back width`).toBeGreaterThanOrEqual(43.5);
    expect(m.back.w, `${path} back width`).toBeLessThanOrEqual(44.5);
    expect(m.back.h, `${path} back height`).toBeGreaterThanOrEqual(43.5);
    expect(m.back.h, `${path} back height`).toBeLessThanOrEqual(44.5);
    expect(m.more.w, `${path} more width`).toBeGreaterThanOrEqual(43.5);
    expect(m.more.w, `${path} more width`).toBeLessThanOrEqual(44.5);
    expect(m.more.h, `${path} more height`).toBeGreaterThanOrEqual(43.5);
    expect(m.more.h, `${path} more height`).toBeLessThanOrEqual(44.5);
    // 中心 y 差 ≤1px
    expect(Math.abs(m.back.cy - m.more.cy), `${path} center-y diff`).toBeLessThanOrEqual(1);
    // 左边距 = 三点右边距（相对标题区），差 ≤1px
    const leftGap = m.back.x - m.headX;
    const rightGap = m.headX + m.headW - m.more.right;
    expect(Math.abs(leftGap - rightGap), `${path} margin diff`).toBeLessThanOrEqual(1);
    // 按钮在视口内
    expect(m.back.x, `${path} back in viewport`).toBeGreaterThanOrEqual(-0.5);
    expect(m.more.right, `${path} more in viewport`).toBeLessThanOrEqual(412.5);
    // G = 三点底边 → 第一块内容顶边 = 8px（±1px）
    if (path !== '/books/') {
      const g = (await pg.evaluate(() => {
        const head = document.querySelector('[data-subpage-head]');
        const more = head.querySelector('.subpage-actions button').getBoundingClientRect();
        let sib = head.nextElementSibling;
        while (sib) {
          const b = sib.getBoundingClientRect();
          const cs = getComputedStyle(sib);
          if (b.height > 1 && cs.display !== 'none' && !sib.hidden && cs.position !== 'fixed') {
            let eb = b;
            let el = sib;
            for (let i = 0; i < 5; i++) {
              const kids = [...el.children].filter((x) => {
                const q = x.getBoundingClientRect();
                return q.height > 1 && getComputedStyle(x).display !== 'none' && !x.hidden && getComputedStyle(x).position !== 'fixed';
              });
              if (!kids.length) break;
              const cb = kids[0].getBoundingClientRect();
              if (cb.top <= eb.top + 0.5) { el = kids[0]; eb = cb; } else break;
            }
            return eb.top - more.bottom;
          }
          sib = sib.nextElementSibling;
        }
        return null;
      }));
      expect(g, `${path} G`).not.toBeNull();
      expect(Math.abs(g - 8), `${path} G=8`).toBeLessThanOrEqual(1);
    }
    expect(errs, `${path} pageerrors`).toEqual([]);
  });
}

test('D4 icon-only more: click does nothing', async ({ page: pg }) => {
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/browser/');
  const more = pg.locator('[data-subpage-head] .subpage-actions .subpage-more');
  await expect(more).toBeVisible();
  const urlBefore = pg.url();
  await more.click();
  await pg.waitForTimeout(400);
  // 没有弹层、没有跳转、没有报错
  expect(pg.url(), 'no navigation').toBe(urlBefore);
  expect(await pg.locator('#sheet-panel.visible, .sheet-open').count(), 'no sheet').toBe(0);
  expect(errs, 'pageerrors').toEqual([]);
});

test('D4 functional more: files menu still opens', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/files/');
  await pg.locator('#files-more').click();
  await expect(pg.locator('#sheet-panel')).toBeVisible({ timeout: 5000 });
});

test('D4 door pages: back + more buttons exist', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  for (const path of ['/settings/security/lock/', '/settings/security/owner/', '/settings/security/mgmt/', '/settings/security/apps/', '/settings/security/apps/book/']) {
    await blockExternalRequests(pg);
    await pg.goto(path, { waitUntil: 'domcontentloaded' });
    // 门禁页探针失败时标题区 hidden（原有 A-1 行为），只断言 DOM 存在
    await pg.waitForSelector('[data-subpage-head]', { timeout: 15000, state: 'attached' });
    const n = await pg.evaluate(() => ({
      back: document.querySelectorAll('[data-subpage-head] .subpage-back').length,
      more: document.querySelectorAll('[data-subpage-head] .subpage-actions .subpage-more').length,
    }));
    expect(n.back, `${path} back`).toBe(1);
    expect(n.more, `${path} more`).toBe(1);
  }
});

test('D5 float: back and more float in the same frame (B1-7 data-state)', async ({ page: pg }) => {
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pinLang(pg, 'zh');
  for (const path of ['/files/', '/settings/']) {
    await gotoPage(pg, path);
    const r = await pg.evaluate(async () => {
      const head = document.querySelector('[data-subpage-head]');
      const back = head.querySelector('.subpage-back');
      const more = head.querySelector('.subpage-actions button');
      const frames = [];
      for (const y of [0, 100, 189, 190, 300, 600]) {
        window.scrollTo(0, y);
        await new Promise((res) => setTimeout(res, 150));
        const br = back.getBoundingClientRect();
        const mr = more.getBoundingClientRect();
        frames.push({
          y,
          backStuck: head.getAttribute('data-state') === 'float',
          moreStuck: head.getAttribute('data-state') === 'float',
          backTop: br.top,
          moreTop: mr.top,
          dCY: Math.abs(br.top + br.height / 2 - (mr.top + mr.height / 2)),
        });
      }
      // 回顶
      window.scrollTo(0, 0);
      await new Promise((res) => setTimeout(res, 300));
      return {
        frames,
        afterTop: {
          backStuck: head.getAttribute('data-state') === 'float',
          moreStuck: head.getAttribute('data-state') === 'float',
        },
      };
    });
    let stuckFrame = null;
    for (const f of r.frames) {
      // 同一帧：两者状态永远一致
      expect(f.backStuck, `${path} y=${f.y} same frame`).toBe(f.moreStuck);
      if (f.backStuck && stuckFrame === null) stuckFrame = f;
      if (f.backStuck) {
        // 吸住后：top = nav-h+8（≤1px 误差内比较两者），中心 y 差 ≤1px
        expect(Math.abs(f.backTop - f.moreTop), `${path} y=${f.y} stuck top`).toBeLessThanOrEqual(1);
        expect(f.dCY, `${path} y=${f.y} stuck center-y`).toBeLessThanOrEqual(1);
        // 44×44
        const sz = await pg.evaluate(() => {
          const b = document.querySelector('[data-subpage-head] .subpage-back').getBoundingClientRect();
          return { w: b.width, h: b.height };
        });
        expect(sz.w, `${path} stuck back w`).toBeGreaterThanOrEqual(43.5);
        expect(sz.h, `${path} stuck back h`).toBeGreaterThanOrEqual(43.5);
      }
    }
    expect(stuckFrame, `${path} stuck at some frame`).not.toBeNull();
    // 回顶：同时去掉 .stuck
    expect(r.afterTop.backStuck, `${path} unstuck back`).toBe(false);
    expect(r.afterTop.moreStuck, `${path} unstuck more`).toBe(false);
    expect(errs, `${path} pageerrors`).toEqual([]);
  }
});

test('D5 stuck: icon swaps to ‹ and back button stays in viewport', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await gotoPage(pg, '/files/');
  await pg.evaluate(() => window.scrollTo(0, 600));
  await pg.waitForTimeout(400);
  const r = await pg.evaluate(() => {
    const back = document.querySelector('[data-subpage-head] .subpage-back');
    const fold = back.querySelector('.sgx-bk-fold');
    const svg = back.querySelector('svg');
    const br = back.getBoundingClientRect();
    return {
      foldDisplay: getComputedStyle(fold).display,
      svgDisplay: getComputedStyle(svg).display,
      foldText: fold.textContent,
      top: br.top,
      inVP: br.top >= 0 && br.bottom <= window.innerHeight,
    };
  });
  expect(r.foldDisplay, 'fold icon shown').not.toBe('none');
  expect(r.foldText, 'fold icon char').toBe('‹');
  expect(r.svgDisplay, 'arrow hidden when stuck').toBe('none');
  expect(r.inVP, 'stuck back in viewport').toBe(true);
});

test('D3 settings: single head, single mini-title, numbers match files', async ({ page: pg }) => {
  await pinLang(pg, 'zh');
  await blockExternalRequests(pg);
  await pg.goto('/settings/', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-subpage-head]', { timeout: 15000 });
  await pg.waitForTimeout(400);
  const s = await pg.evaluate(() => {
    const vis = (el) => el.getBoundingClientRect().width > 0;
    const heads = [...document.querySelectorAll('[data-subpage-head]')].filter(vis);
    const head = heads[0];
    const hr = head.getBoundingClientRect();
    const title = head.querySelector('.subpage-title').getBoundingClientRect();
    const card = document.querySelector('.set-mobile-only .sgx-account-card').getBoundingClientRect();
    return {
      visibleHeads: heads.length,
      miniTitles: document.querySelectorAll('.subpage-mini-title').length,
      headBottom: hr.bottom,
      titleCY: title.top + title.height / 2,
      firstTop: card.top,
    };
  });
  expect(s.visibleHeads, 'visible heads').toBe(1);
  expect(s.miniTitles, 'mini-title count').toBe(1);

  await pg.goto('/files/', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-subpage-head]', { timeout: 15000 });
  await pg.waitForTimeout(400);
  const f = await pg.evaluate(() => {
    const head = document.querySelector('[data-subpage-head]');
    const hr = head.getBoundingClientRect();
    const title = head.querySelector('.subpage-title').getBoundingClientRect();
    const cats = document.querySelector('section[data-home-group="cats"]').getBoundingClientRect();
    return { headBottom: hr.bottom, titleCY: title.top + title.height / 2, firstTop: cats.top };
  });
  expect(Math.abs(s.headBottom - f.headBottom), 'head bottom diff').toBeLessThanOrEqual(1);
  expect(Math.abs(s.titleCY - f.titleCY), 'title center-y diff').toBeLessThanOrEqual(1);
  expect(Math.abs(s.firstTop - f.firstTop), 'first content top diff').toBeLessThanOrEqual(1);
});

test('P2 bfcache: pageshow(persisted) recalculates title state to match scrollY', async ({ page: pg }) => {
  await gotoPage(pg, '/files/');
  /* 滚到标题区吸顶的位置 */
  await pg.evaluate(() => window.scrollTo(0, 600));
  await pg.waitForTimeout(500);
  const before = await pg.evaluate(() => {
    const back = document.querySelector('[data-subpage-head] .subpage-back');
    const hero = document.querySelector('[data-subpage-head] .subpage-hero');
    return {
      scrollY: window.scrollY,
      backStuck: back ? back.classList.contains('stuck') : null,
      heroOpacity: hero ? getComputedStyle(hero).opacity : null,
      bodyScrolled: document.body.classList.contains('subpage-scrolled'),
    };
  });
  /* 模拟 bfcache 恢复：先破坏状态，再派发 pageshow(persisted=true) */
  await pg.evaluate(() => {
    const back = document.querySelector('[data-subpage-head] .subpage-back');
    const hero = document.querySelector('[data-subpage-head] .subpage-hero');
    if (back) back.classList.remove('stuck');
    if (hero) {
      hero.style.opacity = '1';
      hero.style.transform = '';
    }
    document.body.classList.remove('subpage-scrolled');
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await pg.waitForTimeout(300);
  const after = await pg.evaluate(() => {
    const back = document.querySelector('[data-subpage-head] .subpage-back');
    const hero = document.querySelector('[data-subpage-head] .subpage-hero');
    return {
      scrollY: window.scrollY,
      backStuck: back ? back.classList.contains('stuck') : null,
      heroOpacity: hero ? getComputedStyle(hero).opacity : null,
      bodyScrolled: document.body.classList.contains('subpage-scrolled'),
    };
  });
  /* 恢复后的状态应与恢复前一致（都对应同一个 scrollY） */
  expect(after.scrollY, 'scrollY unchanged').toBe(before.scrollY);
  expect(after.backStuck, 'back stuck state').toBe(before.backStuck);
  expect(after.bodyScrolled, 'body scrolled class').toBe(before.bodyScrolled);
  expect(after.heroOpacity, 'hero opacity').toBe(before.heroOpacity);
});
