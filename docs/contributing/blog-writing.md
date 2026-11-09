# 写博客

| 项 | 值 |
|---|---|
| 文档编号 | SGX-CON-002 |
| 版本 | 2.1 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |
| 取代 | `docs/blog/content-series.md` |

## 1. 范围

在 `https://styrigx.com/blog/` 发表、修改、删除文章的规范。站点结构见 SGX-ARCH-011。

## 2. 文件

2.1 文章放在 `space/web/content/blog/post/`，文件名 `<YYYY-MM-DD>-<slug>.md`（英文）与 `<YYYY-MM-DD>-<slug>.zh.md`（中文）。`slug` 用小写英文与连字符。

2.2 新文章 SHOULD 用 archetype 起稿：`hugo new -s space/web content/blog/post/<YYYY-MM-DD>-<slug>.md`，默认 `draft: true`。

2.3 文章 SHOULD 中英双语；只有一种语言时也能构建，语言跳转只会去声明过的版本（SGX-SPEC-003 §7.4）。

## 3. Front matter

```yaml
---
url: /blog/zh/post/<YYYY-MM-DD>-<slug>/   # 仅中文版，MUST
title: "标题"
description: "一两句摘要，用于列表、RSS、分享卡片"
date: 2026-11-09
tags: ["Cloudflare", "安全"]
categories: ["工程"]            # 可选；任何一篇写了 categories，分类视图就按 categories，否则退回 tags
series: ["系列名"]               # 可选；数组，取第一个
seriesOrder: 2                   # 可选；系列内篇序，从 1 开始
draft: false
private: false                   # 可选；true 时不进站点地图
---
```

3.1 中文版 MUST 写 `url: /blog/zh/post/<文件名去掉 .zh>/`，否则构建失败（`layouts/blog/baseof.html` 守卫）。英文版不写 `url`，由 `permalinks` 生成 `/blog/post/<文件名>/`。

3.2 `title`、`description`、`date` MUST 填写。

3.3 系列：同一系列先按 `seriesOrder` 升序，没写的排在后面，再按日期、文件名。系列的「第 n / N 篇」只在同一语言里计算；文章页标题下显示系列名 · 第 n / N 篇 · 上一篇 / 下一篇，系列名链接到树形目录页 `/blog/tree/#series-<slug>`。中英版本各写各语言的系列名。

3.4 新标签：第一次用到的标签 MUST 在 `space/web/content/tags/<标签>/_index.zh.md` 建中文标签页，写 `url: /blog/zh/tags/<slug>/` 与 `title`；中文标签名再加 `slug: <英文 slug>`（地址里不出现中文，与英文版同一个 slug）。缺这个文件构建失败。英文标签页不需要文件。中文页上的纯英文标签名要在 `tests/space/ui/build/lang-pack.test.mjs` 的 `ZH_ALLOW` 放行。

3.5 新增文章后同步 `tests/blog/url-map.json`（页面、站点地图、RSS 顺序）和读取文章篇数的测试（`tests/blog/urls-regression.test.mjs`、`tests/blog/e2e/app-topbar.spec.js`）。

## 4. 内容规则

4.1 文章 MUST NOT 包含任何密钥、token、密码、恢复钥匙的值，以及内部资源 id（D1 / KV id、Secrets Store id、账号 id 等）。Secret 只可写名字。

4.2 站内链接写带 `/blog` 前缀的绝对路径（如 `/blog/zh/post/<slug>/`）；`tests/blog/urls-regression.test.mjs` 会核对页内链接。

4.3 图片放在 `space/web/static/blog/`，SHOULD 压缩并提供替代文本。

4.4 代码块标注语言；代码高亮 token 由 `space/scripts/blog/gen-code-tokens.mjs` 生成（CI 核对同步）。

## 5. 删除或改名

5.1 删除文章时 MUST 同时删除中英两个文件，并更新 `tests/blog/url-map.json` 与引用该文章的测试；只被该文章使用的标签随之消失。

5.2 改地址 SHOULD 在 front matter 加 `aliases` 保留旧地址。

## 6. 验证

```bash
npm run build
node --test tests/blog/*.test.mjs
npx playwright test --config=tests/blog/config/playwright.config.js
```

部署后博客搜索索引 `site:blog` 自动更新，AI 召回随之可见。
