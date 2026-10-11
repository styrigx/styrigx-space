const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  /* Hark：visual 用测试构建（锁屏禁用），lock 用生产构建（锁屏启用）；
     CI 里分两次构建分别跑 */
  testMatch: process.env.SGX_TEST_SUITE === 'lock' ? ['lock.spec.js', 'lock-flags.spec.js'] : process.env.SGX_TEST_SUITE === 'passkey' ? ['passkey.spec.js'] : ['visual.spec.js', 'pc-layout.spec.js', 'settings-sub.spec.js'],
  /* 视觉回归：只跑 Chromium，保证基准一致 */
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  snapshotDir: './tests/e2e/visual',
  expect: {
    toHaveScreenshot: {
      /* 允许微小渲染差异（字体抗锯齿等）；CI 设 continue-on-error，仅报告 */
      maxDiffPixels: 120,
    },
  },
  webServer: {
    command: 'npx http-server ./public -p 8931 -s',
    port: 8931,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:8931',
    /* 固定时区：避免 CI 与本地时区不同导致时钟截图差异 */
    timezoneId: 'Asia/Shanghai',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
