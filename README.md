<div align="center">

# Styrigx

**拆开世界是为了看懂它，再把它装回去是为了相信它。**

*To understand the world, take it apart; to believe in it, put it back together.*

[中文](README.md) | [English](README.en.md)

![Hugo](https://img.shields.io/badge/Hugo-v0.162.0-2563eb?style=flat-square&logo=hugo)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-v3.4.19-2563eb?style=flat-square&logo=tailwindcss)
![Deploy](https://img.shields.io/github/actions/workflow/status/styrigx/styrigx-space/deploy.yml?style=flat-square&label=Deploy&color=2563eb)
![Site](https://img.shields.io/badge/styrigx.com-online-2563eb?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-2563eb?style=flat-square)

</div>

---

## 🖼️ 效果

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/desktop-dark.png">
  <img src=".github/assets/desktop-light.png" alt="Styrigx's Space 桌面端截图">
</picture>

<img src=".github/assets/mobile-light.png" alt="Styrigx's Space 手机端截图" width="280">

---

## 🌱 这是什么

不是博客，也不只是导航——这是一座**数字花园式的个人门户**。

---

## 🧩 板块

- 🏠 **Hero** — 大标题、径向渐变、双语格言，博客与导航两个行动按钮
- ✨ **精选入口** — Bento 网格，博客卡片占大格，一眼看到最重要的东西
- 📚 **书单** — 真实封面墙，悬停显示我的短评
- 🎵 **歌单** — 循环播放的音乐（整理中）
- 🌿 **收藏** — 数字花园：🌱 幼苗 / 🌿 长成 / 🌳 常青，带标签筛选和我的批注
- 📍 **Now** — 我最近在做什么
- 🧭 **/links 书签导航** — WebStack 风格，分类侧栏 + 即时搜索

---

## ⚡ 特性

- ⌘K / Ctrl+K 全站即时搜索（书签、书、歌、收藏）
- 中英双语；明暗默认跟随系统，可在设置页手动切换（`color-scheme: light dark`，浏览器不再强制重上色）
- 顶栏极简：头像 + Styrigx、搜索、设置；语言和明暗只在 `/settings/` 里改
- 移动端优先，无横向滚动
- 纯静态、无重型框架，Hugo + Tailwind 手写
- 内容全部由 `data/*.yaml` 驱动，改数据文件即更新
- CSS 指纹（hash 文件名）+ 分级缓存策略
- 自定义 404 页面

---

## 🔗 短链

由 `static/_redirects` 实现（Cloudflare Pages 原生支持）：

| 短链 | 跳转到 |
|---|---|
| `styrigx.com/mp` | muse-playbook 仓库 |
| `styrigx.com/tp` | textbook-playbook 仓库 |
| `styrigx.com/gh` | GitHub 主页 |
| `styrigx.com/gh/<repo>` | 对应仓库 |

新增仓库只需在 `_redirects` 里加一行。

---

## 🛠️ 技术栈

Hugo（v0.162.0 extended）+ Tailwind CSS（v3.4.19）+ Cloudflare Pages

## 📊 更新屏幕时间

首页"数字健康"小组件的数据来自 `data/wellbeing.yaml`：

```yaml
updated: "2026-10-08"   # 更新日期
total_minutes: 510      # 总时长（分钟）
apps:
  - key: muse
    zh: "Muse"          # 中文名
    en: "Muse"          # 英文名
    minutes: 185        # 时长（分钟）
    color: "#d97706"    # 进度条分段颜色
```

改完提交推送，重新构建后首页自动更新（总时长和"其他"分段由模板自动计算）。

## 📁 目录结构

```
├── layouts/        # 模板：首页、404、书签页、图标 partial
├── assets/css/     # Tailwind 编译后的 CSS（Hugo Pipes 加指纹）
├── data/           # 内容数据：书单、歌单、收藏、书签、Now、个人资料
├── content/        # 页面内容（中英双语）
├── static/         # _redirects（短链）、_headers（缓存策略）、图片
└── .github/        # Actions 部署 workflow、README 截图资源
```

---

## 💻 本地运行

需要 [Hugo](https://gohugo.io/) extended 版（v0.162.0）：

```bash
hugo server
```

浏览器打开 http://localhost:1313 。

CSS 已预编译好放在 `assets/css/`，日常改模板和数据不需要跑 npm。

---

## 🙏 致谢

视觉灵感来自：

- [HugoBlox](https://hugoblox.com) — 配色与质感
- [Blowfish](https://blowfish.page) — 画廊与导航栏
- [Hugo Profile](https://github.com/gurusabarish/hugo-profile) — Now 板块
- [WebStack-Hugo](https://github.com/shenweiyan/WebStack-Hugo) — 书签导航页
- [Maggie Appleton](https://maggieappleton.com/garden) — 数字花园

---

## 🗺️ 路线图

- [ ] 替换真实素材（头像、歌单封面）
- [ ] 补全歌单
- [ ] 未来抽离为开源 Hugo 主题

---

## 📄 版权

**代码**按 [MIT License](LICENSE) 开源。

**个人内容**保留版权：格言、书评、`data/` 下的数据、头像与图片均为 Sloan Gray 的个人内容，未经许可请勿转载。

---

<div align="center">

[博客](https://blog.styrigx.com) · [X](https://x.com/styrigx) · [GitHub](https://github.com/styrigx)

*Yellow earth beneath, green light ahead.*

</div>
