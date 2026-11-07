// 代码块（render-codeblock.html + assets/css/blog/code.css）验收，不截图：
// - 一个容器（surface-container-high），里面没有框中框、没有逐行背景；
// - 标题栏：语言 · 复制；
// - 行号槽：每行行号和代码同一基线，横向滚动时行号贴住左边；
// - 不换行，长行横向滚动；
// - 复制按钮只复制代码（不带行号），按钮短暂显示「已复制」。
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 412, height: 915 } });

/* 语言清理（2026-11-07）起博客也「跟随系统」每页都跳（四站同一份首帧跳转 lang-boot.js），Playwright 默认 en-US 会把 /blog/zh/… 换到英文页。
   本文件都是中文用例，按中文浏览器跑（同奇趣 / 日刻）。 */
test.use({ locale: 'zh-CN' });

const POST = '/blog/zh/post/2026-10-11-key-spec-whitepaper-v2/';

test.beforeEach(async ({ page }) => {
  await page.route('https://styrigx.com/**', (r) => r.fulfill({ status: 204 }));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('styrigx-blog-lang', 'en'); // P4-3 PR-4c：英文首页 /blog/ 不按浏览器语言跳 /blog/zh/
    } catch {}
  });
});

test('一个容器：圆角 + 代码面底色，内部 pre / code / 行没有自己的背景和边框', async ({ page }) => {
  await page.goto(POST, { waitUntil: 'domcontentloaded' });
  const blocks = page.locator('.article-content figure.code-block');
  expect(await blocks.count()).toBeGreaterThan(0);
  const first = blocks.first();
  await first.scrollIntoViewIfNeeded();
  // 每个代码块只有一个 .highlight / 一个 pre，没有 Expressive Code 的残留结构
  await expect(first.locator('pre')).toHaveCount(1);
  await expect(page.locator('.expressive-code, .ec-line')).toHaveCount(0);

  const st = await first.evaluate((fig) => {
    const cs = (el) => getComputedStyle(el);
    const probe = document.createElement('div');
    probe.style.background = 'var(--sgx-surface-container-high)';
    fig.appendChild(probe);
    const surface = cs(probe).backgroundColor;
    probe.remove();
    const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
    const inner = [fig.querySelector('.highlight'), fig.querySelector('pre'), fig.querySelector('code'), ...fig.querySelectorAll('.line'), ...fig.querySelectorAll('.cl')];
    return {
      bg: cs(fig).backgroundColor,
      surface,
      radius: parseFloat(cs(fig).borderTopLeftRadius),
      innerBg: inner.filter((el) => !transparent(cs(el).backgroundColor)).map((el) => el.className + ':' + cs(el).backgroundColor),
      innerBorder: inner.filter((el) => parseFloat(cs(el).borderTopWidth) > 0 || parseFloat(cs(el).borderLeftWidth) > 0).map((el) => el.className),
      innerRadius: inner.filter((el) => parseFloat(cs(el).borderTopLeftRadius) > 0).map((el) => el.className),
    };
  });
  expect(st.bg).toBe(st.surface);
  expect(st.radius).toBeGreaterThanOrEqual(12);
  expect(st.innerBg).toEqual([]);
  expect(st.innerBorder).toEqual([]);
  expect(st.innerRadius).toEqual([]);
});

test('标题栏：语言标签 + 复制按钮', async ({ page }) => {
  await page.goto(POST, { waitUntil: 'domcontentloaded' });
  const head = page.locator('.article-content figure.code-block').first().locator('.code-head');
  await expect(head.locator('.code-lang')).toHaveText('纯文本');
  await expect(head.locator('button.code-copy')).toBeVisible();
  await expect(head.locator('button.code-copy')).toHaveAttribute('aria-label', '复制');
});

test('行号槽：行号和代码同一行对齐，行号宽度一致、不可选中', async ({ page }) => {
  await page.goto(POST, { waitUntil: 'domcontentloaded' });
  const fig = page.locator('.article-content figure.code-block').nth(1);
  await fig.scrollIntoViewIfNeeded();
  const rows = await fig.evaluate((f) =>
    [...f.querySelectorAll('.line')].map((line) => {
      const ln = line.querySelector('.ln').getBoundingClientRect();
      const cl = line.querySelector('.cl').getBoundingClientRect();
      return {
        lnTop: ln.top,
        clTop: cl.top,
        lnLeft: ln.left,
        lnRight: ln.right,
        clLeft: cl.left,
        select: getComputedStyle(line.querySelector('.ln')).userSelect,
      };
    }),
  );
  expect(rows.length).toBeGreaterThan(1);
  for (const r of rows) {
    expect(Math.abs(r.lnTop - r.clTop)).toBeLessThanOrEqual(1);
    expect(r.clLeft).toBeGreaterThanOrEqual(r.lnRight - 0.5);
    expect(r.select).toBe('none');
  }
  // 所有行的槽左右边一致 → 代码从同一列开始
  for (const r of rows.slice(1)) {
    expect(Math.abs(r.lnLeft - rows[0].lnLeft)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.clLeft - rows[0].clLeft)).toBeLessThanOrEqual(0.5);
  }
});

test('不换行：长行横向滚动，滚动时行号贴住左边', async ({ page }) => {
  await page.goto(POST, { waitUntil: 'domcontentloaded' });
  const figs = page.locator('.article-content figure.code-block');
  // 找一个在 412px 下真的溢出的代码块
  const idx = await figs.evaluateAll((all) => all.findIndex((f) => {
    const pre = f.querySelector('pre');
    return pre.scrollWidth > pre.clientWidth + 4;
  }));
  expect(idx).toBeGreaterThanOrEqual(0);
  const fig = figs.nth(idx);
  await fig.scrollIntoViewIfNeeded();
  const before = await fig.evaluate((f) => {
    const pre = f.querySelector('pre');
    const lines = [...f.querySelectorAll('.line')];
    const lh = parseFloat(getComputedStyle(pre).lineHeight);
    return {
      ws: getComputedStyle(pre).whiteSpace,
      overflowX: getComputedStyle(pre).overflowX,
      // 每行一行高：没有折行
      wrapped: lines.filter((l) => l.getBoundingClientRect().height > lh * 1.5).length,
      lnLeft: f.querySelector('.ln').getBoundingClientRect().left,
      clLeft: f.querySelector('.cl').getBoundingClientRect().left,
      figWidth: f.getBoundingClientRect().width,
    };
  });
  expect(before.ws).toBe('pre');
  expect(['auto', 'scroll']).toContain(before.overflowX);
  expect(before.wrapped).toBe(0);
  // 容器本身不撑破页面
  expect(before.figWidth).toBeLessThanOrEqual(412);

  const after = await fig.evaluate((f) => {
    const pre = f.querySelector('pre');
    pre.scrollLeft = pre.scrollWidth; // 滚到最右（浏览器按最大可滚距离截断）
    return {
      scrollLeft: pre.scrollLeft,
      lnLeft: f.querySelector('.ln').getBoundingClientRect().left,
      clLeft: f.querySelector('.cl').getBoundingClientRect().left,
    };
  });
  expect(after.scrollLeft).toBeGreaterThan(0);
  expect(Math.abs(after.lnLeft - before.lnLeft)).toBeLessThanOrEqual(1);
  // 代码跟着滚走了正好 scrollLeft 那么多，行号槽留在原地
  expect(Math.abs(before.clLeft - after.scrollLeft - after.clLeft)).toBeLessThanOrEqual(1);
  // 页面本身没有横向滚动条
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pageOverflow).toBeLessThanOrEqual(0);
});

test('复制按钮：只复制代码不带行号，按钮显示已复制', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin });
  await page.goto(POST, { waitUntil: 'domcontentloaded' });
  const fig = page.locator('.article-content figure.code-block').first();
  await fig.scrollIntoViewIfNeeded();
  const expected = await fig.evaluate((f) =>
    [...f.querySelectorAll('.cl')].map((l) => l.textContent).join('').replace(/\n$/, ''),
  );
  const btn = fig.locator('button.code-copy');
  await btn.click();
  await expect(btn).toHaveAttribute('data-copied', 'true');
  await expect(btn.locator('[data-code-copy-label]')).toHaveText('已复制');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(expected);
  expect(clip).toContain('SGX_');
  expect(clip).not.toMatch(/^1/);
  await expect(btn).not.toHaveAttribute('data-copied', 'true', { timeout: 4000 });
  await expect(btn.locator('[data-code-copy-label]')).toHaveText('复制');
});
