# Styrigx 3.0 任务书

## 队列

> 定时任务每 30 分钟一轮：取第一个没勾、没标「等用户」/「卡住」的项推进。
> 规则：只走 PR；不直推 main；不 force push；不删/不清生产 KV；不动 Cloudflare 后台与密钥；不留兼容层。
> 队列更新跟在对应项的 PR 里一起提交。

- [x] 2.4.2 #11（styrigx-space，可合并）：Tailwind 4 + Hugo 0.167 + Actions 整理。分支 `feat/2.4.2-infra`，commit 977228e9 已合入 main。Actions 整理内容：workflow 三处 hugo-version 0.162.0 → 0.167.0；构建脚本改用 `@tailwindcss/cli`。验收：生产部署 run 38024526434 全绿（quality/build-and-deploy/passkey-e2e），styrigx.com 首页 200，owner-status `{"ok":true,"password":true,"passkey":true}`，blog/book 200。✓ 2026-10-10
- [] 2.4.1 主站 #10（styrigx-space，只开不合）：修 hugo 构建报错。分支 `feat/2.4.1-portal-lock`。验收：CI 全绿。Gray 未配 `SGX_ED25519_PRIVATE`/`SGX_ED25519_PUBLIC`，不合并。
- [] 2.4.1 blog #4（styrigx-blog，只开不合）：给 workflow 加 `pull_request` 触发让 PR 跑 CI，然后修到绿。分支 `feat/2.4.1-blog-lock`。验收：CI 全绿。Gray 未配 `SGX_ED25519_PUBLIC`，不合并。
- [] 2.4.1 book（styrigx-book，只开不合）：【等用户】等 Gray 给 `styrigx-book-deploy` token 加 Contents 与 Pull requests 读写权限，轮到时跳过。
- [] README 动态徽章（styrigx-space，可合并）：徽章不再手写版本号。
  1. Hugo 版本单源：deploy.yml 顶层 env 定义 HUGO_VERSION，两处 job 引用。
  2. Tailwind 三包统一同版本；若只用 CLI 构建，删 postcss 插件与 postcss.config.js；更新 lock。
  3. README 中英同步改 shields.io 动态徽章（flat-square、2563eb、带 logo）：Hugo 读 deploy.yml $.env.HUGO_VERSION；Tailwind 读 package-lock.json 实际安装版本；新增 Styrigx UI 徽章读 hugo.yaml params 版本。
  4. PR 里贴三徽章实际渲染结果。
  验收：CI 全绿 → 合并。
- [] 2.5.0 布局模式（styrigx-space，可合并）：#11 部署成功后从 main 开分支。验收：CI 全绿 → 合并 → 生产部署 run 全绿 → 线上验证。
- [] 2.6.0 设置二级页 + 关于（styrigx-space，可合并）：设置顶层只留账户卡 + 分类列表，选项进子页；关于页保留站点优点。验收同上。
- [] 2.7.0 语言 / G / 天气（styrigx-space，可合并）：语言跟随系统/中文/English；G 按 `build:false` 清单；天气定位顺序手动城市 > 精确定位（不自动弹权限）> IP 兜底。验收同上。
- [] 2.8.0 清理（styrigx-space，可合并）：命名弹层 One UI 细节；rename 是否覆盖 `lastUsedAt`；提供方映射；最近使用显示；死代码。验收同上。
- [] 3.0.0 应用商店重定义（styrigx-space，可合并）：商店=应用抽屉+安装管理，唯一应用入口；首页只留小组件卡片；Dock 固定我的文件/应用商店/浏览器/设置；版本号只改 `hugo.yaml` params 一处为 3.0.0。验收同上。

## 已完成

- 0a PR #9（fix/passkey-index-backfill，ce7d0705）：索引补建。生产 run 38001752282 全绿，owner-status 返回 `{"ok":true,"password":true,"passkey":true}`。
- 0b PR #7（fix/workflow-dispatch-deploy，8fb9c2ec）：workflow_dispatch 仅 main 可部署。生产 run 38002967275 全绿。
- 0b PR #6（test/p0-3-e2e-gaps，efdba95d）：UV=0 专属错误码 + E2E 断言 + 2.4.1 设计文档。生产 run 38004261614 全绿。
- 0c 每日巡检：`site_check.py` 与 cron 任务说明已加 302 规则（blog/book 302 到 `https://styrigx.com/?lock=1&return=...` 属正常）。
- 2.4.2 PR #11（feat/2.4.2-infra，977228e9）：Hugo 0.167 + Tailwind 4 完整迁移。PR CI run 38024130633 全绿，已合并。

## 卡住 / 跳过

- 2.4.1 book：token `styrigx-book-deploy` 无 Contents/Pull requests 写权限，开不了分支与 PR，等 Gray 在 GitHub 后台加权限。
- PR #10（2.4.1 主站）曾因 middleware 未配密钥时 fail closed 导致 CI 构建失败，已修为未配置时放行；待本地复现 hugo 构建报错后继续。
