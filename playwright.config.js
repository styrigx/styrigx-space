const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: 'visual.spec.js',
  /* 视觉回归：只跑 Chromium，保证基准一致 */
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  snapshotDir: './tests/visual',
  expect: {
    toHaveScreenshot: {
      /* CI 与本地字体渲染差异容忍：5% 像素可不同 */
      maxDiffPixelRatio: 0.05,
    },
  },
  webServer: {
    command: 'npx http-server ./public -p 8931 -s',
    port: 8931,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:8931',
  },
  reporter: [['list']],
});
