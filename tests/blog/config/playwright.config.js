import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.BLOG_PORT || 4321);

/* 端到端测试（2026-11-02 从 styrigx-atlas 搬来；styrigx-space 合并 PR2 接进 CI）：2026-11 合站后先 npm run build（主站和三个子站同一个 Hugo 站，产物 space/web/public/），
   这里起一个模拟 Pages 的静态服务器（space/scripts/blog/serve-static.mjs），
   博客在 /blog/ 下（测试里的地址都带 /blog 前缀）。
   blog-visual.spec.js 是视觉回归（基线只在 CI 生成：update-snapshots.yml）；其余是行为测试。 */
export default defineConfig({
  testDir: '../e2e',
  timeout: 60000,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    },
  },
  use: {
    baseURL: process.env.BLOG_BASE_URL || `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: process.env.BLOG_BASE_URL
    ? undefined
    : {
        command: `node ../../../space/scripts/blog/serve-static.mjs ../../../space/web/public ${PORT}`,
        url: `http://localhost:${PORT}/blog/`,
        reuseExistingServer: false,
        timeout: 30000,
      },
  projects: [
    /* palette：自定义 option，只有 blog-visual.spec.js 声明并读它（写 sgx-ui cookie 的 pal）；其他 spec 不读，行为不变。
       对齐主站 visual.spec：light = dustyblue（浅套），dark = terra（默认深套，也显式写）。
       深浅只由调色板决定（调色板 v4 不读 prefers-color-scheme），colorScheme 保留，作为「系统深浅不影响页面」的反向保证。 */
    { name: 'mobile-light', use: { viewport: { width: 390, height: 844 }, colorScheme: 'light', palette: 'dustyblue' } },
    { name: 'mobile-dark', use: { viewport: { width: 390, height: 844 }, colorScheme: 'dark', palette: 'terra' } },
    { name: 'desktop-light', use: { viewport: { width: 1200, height: 800 }, colorScheme: 'light', palette: 'dustyblue' } },
    { name: 'desktop-dark', use: { viewport: { width: 1200, height: 800 }, colorScheme: 'dark', palette: 'terra' } },
  ],
});
