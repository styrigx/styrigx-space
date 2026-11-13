/**
 * 音乐分层方案 v1.13 §九：顶栏音乐图标的小遥控层（topbar/panel.js mountMusic + #sgx-mu）。
 * 播放器用同源另一页的 BroadcastChannel 冒充（静态测试站没有 /curio/api/music），只验遥控这一侧：
 * - 加载先问 player-hello；没人答 → 点图标开播放器（music-open.spec.js 管）；
 * - 答了在播 → 点图标弹遥控层（歌名、歌手、上一曲 / 暂停 / 下一曲），图标亮小点；按钮发 remote-cmd；「播放器」切到播放器窗；
 * - 播放器关窗（player-bye）→ 遥控层收起、小点灭。
 * 纯逻辑在 tests/space/ui/topbar/music-open.test.mjs。
 */
const { test } = require('@playwright/test');
const { blockExternalRequests, expect } = require('../helpers/helpers');

async function open(page) {
  await blockExternalRequests(page);
  await page.addInitScript(() => { try { localStorage.setItem('sgx-lang', 'zh'); } catch (e) {} });
  await page.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.sgx-topbar')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sgx-layout'));
}
/** 冒充播放器：收到 player-hello 答 state；记下收到的 remote-cmd */
async function fakePlayer(ctx, state) {
  const p = await ctx.newPage();
  await p.goto('/zh/status/', { waitUntil: 'domcontentloaded' });
  await p.evaluate((st) => {
    const ch = new BroadcastChannel('sgx-music');
    window.__cmds = [];
    window.__say = (m) => ch.postMessage(m);
    ch.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'player-hello') ch.postMessage(st);
      if (m.type === 'remote-cmd') { window.__cmds.push(m.cmd); if (m.cmd === 'toggle') { st.playing = !st.playing; ch.postMessage(st); } }
    };
  }, state);
  return p;
}

test('播放器答了在播：点图标弹遥控层，按钮发命令；关窗后收起', async ({ page, context }) => {
  const player = await fakePlayer(context, { type: 'player-state', on: true, playing: true, title: '夜曲', artist: '周杰伦' });
  await open(page);
  const btn = page.locator('.sgx-tb-music');
  await expect(btn).toHaveClass(/is-playing/);
  let extra = 0;
  context.on('page', () => { extra++; });
  await btn.click();
  const dlg = page.locator('#sgx-mu');
  await expect(dlg).toHaveClass(/is-open/);
  await expect(dlg.locator('[data-mu-title]')).toHaveText('夜曲');
  await expect(dlg.locator('[data-mu-artist]')).toHaveText('周杰伦');
  await expect(dlg.locator('[data-mu="toggle"]')).toHaveAttribute('aria-label', '暂停');
  expect(extra).toBe(0);
  await dlg.locator('[data-mu="toggle"]').click();
  await expect(dlg.locator('[data-mu="toggle"]')).toHaveAttribute('aria-label', '播放');
  await expect(btn).not.toHaveClass(/is-playing/);
  await dlg.locator('[data-mu="prev"]').click();
  await dlg.locator('[data-mu="next"]').click();
  await expect.poll(() => player.evaluate(() => window.__cmds)).toEqual(['toggle', 'prev', 'next']);
  await player.evaluate(() => window.__say({ type: 'player-bye' }));
  await expect(dlg).not.toHaveClass(/is-open/);
});

test('没在播（on=false）：点图标照旧开播放器，不弹遥控层', async ({ page, context }) => {
  await fakePlayer(context, { type: 'player-state', on: false, playing: false, title: '', artist: '' });
  await open(page);
  const [pop] = await Promise.all([context.waitForEvent('page'), page.locator('.sgx-tb-music').click()]);
  await pop.waitForURL(/\/curio\/zh\/music\/player\/$/);
  await expect(page.locator('#sgx-mu')).not.toHaveClass(/is-open/);
});
