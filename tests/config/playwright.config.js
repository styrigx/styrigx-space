const { defineConfig } = require('@playwright/test');

const SUITE = process.env.SGX_TEST_SUITE || '';
/* passkey：打预览站（真实网关，SGX_TEST_BASE）；credential：自带测试服务器。这两组不需要本地静态站 */
const NEEDS_STATIC = SUITE !== 'passkey' && SUITE !== 'credential';

module.exports = defineConfig({
  /* 配置在 tests/config/，下面的相对路径都以本文件所在目录为基准 */
  testDir: '../web/e2e',
  outputDir: '../../test-results',
  /* 默认组（visual 等）用测试构建（锁屏禁用），lock / edge 用生产构建（锁屏启用）；CI 里分两次构建分别跑 */
  testMatch: process.env.SGX_TEST_SUITE === 'lock' ? ['lock.spec.js', 'lock-mobile.spec.js', 'lock-flags.spec.js', 'lock-reset-pk-busy.spec.js', 'b1-8-return-guard.spec.js'] : process.env.SGX_TEST_SUITE === 'passkey' ? ['passkey.spec.js', 'account-challenge.spec.js'] : process.env.SGX_TEST_SUITE === 'credential' ? ['api-credential.spec.js'] : process.env.SGX_TEST_SUITE === 'edge' ? ['edge-flow.spec.js'] : ['visual.spec.js', 'pc-layout.spec.js', 'settings-sub.spec.js', 'layout-292.spec.js', 'dialog-kb.spec.js', 'reauth-verify.spec.js', 'account.spec.js', 'reauth-return.spec.js', 'topbar-spec.spec.js', 'lang-follow.spec.js', 'lock-now.spec.js', 'b1-12-guard.spec.js', 'b1-10-footer.spec.js', 'upgrade-kb.spec.js', 'avatar-edit.spec.js', 'site-search.spec.js', 'desktop-toggle-root.spec.js', 'nav-drawer.spec.js', 'quick-panel.spec.js', 'ui-cookie-reader.spec.js', 'account-status.spec.js', 'chat-page.spec.js', 'chat-no-key.spec.js', 'layout-auto.spec.js', 'tab-swipe.spec.js', 'inpage-tabs.spec.js'],
  /* passkey 组共用预览站同一份 KV / D1，用例之间有状态：只用 1 个 worker 顺序跑 */
  workers: SUITE === 'passkey' ? 1 : undefined,
  /* 视觉回归：只跑 Chromium，保证基准一致 */
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  snapshotDir: '../web/e2e/visual',
  expect: {
    toHaveScreenshot: {
      /* 允许微小渲染差异（字体抗锯齿等）；CI 里视觉回归是阻塞的 */
      maxDiffPixels: 120,
    },
  },
  webServer: NEEDS_STATIC ? {
    command: 'npx http-server ../../web/public -p 8931 -s',
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
