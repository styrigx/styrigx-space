# Styrigx 3.0 任务书

## 队列

> 定时任务每 30 分钟一轮：取第一个没勾、没标「等用户」/「卡住」的项推进。
> 规则：只走 PR；不直推 main；不 force push；不删/不清生产 KV；不动 Cloudflare 后台与密钥；不留兼容层。
> 队列更新跟在对应项的 PR 里一起提交。

- [x] 2.4.2 #11（styrigx-space，可合并）：Hugo 0.167 + Tailwind 4；Actions 整理只是升了版本号、把版本收成一处。分支 `feat/2.4.2-infra`，commit 977228e9 已合入 main。验收：生产部署 run 38024526434 全绿，styrigx.com 首页 200，owner-status 正常。✓ 2026-10-10
- [x] 队列 PR #12（styrigx-space，可合并）：3.0 任务队列文档。commit da2418e2 已合入 main。定时任务只读 main 上的队列。✓ 2026-10-10
- [x] 2.5.0 布局模式（styrigx-space，已合并）：PR #19（分支 `feat/2.5.0-layout-mode`），PR CI run 38031998021 全绿，merge commit ee1e452；main 部署 run 38033087511 全绿；Gray 15:35 亲自解锁看过，1920 四项通过，核验结清。✓ 2026-10-10
- [x] 改名 portal→space（三仓库，已合并）：space PR #21（`chore/rename-portal-to-space`，merge 57ae7911b539，main 部署 run 38038564454 全绿）；blog PR #6（`chore/rename-portal-to-space`，merge 72fc2f949d83）；book 经 code search 确认无残留 portal 引用，无需 PR。✓ 2026-10-10
- [x] 2.4.1 主站 #14（styrigx-space，已合并）：PR #14（`feat/2.4.1-portal-lock-v2`，追加提交 middleware `site==='space'`、sites.yaml id、测试/文档），PR CI run 38039100092 全绿，merge commit 8059894d9fe0；main 部署 run 38039540912 全绿。线上核验：/owner/、/settings/、/browser/、/goodlock/ 未带 cookie 均返回「已锁定」锁屏页（200），/ 与 /en/ 白名单正常，/api/owner-status 返回 `{"ok":true,"password":true,"passkey":true}`。✓ 2026-10-10
- [x] 2.4.1 blog workflow（styrigx-blog，已合并）：PR #5（commit 2bdf21cf），CI run 38026813159 全绿，merge ccad181b。✓ 2026-10-10
- [ ] 2.4.1 收尾（等用户）：**请 Gray 本人在手机上解锁一次**，确认拿到 sgx-verified cookie、内页正常访问（解锁必须他本人做，助手没有他的 owner key）。通过后按顺序合并（只用 PUT merge，永不开 auto-merge；任一步失败停下报告，不继续后面）：① blog #4（`feat/2.4.1-blog-lock`，head c7df1a99，CI 全绿）→ 部署成功后核验未解锁 302 到锁屏、解锁后正常打开；② book #2（`feat/2.4.1-book-lock`，head 5eeb1a61，CI 全绿）→ 同上核验，另确认书架数据正常。
- [x] README 动态徽章（styrigx-space，已合并）：PR #13 已合并（merge 7d109944）；main 部署 run 38026341722 全绿。deploy.yml 顶层 env.HUGO_VERSION 单源；tailwindcss/@tailwindcss/cli 统一 ^4.3.3，删 postcss；README 中英三徽章动态化，实测 Hugo 0.167.0 / Tailwind 4.3.3 / Styrigx UI 2.4.2。✓ 2026-10-10
- [ ] 2.6.0 设置二级页 + 关于（styrigx-space，已暂停）：PR #20（`feat/2.6.0-settings`）已暂停，不合并、不开 auto-merge、不推新提交；等改名 + 2.4.1 全部完成后主会话再继续。本轮及后续轮次不碰。
- [ ] 2.6.0 合并后：三站 pages.dev 301 到正式域名（各独立 PR，各用对应仓库 token，functions/_middleware 链首，只精确匹配 `<project>.pages.dev`，保留 path+query，Cache-Control: no-store，从各仓库最新 main 开分支，加测试，CI 绿后 PUT merge，部署后 curl 核验三个 301 + 三个 200 + owner-status）。
- [ ] 2.7.0 语言 / G / 天气（styrigx-space，可合并）：语言跟随系统/中文/English；G 按 `build:false` 清单；天气定位顺序手动城市 > 精确定位（不自动弹权限）> IP 兜底。验收：CI 全绿 → 合并 → 生产部署 run 全绿 → 线上验证。
- [ ] 2.8.0 清理（styrigx-space，可合并）：命名弹层 One UI 细节；rename 是否覆盖 `lastUsedAt`；提供方映射；最近使用显示；死代码。验收同上。
- [ ] 3.0.0 应用商店重定义（styrigx-space，可合并）：商店=应用抽屉+安装管理，唯一应用入口；首页只留小组件卡片；Dock 固定我的文件/应用商店/浏览器/设置；版本号只改 `hugo.yaml` params 一处为 3.0.0。验收同上。

## 已完成

- 0a PR #9（fix/passkey-index-backfill，ce7d0705）：索引补建。生产 run 38001752282 全绿，owner-status 返回 `{"ok":true,"password":true,"passkey":true}`。
- 0b PR #7（fix/workflow-dispatch-deploy，8fb9c2ec）：workflow_dispatch 仅 main 可部署。生产 run 38002967275 全绿。
- 0b PR #6（test/p0-3-e2e-gaps，efdba95d）：UV=0 专属错误码 + E2E 断言 + 2.4.1 设计文档。生产 run 38004261614 全绿。
- 0c 每日巡检：`site_check.py` 与 cron 任务说明已加 302 规则（blog/book 302 到 `https://styrigx.com/?lock=1&return=...` 属正常）。
- 2.4.2 PR #11（feat/2.4.2-infra，977228e9）：Hugo 0.167 + Tailwind 4 完整迁移。PR CI run 38024130633 全绿，已合并。
- 2.5.0 PR #19（feat/2.5.0-layout-mode，ee1e452）：PR CI run 38031998021 全绿；生产 run 38033087511 全绿；Gray 15:35 亲自解锁验收，1920 四项通过。
- 改名 portal→space：space PR #21（57ae7911b539，生产 run 38038564454 全绿）、blog PR #6（72fc2f949d83）；book 无残留。
- 2.4.1 主站 PR #14（feat/2.4.1-portal-lock-v2，8059894d9fe0）：PR CI run 38039100092 全绿；生产 run 38039540912 全绿；线上内页锁屏已验证（未带 cookie 内页 200「已锁定」，owner-status password:true、passkey:true）；等 Gray 手机解锁。
