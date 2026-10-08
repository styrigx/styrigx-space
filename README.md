<div align="center">

# Styrigx's Space

**拆开世界是为了了解它，再把它装回去是为了相信它。**

*To understand the world, take it apart; to believe in it, put it back together.*

[中文](README.md) | [English](README.en.md)

![Hugo](https://img.shields.io/badge/Hugo-v0.162.0-2563eb?style=flat-square&logo=hugo)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-v3.4.19-2563eb?style=flat-square&logo=tailwindcss)
![Deploy](https://img.shields.io/github/actions/workflow/status/styrigx/styrigx-space/deploy.yml?style=flat-square&label=Deploy&color=2563eb)
![Site](https://img.shields.io/badge/styrigx.com-online-2563eb?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-2563eb?style=flat-square)

</div>

---

## 这是什么

一个按 One UI 8.5 写的个人网站，把网站做成一台手机。

## 结构

- **主页**：启动页。App 图标网格 + 底部 Dock + 小组件（名片、双时钟、音乐、Now 便签、博客最新、数字花园、屏幕时间、天气）。
- **Dock**：手机 4 个（我的文件、应用商店、浏览器、设置），DeX 5 个（加应用抽屉）。
- **系统应用**：
  - 我的文件：站内文件。文章、书、音乐、我的站点。
  - 应用商店：站内应用。AI、书单、歌单、Good Lock、邀请码站。可安装/卸载。
  - 浏览器：外部平台。站内搜索 + 书签导航。
  - 设置：系统级配置和系统应用的配置。
- **商店应用**：
  - AI：一次提问，各大平台打开。
  - 书单：全部书籍与批注。
  - 歌单：全部歌曲与批注。
  - Good Lock：实验性功能模块。
  - 邀请码站：Muse 邀请码免费共享。

## 分类规则

新内容按下面规则决定放哪里：

- **应用商店**：多人参与的（例如邀请码站）。
- **我的文件**：只有我编写、只有我有权限的（站内文件、博客，以后的书库）。
- **浏览器**：外部平台，包括我在平台上的主页（GitHub、X）。
- **设置**：只放系统级配置和系统应用。

## 改内容

内容全部由 `data/*.yaml` 驱动。改完推送，重新构建即更新。

**加书**（`data/books.yaml`）：

```yaml
- title: 书名
  author: 作者
  cover: /images/books/cover.webp
  rating: 5
  review: 我的短评
```

**加歌**（`data/music.yaml`）：

```yaml
- title: 歌名
  artist: 歌手
  spotify_id: xxx
  apple_id: 123456
```

**加书签**（`data/links.yaml`）：

```yaml
- category: 分类名
  sites:
    - name: 站名
      url: https://example.com
      desc: 一句话说明
```

**加应用**（`data/apps.yaml`）：

```yaml
- id: myapp
  name: 应用名
  desc: 一句话说明
  url: /myapp/
  category: ai
  icon: ai
  ext: false
  defaultVisible: true
```

**加「我的站点」**（`data/sites.yaml`）：

```yaml
- name: 站名
  url: https://example.com
  desc: 一句话说明
  icon: globe
```

英文版同步改 `data/en/` 下的对应文件。

## 技术栈

Hugo（v0.162.0 extended）+ Tailwind CSS（v3.4.19）+ Cloudflare Pages。纯静态，无后端。

## 目录结构

```
├── layouts/            # 模板
│   ├── _default/       # baseof（外壳）、各 App 页面
│   ├── index.html      # 主页
│   └── partials/       # 搜索条、图标、Dock 等组件
├── assets/css/         # input.css（Tailwind 输入）；main.css 由 CI 生成
├── assets/js/          # 公共 JS（主题、语言、搜索、设置读写）
├── data/               # 内容数据（中英分开，en/ 下是英文版）
├── content/            # 页面入口（中英双语）
├── static/             # _redirects（短链）、_headers（缓存）、图片
├── scripts/            # music-previews.mjs（iTunes 试听链接）
└── .github/workflows/  # deploy.yml
```

## 本地开发

```bash
npm install
npx tailwindcss -i assets/css/input.css -o assets/css/main.css
hugo server
```

浏览器打开 http://localhost:1313。

## 部署

推送到 main 分支 → GitHub Actions 自动构建 → 部署到 Cloudflare Pages 项目 `styrigx-portal`。

> 注：`styrigx-portal` 是 Cloudflare Pages 项目的历史名称（Cloudflare 不支持改名），一直沿用至今，对应的是本仓库 Styrigx's Space。

需要的 Secrets（仓库 Settings → Secrets）：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

短链接在 `static/_redirects` 里加一行：

```
/mp  https://github.com/styrigx/muse-playbook  302
```

现有短链：`/mp`（muse-playbook）、`/tp`（textbook-playbook）、`/gh`（GitHub 主页）、`/gh/*`（对应仓库）。

## 相关站点

- 博客：[blog.styrigx.com](https://blog.styrigx.com)
- 邀请码站：[muse-invite.styrigx.com](https://muse-invite.styrigx.com)
- 书库：[book.styrigx.com](https://book.styrigx.com)（个人电子书库；主站书单页通过 `/api/shelf` 拉取书库中「放进书单」的书，有书时显示书库内容，为空时显示本站静态书单）

## 许可

[MIT License](LICENSE)。个人内容（格言、书评、数据、图片）保留版权，未经许可请勿转载。

---

<div align="center">

[博客](https://blog.styrigx.com) · [X](https://x.com/styrigx) · [GitHub](https://github.com/styrigx)

*Yellow earth beneath, green light ahead.*

</div>
