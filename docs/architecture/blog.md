# 博客子站（blog）

| 项 | 值 |
|---|---|
| 文档编号 | SGX-ARCH-011 |
| 版本 | 1.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |
| 取代 | `docs/blog/sgx-ui-cookie.md`（并入 SGX-SPEC-003 §9） |

## 1. 范围

博客 `https://styrigx.com/blog/`（中文 `/blog/zh/`）。写作规范见 SGX-CON-002。博客没有自己的接口 Worker，只有静态页面与 KV 搜索索引 `site:blog`。

## 2. 位置

| 内容 | 位置 |
|---|---|
| 文章 | `space/web/content/blog/post/<YYYY-MM-DD>-<slug>.md`（英文）与 `.zh.md`（中文） |
| 树形目录页 | `content/blog/tree/`（`layouts/blog/tree.html`） |
| 列表 / 文章 / 标签 / 404 | `layouts/blog/section.html`、`single.html`、`term.html`、`notfound.html` |
| RSS / 站点地图 | `layouts/blog/section.blogrss.xml`、`section.blogsitemap*.xml` |
| 片段 | `layouts/partials/blog/` |
| 样式 | `assets/blog/css/`（`blog/one-ui.css` 等），由 `build-css.cjs` 顺带构建 |
| 脚本 | `assets/blog/js/entries/`（`home.ts`、`article.js`、`tree.ts`、`toc-card.ts`、`topnav.ts`、`scroll-top.ts`；`inherit.ts` 2026-11-12 删除）与 `assets/blog/js/blog/` |
| 字符串表 | `space/web/i18n/` |
| 静态文件 | `static/blog/`（字体、manifest 等） |
| 脚本 | `space/scripts/blog/`（搜索索引、代码高亮 token、静态服务器） |
| 测试 | `tests/blog/*.test.mjs`、`tests/blog/e2e/`、`tests/blog/config/` |

## 3. 规则

3.1 中文页的地址 MUST 在 `/blog/zh/` 下：在 front matter 写 `url: /blog/zh/post/<slug>/`。`layouts/blog/baseof.html` 在不满足时 `errorf` 让构建失败。

3.2 英文文章地址由 `hugo.yaml` 的 `permalinks.page.blog: /blog/post/:contentbasename/` 生成。

3.3 博客页面没有自己的语言、深浅色、配色开关；这些由主站设置并经 `sgx-ui` cookie 首帧读取（`layouts/partials/blog/sgx-inherit.html`，细节见 SGX-SPEC-003 §9）。博客 MUST NOT 写 `sgx-ui`。

3.4 进站：博客页面公开（v5 S3 整站放开）。站点核心 `handleSubsite` 只注入 `data-sgx-lock-session` 标记、不拦；原 `sgx-lock-check.js` 已删除。访客在顶栏终端敲 `sudo styrigx` 去主站锁屏。

3.5 带 `private: true` 的页面不进站点地图。

## 4. 搜索索引

部署时 `space/scripts/blog/build-search-index.mjs` 生成并写入 KV `KV_SEARCH_INDEX` 的 `site:blog` 键；`styrigx-ai` 读它做召回。
