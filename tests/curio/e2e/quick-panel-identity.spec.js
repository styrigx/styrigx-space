/* 四站外观面板是同一份（P4-3 PR-4b 定稿四站完全相同；2026-11 UI 重设计 PR-1 起 #sgx-qp = 外观面板：MODE + PALETTE，
 * 分享 / 锁定 / 语言 / 布局搬进 NAVIGATE #sgx-nav——NAVIGATE 的当前项和地址各站不同，这里只核对它的按钮组一样）。
 * 跑在拼好的整站（space/web/public：主站 /，奇趣 /curio/、日刻 /daymark/、博客 /blog/，同源）。
 * 比的是构建产物里 #sgx-qp 的 DOM（DOMParser 解析，和 HTML 压缩写法无关）：元素、属性、文字逐个相同（图标 SVG 只比结构，压缩会改写路径数据），
 * 只允许各站自己的语言（中文页和中文页比、英文页和英文页比）。另外各站真点开一次：只有一页，磁贴顺序相同。
 * 主站在 space/web/public 里是生产构建（锁屏启用、没有网关）：主站只比 DOM，不点。 */
const { test, expect } = require('@playwright/test');

const SETS = {
  /* P4-3 PR-4c：英文无前缀，中文 /zh/ */
  zh: ['/zh/', '/curio/zh/', '/daymark/zh/', '/blog/zh/', '/blog/zh/post/2026-10-07-muse-playbook/', '/zh/account/'],
  en: ['/', '/curio/', '/daymark/', '/blog/'],
};

test.beforeEach(async ({ page }) => {
  /* 同 topbar-cross-site.spec.js：主站接口回 401，子站回 503（子站把 401 当「锁了」会一直刷新） */
  await page.route('**/api/**', (r) => {
    const sub = /^\/(curio|daymark|blog)\//.test(new URL(r.request().url()).pathname);
    return r.fulfill(sub
      ? { status: 503, contentType: 'application/json', body: '{"ok":false,"error":"unavailable"}' }
      : { status: 401, contentType: 'application/json', body: '{"ok":false,"error":"session"}' });
  });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
});

/** 构建产物里 #sgx-qp 的规范化 DOM：[标签, 排好序的属性（空白归一）, 子节点…]，文字节点去首尾空白、空的不要 */
async function qpTree(page, path) {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  const html = await res.text();
  return page.evaluate((h) => {
    const doc = new DOMParser().parseFromString(h, 'text/html');
    const all = doc.querySelectorAll('#sgx-qp');
    if (all.length !== 1) return { count: all.length };
    const norm = (v) => v.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
    const walk = (n) => {
      if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' ').trim(); return t ? t : null; }
      if (n.nodeType !== 1) return null;
      /* 图标 SVG：各站 Hugo 压缩会改写路径数据（2.485.0 / 2.485 0、L 省略），只比结构（标签），不比 SVG 里的属性值 */
      const inSvg = !!n.closest('svg');
      /* data-href：语言行「另一种语言的本页」地址，各站各页本来就不同（主站由 lib/prefs.js setLang 现算，不输出） */
      const attrs = inSvg ? [] : Array.from(n.attributes).filter((a) => a.name !== 'data-href').map((a) => a.name + '=' + norm(a.value)).sort();
      return [n.tagName.toLowerCase(), attrs, Array.from(n.childNodes).map(walk).filter((x) => x !== null)];
    };
    return { count: 1, tree: walk(all[0]) };
  }, html);
}

for (const [lang, pages] of Object.entries(SETS)) {
  test(`${lang}：四站构建产物里的外观面板 #sgx-qp DOM 完全相同（${pages.join(' ')}）`, async ({ page }) => {
    /* 在空白页里解析（主站会跳锁屏 / 按浏览器语言跳页，执行上下文会被换掉）；产物用 page.request 取 */
    await page.goto('about:blank');
    const ref = await qpTree(page, pages[0]);
    expect(ref.count, pages[0]).toBe(1);
    /* 参照本身：MODE（跟随系统 / 深 / 浅）+ PALETTE（色板 + 恢复默认）；没有页签、导航列表、分享 / 锁定 / 语言 / 布局 */
    const flat = JSON.stringify(ref.tree);
    for (const id of ['system', 'dark', 'light']) expect(flat, id).toContain('"data-qp-mode=' + id + '"');
    expect(flat).toContain('"data-qp-reset=');
    expect(flat).toContain('"data-qp-palette=');
    for (const gone of ['role=tablist', 'role=tab', 'data-qp-pages', 'data-nav=', '"data-qp=', 'data-qp-lang', 'data-qp-seg=layout']) expect(flat, gone).not.toContain(gone);
    for (const p of pages.slice(1)) {
      const got = await qpTree(page, p);
      expect(got.count, p).toBe(1);
      expect(got.tree, `${p} 的外观面板和 ${pages[0]} 不同`).toEqual(ref.tree);
    }
  });
}

test('子站真点开：外观面板 MODE / PALETTE 顺序四站相同、没有页签；NAVIGATE 里 语言 / 布局 / 分享 / 锁定 四站相同', async ({ page }) => {
  const seen = [];
  const navSeen = [];
  for (const p of ['/curio/', '/daymark/', '/blog/']) {
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await page.locator('.sgx-tb-quick').click();
    const qp = page.locator('#sgx-qp');
    await expect(qp).toHaveAttribute('data-state', 'open');
    await expect(qp.locator('[role="tab"], [role="tabpanel"], [data-qp-pages], [data-qp]')).toHaveCount(0);
    await expect(qp.locator('[data-qp-mode="system"]')).toBeVisible();
    seen.push(await qp.locator('[data-qp-mode], [data-qp-palette], [data-qp-reset]').evaluateAll((els) => els.map((e) => e.getAttribute('data-qp-mode') || e.getAttribute('data-qp-palette') || 'reset')));
    await page.keyboard.press('Escape');
    await expect(qp).toBeHidden();
    await page.locator('.sgx-tb-grid').click();
    const nav = page.locator('#sgx-nav');
    await expect(nav).toHaveAttribute('data-state', 'open');
    await expect(nav.locator('[data-qp="share"]')).toBeVisible();
    navSeen.push(await nav.locator('[data-qp], [data-qp-lang], [data-qp-seg] button').evaluateAll((els) => els.map((e) => e.getAttribute('data-qp') || (e.getAttribute('data-qp-lang') ? 'lang:' + e.getAttribute('data-qp-lang') : 'seg:' + e.getAttribute('data-v')))));
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
  }
  expect(seen[1]).toEqual(seen[0]);
  expect(seen[2]).toEqual(seen[0]);
  expect(navSeen[0]).toEqual(['lang:en', 'lang:zh', 'seg:auto', 'seg:phone', 'seg:desktop', 'share', 'lock']);
  expect(navSeen[1]).toEqual(navSeen[0]);
  expect(navSeen[2]).toEqual(navSeen[0]);
});
