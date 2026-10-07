import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  executablePath: '/home/hatch/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome',
  headless: 'new'
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('http://127.0.0.1:8902/en/', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: 'preview/home-en.png' });
await page.goto('http://127.0.0.1:8902/work/', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: 'preview/work-zh.png' });
await browser.close();
console.log('done');
