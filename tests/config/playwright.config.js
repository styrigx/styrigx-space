const { defineConfig } = require('@playwright/test');

const SUITE = process.env.SGX_TEST_SUITE || '';
/* passkey：打预览站（真实网关，SGX_TEST_BASE），不需要本地静态站（credential 组随 v6 P4 后端删旧删除） */
const NEEDS_STATIC = SUITE !== 'passkey';

module.exports = defineConfig({
  /* 配置在 tests/config/，下面的相对路径都以本文件所在目录为基准 */
  testDir: '../space/e2e',
  outputDir: '../../test-results',
  /* 默认组（visual 等）用测试构建（锁屏禁用），lock / edge 用生产构建（锁屏启用）；CI 里分两次构建分别跑 */
  testMatch: process.env.SGX_TEST_SUITE === 'lock' ? ['lock.spec.js', 'lock-mobile.spec.js', 'lock-flags.spec.js'] : process.env.SGX_TEST_SUITE === 'passkey' ? ['passkey.spec.js', 'account-passkey.spec.js'] : process.env.SGX_TEST_SUITE === 'edge' ? ['edge-flow.spec.js'] : ['visual.spec.js', 'pc-layout.spec.js', 'space-sub.spec.js', 'layout-292.spec.js', 'keys.spec.js', 'devices.spec.js', 'proxy.spec.js', 'term.spec.js', 'topbar-spec.spec.js', 'lang-follow.spec.js', 'b1-12-guard.spec.js', 'b1-10-footer.spec.js', 'avatar-edit.spec.js', 'desktop-toggle-root.spec.js', 'quick-panel.spec.js', 'ui-cookie-reader.spec.js', 'space-status.spec.js', 'layout-auto.spec.js', 'topbar-length.spec.js', 'profile.spec.js', 'popover-no-zoom.spec.js', 'manual-desktop.spec.js', 'terminal.spec.js', 'shield.spec.js', 'ai-window.spec.js', 'ai-open.spec.js', 'touch-scroll-fab.spec.js', 'music-open.spec.js'],
  /* passkey 组共用预览站同一份 KV / D1，用例之间有状态：只用 1 个 worker 顺序跑 */
  workers: SUITE === 'passkey' ? 1 : undefined,
  /* 视觉回归：只跑 Chromium，保证基准一致 */
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  /* 截图基线跟着 spec 放：默认 snapshotDir = testDir，基线在 <spec 所在目录>/<spec 文件名>-snapshots/（visual/visual.spec.js → visual/visual.spec.js-snapshots/）。
     2026-11-06 tests/ 结构统一前是 snapshotDir: '../web/e2e/visual'、spec 平铺在 e2e/，基线落点和现在逐字相同（只随 web → space 改名） */
  expect: {
    toHaveScreenshot: {
      /* 允许微小渲染差异（字体抗锯齿等）；CI 里视觉回归是阻塞的 */
      maxDiffPixels: 120,
    },
  },
  webServer: NEEDS_STATIC ? {
    command: 'npx http-server ../../space/web/public -p 8931 -s',
    port: 8931,
    reuseExistingServer: true,
  } : undefined,
  use: {
    baseURL: 'http://localhost:8931',
    /* 固定时区：避免 CI 与本地时区不同导致时钟截图差异 */
    timezoneId: 'Asia/Shanghai',
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
});
