const { test } = require('@playwright/test');
test('dock ancestor chain', async ({ page }) => {
  await page.setViewportSize({ width: 915, height: 412 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dex-dock', { timeout: 15000 });
  
  const chain = await page.evaluate(() => {
    const out = [];
    const dock = document.querySelector('#dex-dock');
    const ds = getComputedStyle(dock);
    out.push({ el: '#dex-dock', position: ds.position, top: ds.top, bottom: ds.bottom, transform: ds.transform });
    for (let n = dock.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      out.push({
        el: n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).trim().replace(/\s+/g, '.') : ''),
        transform: s.transform, filter: s.filter, backdrop: s.backdropFilter,
        perspective: s.perspective, willChange: s.willChange, contain: s.contain,
      });
    }
    return out;
  });
  console.log(JSON.stringify(chain, null, 2));
});
