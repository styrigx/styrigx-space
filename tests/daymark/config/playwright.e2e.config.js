/* 手机 E2E 配置：只做功能断言，不做截图比对。
 * 设备：Chromium，412×915 / 360×800，
 * deviceScaleFactor 2.625，isMobile + hasTouch。
 *
 * 2026-11-02 从 styrigx-atlas 搬来；styrigx-space 合并 PR2 接进 CI：2026-11 合站后先 npm run build（主站和三个子站同一个 Hugo 站，产物 space/web/public/），这里起模拟 Pages 的静态服务器（space/scripts/blog/serve-static.mjs），
 * 本站在 /daymark/ 下（测试里的地址都带 /daymark 前缀）。CI 见仓库根 .github/workflows/deploy.yml。
 */
const { defineConfig } = require('@playwright/test');

const PHONE = { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };

module.exports = defineConfig({
  testDir: '../e2e',
  testMatch: ['*.spec.js'],
  projects: [
    {
      name: 'phone-412',
      use: { browserName: 'chromium', viewport: { width: 412, height: 915 }, ...PHONE },
    },
    {
      name: 'phone-360',
      use: { browserName: 'chromium', viewport: { width: 360, height: 800 }, ...PHONE },
    },
  ],
  webServer: {
    command: 'node ../../../space/scripts/blog/serve-static.mjs ../../../space/web/public 8932',
    port: 8932,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:8932',
    timezoneId: 'Asia/Shanghai',
  },
  reporter: [['list']],
  timeout: 60000,
});
