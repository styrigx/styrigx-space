<div align="center">

中文 | [English](README.en.md)

# Styrigx's Space

拆开世界是为了了解它，再把它装回去是为了相信它。

[在线访问 styrigx.com](https://styrigx.com) · [博客 blog.styrigx.com](https://blog.styrigx.com) · [GitHub @styrigx](https://github.com/styrigx) · [X @styrigx](https://x.com/styrigx)

![Hugo](https://img.shields.io/badge/dynamic/yaml?url=https://raw.githubusercontent.com/styrigx/styrigx-space/main/.github/workflows/deploy.yml&query=%24.env.HUGO_VERSION&label=Hugo&style=flat-square&color=2563eb&logo=hugo)
![Tailwind CSS](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/styrigx/styrigx-space/main/package-lock.json&query=%24.packages%5B%27node_modules%2Ftailwindcss%27%5D.version&label=Tailwind%20CSS&style=flat-square&color=2563eb&logo=tailwindcss)
![Styrigx UI](https://img.shields.io/badge/dynamic/yaml?url=https://raw.githubusercontent.com/styrigx/styrigx-space/main/web/data/version.yaml&query=%24.ui&label=Styrigx%20UI&style=flat-square&color=2563eb)
![Deploy](https://img.shields.io/github/actions/workflow/status/styrigx/styrigx-space/deploy.yml?style=flat-square&label=Deploy&color=2563eb)
![License](https://img.shields.io/badge/License-MIT-2563eb?style=flat-square)

</div>

---

## 这是什么

我的个人主页，长得像一台三星手机。文章和常用的站点都是桌面上的 App，点开就能用。界面叫 Styrigx UI，参考 One UI 9.0 自己写的，手机、平板和 DeX 都能打开。

## 预览

| ![手机主页](docs/screenshots/home-mobile.jpg) | ![设置](docs/screenshots/settings-mobile.jpg) |
|---|---|
| 手机主页 | 设置 |

![DeX](docs/screenshots/home-dex.jpg)
DeX

## 结构

| 应用 | 路径 | 是什么 |
|---|---|---|
| 主页 | `/` | 启动页：应用图标、小组件和 Dock。小组件有名片、双时钟、天气、Now 便签、博客最新、数字花园、屏幕时间和收藏。 |
| 我的文件 | `/files/` | 只放我自己写的东西：文章、博客、书库。 |
| 书签 | `/bookmarks/` | 外部站点书签，按分类筛选。 |
| 全网搜索 | `/search/` | 站内建议 + 用所选搜索引擎搜索，支持语音；搜索引擎在 设置 › 安全与隐私 里选。 |
| 设置 | `/settings/` | 显示、语言、布局等系统设置，偏好存在本地。 |

Dock 只在主页显示；进入应用后底部只留搜索栏。

## Styrigx UI 的几个细节

- 两种布局：手机（<640px）和 DeX（≥640px）。
- 浅色 / 深色默认跟随系统。
- 大标题随滚动折叠成顶栏小标题。
- 底部搜索胶囊支持语音输入（Chrome 和三星浏览器）。
- 中文 / English 两套页面。

## 本地运行

环境要求：Hugo extended 0.167.0、Node.js（CI 用 20，构建 Tailwind 需要）。

```bash
git clone https://github.com/styrigx/styrigx-space.git
cd styrigx-space
npm install
npm run build:css
hugo server -s web
```

浏览器打开 http://localhost:1313。构建用 `hugo --minify -s web`，产物在 `web/public/`。

推送 main 后自动部署到 Cloudflare Pages（Pages 项目名 `styrigx-space`）。

## 目录说明

网站本体在 `web/`，Worker 在 `workers/`，测试在 `tests/`。完整说明见 [STRUCTURE.md](STRUCTURE.md)。

## 许可

代码 MIT；文章、图片、头像等个人内容保留所有权利。

© 2020–2026 Sloan Gray · Powered by Styrigx UI
