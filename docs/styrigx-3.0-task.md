# Styrigx 3.0 任务书

## 全局标准（Gray 2026-10-10 定，每个 PR 都按此验收）

1. **命名**：Styrigx = Styrigx UI（界面+发行版）+ SGX（内核）。不用"OS"命名；文字一律写 Styrigx，不写 StyrigX。
2. **版本**：UI 版本对齐 One UI，当前 8.5；内核沿开发版本线，队列里的 2.6.0/2.7.0/2.8.0/3.0.0 都是 SGX 版本。对外显示为「Styrigx UI 8.5 · SGX x.y」。版本只从 `data/version.yaml` 读，禁止硬编码；`hugo.yaml` 里旧的版本字段和 README 徽章都改为从这里取。
3. **锁屏**：唯一状态源是服务端 sgx-verified（Domain=.styrigx.com; Path=/）。禁止用 sessionStorage、localStorage、BroadcastChannel、前端内存或标签页状态另做鉴权。
4. **分层**（docs/architecture.md）：L0 凭证与签名 → L1 middleware（唯一鉴权判断，含 return 校验）→ L2 api → L3 共享库（不含鉴权）→ L4 shell/锁屏（只显示和提交）→ L5 页面应用 → L6 blog/book（只用公钥验签，book 的 D1/绑定保留）。上层只能调用下层，不能跨层，也不能重复实现下层职责。
5. **规则**：只走 PR；不直推 main；不 force push；只用 PUT /pulls/{n}/merge，禁止手造 merge commit；每个分支从最新 main 开；不删测试、不跳过测试；不删或清空生产 KV/D1；不动 Cloudflare 后台和密钥；不留兼容层。同一问题修两轮仍失败就停下不合，报告 Gray。

## 每个阶段的验收标准

CI 全绿 → PUT merge → 生产部署 run 全绿 → curl 冒烟测试（首页 200、/api/session-check 401、/api/owner-status password/passkey 都为 true、blog 文章和 book /read/ 未带 cookie 都 302 到锁屏）。

## 队列

> 定时任务每 30 分钟一轮：取第一个没勾、没标「等用户」/「卡住」的项推进。
> 规则见上方全局标准第 5 条。
> 队列更新跟在对应项的 PR 里一起提交。

- [x] 2.4.2 #11（styrigx-space，可合并）：Hugo 0.167 + Tailwind 4；Actions 整理只是升了版本号、把版本收成一处。分支 `feat/2.4.2-infra`，commit 977228e9 已合入 main。验收：生产部署 run 38024526434 全绿，styrigx.com 首页 200，owner-status 正常。✓ 2026-10-10
- [x] 队列 PR #12（styrigx-space，可合并）：3.0 任务队列文档。commit da2418e2 已合入 main。定时任务只读 main 上的队列。✓ 2026-10-10
- [x] 2.5.0 布局模式（styrigx-space，已合并）：PR #19（分支 `feat/2.5.0-layout-mode`），PR CI run 38031998021 全绿，merge commit ee1e452；main 部署 run 38033087511 全绿；Gray 15:35 亲自解锁看过，1920 四项通过，核验结清。✓ 2026-10-10
- [x] 改名 portal→space（三仓库，已合并）：space PR #21（`chore/rename-portal-to-space`，merge 57ae7911b539，main 部署 run 38038564454 全绿）；blog PR #6（`chore/rename-portal-to-space`，merge 72fc2f949d83）；book 经 code search 确认无残留 portal 引用，无需 PR。✓ 2026-10-10
- [x] 2.4.1 主站 #14（styrigx-space，已合并）：PR #14（`feat/2.4.1-portal-lock-v2`，追加提交 middleware `site==='space'`、sites.yaml id、测试/文档），PR CI run 38039100092 全绿，merge commit 8059894d9fe0；main 部署 run 38039540912 全绿。线上核验：/owner/、/settings/、/browser/、/goodlock/ 未带 cookie 均返回「已锁定」锁屏页（200），/ 与 /en/ 白名单正常，/api/owner-status 返回 `{"ok":true,"password":true,"passkey":true}`。✓ 2026-10-10
- [x] 2.4.1 blog workflow（styrigx-blog，已合并）：PR #5（commit 2bdf21cf），CI run 38026813159 全绿，merge ccad181b。✓ 2026-10-10
- [x] 2.4.1 收尾（已合并）：space #27（`fix/2.4.1-frontend-session`，merge 19799d0，部署 run 38054846123 全绿；分层规范 L0-L6、data/version.yaml、data-sgx-session 注入、POST /api/lock 全域锁定）；space #28（`fix/2.4.1-lock-return`，merge aae2372，部署 run 38058893265 全绿；3 个锁屏 bug：头像裂图放行、?return= 302 加 no-store、解锁后回跳）；blog #4（`feat/2.4.1-blog-lock`，merge 27d68ab，部署 run 38059530196 全绿；文章 302 到锁屏）；book #2（`feat/2.4.1-book-lock`，merge 2baa787，部署 run 38059746693 全绿；/read/ 302 到锁屏）；styrigx-blog-preview 和 styrigx-book-preview 两个预览项目已删除。✓ 2026-10-10
- [x] README 动态徽章（styrigx-space，已合并）：PR #13 已合并（merge 7d109944）；main 部署 run 38026341722 全绿。deploy.yml 顶层 env.HUGO_VERSION 单源；tailwindcss/@tailwindcss/cli 统一 ^4.3.3，删 postcss；README 中英三徽章动态化，实测 Hugo 0.167.0 / Tailwind 4.3.3 / Styrigx UI 2.4.2。✓ 2026-10-10
- [x] 仓库分层重组（styrigx-space，已合并）：只移动文件、改 import，不改行为。顶层 functions/、assets/、layouts/ 不动。functions/_lib → functions/_kernel（L0）；_middleware.js 保持原位（L1）；functions/api（L2）；assets/js/sgx 拆成 assets/js/lib（L3）、assets/js/shell（L4，含 lock.js）、assets/js/apps（L5，page-*.js 和 entries）；tests 拆成 tests/kernel、tests/ui、tests/e2e。新增 scripts/check-layers.mjs 并接入 CI：下层 import 上层、跨层 import、L3 以上出现鉴权逻辑或 storage 鉴权，都算失败。PR #30（`refactor/layered-layout`，merge e204423；PR CI quality + passkey-e2e 全绿；main 部署 run 38063469297 全绿；线上冒烟：首页 200、owner-status password:true/passkey:true、session-check 401、内页 302 到 `/?lock=1&return=`、锁屏 bundle 200。✓ 2026-10-10
- [x] 2.6.0 设置二级页 + 关于（styrigx-space，已合并）：PR #20 关闭未合，改由 PR #31（`feat/2.6.0-settings-v2`，merge c120f443，main 部署 run 38065676001 全绿）在新目录结构上重做；后续 fix #34（`fix/unlock-entry-move`，merge 904d1537，部署 run 38069096652 全绿：解锁方式入口从账户卡移到安全与隐私第一行、去掉版本硬编码兜底）。data/version.yaml：ui 8.5 / sgx 2.6.0；线上冒烟：首页 200、owner-status password:true/passkey:true、session-check 401。✓ 2026-10-11
- [x] 三站 pages.dev 301 到正式域名（各仓库独立 PR，已合并）：space PR #33（merge 4534272c，部署 run 38067150017 全绿）、blog PR #7（部署 run 38066740389 全绿）、book PR #3（部署 run 38066771478 全绿）。线上核验：styrigx-space.pages.dev → 301 https://styrigx.com/（/settings/?x=1 保留 path+query）、styrigx-blog.pages.dev → 301 https://blog.styrigx.com/、styrigx-book.pages.dev → 301 https://book.styrigx.com/；三站首页正常（space 200 + owner-status 双 true；blog/book 未带 cookie 302 到锁屏，符合预期）。✓ 2026-10-11
- [ ] 2.7.0 语言 / G / 天气（styrigx-space，可合并）：语言跟随系统/中文/English；G 按 `build:false` 清单；天气定位顺序手动城市 > 精确定位（不自动弹权限）> IP 兜底。验收：CI 全绿 → 合并 → 生产部署 run 全绿 → 线上验证。
- [ ] 2.8.0 清理（styrigx-space，可合并）：原有内容（命名弹层 One UI 细节、rename 是否覆盖 `lastUsedAt`、提供方映射、最近使用显示、死代码），加上：①「锁定所有设备」session-epoch +1，走 L2 api，设置里给入口，文档注明 blog/book 受约 60 秒 epoch 缓存影响；② Turnstile 验证速度优化；③ 锁屏态首页 HTML 不再下发桌面内容（书单、歌单等），只下发锁屏需要的部分；④ 视觉回归重新生成基线，去掉 continue-on-error 改成阻塞；⑤ 死代码彻底删除：不需要的旧代码、冗余代码全部删除，不再用 build:false 留着。范围：legacy-lock-screen 旧版全屏锁屏的代码和它在 features.yaml 的条目；其他 build:false 且不再需要的功能；死代码；未引用的资源、partials 和脚本；重复实现。PR 描述列出完整删除清单和理由。只删代码和已失效的测试，仍有效的测试覆盖不动。验收同上。
- [ ] 3.0.0 应用商店重定义（styrigx-space，可合并）：商店=应用抽屉+安装管理，唯一应用入口；首页只留小组件卡片；Dock 固定我的文件/应用商店/浏览器/设置；版本只改 `data/version.yaml`（kernel: "3.0"，ui: "8.5"），不改 hugo.yaml。验收同上。

## 已完成

- 0a PR #9（fix/passkey-index-backfill，ce7d0705）：索引补建。生产 run 38001752282 全绿，owner-status 返回 `{"ok":true,"password":true,"passkey":true}`。
- 0b PR #7（fix/workflow-dispatch-deploy，8fb9c2ec）：workflow_dispatch 仅 main 可部署。生产 run 38002967275 全绿。
- 0b PR #6（test/p0-3-e2e-gaps，efdba95d）：UV=0 专属错误码 + E2E 断言 + 2.4.1 设计文档。生产 run 38004261614 全绿。
- 0c 每日巡检：`site_check.py` 与 cron 任务说明已加 302 规则（blog/book 302 到 `https://styrigx.com/?lock=1&return=...` 属正常）。
- 2.4.2 PR #11（feat/2.4.2-infra，977228e9）：Hugo 0.167 + Tailwind 4 完整迁移。PR CI run 38024130633 全绿，已合并。
- 2.5.0 PR #19（feat/2.5.0-layout-mode，ee1e452）：PR CI run 38031998021 全绿；生产 run 38033087511 全绿；Gray 15:35 亲自解锁验收，1920 四项通过。
- 改名 portal→space：space PR #21（57ae7911b539，生产 run 38038564454 全绿）、blog PR #6（72fc2f949d83）；book 无残留。
- 2.4.1 主站 PR #14（feat/2.4.1-portal-lock-v2，8059894d9fe0）：PR CI run 38039100092 全绿；生产 run 38039540912 全绿；线上内页锁屏已验证（未带 cookie 内页 200「已锁定」，owner-status password:true、passkey:true）。
- 2.4.1 收尾：space #27（19799d0，部署 run 38054846123）、space #28（aae2372，部署 run 38058893265）、blog #4（27d68ab，部署 run 38059530196）、book #2（2baa787，部署 run 38059746693）；预览项目已删除。
- 2.6.0 PR #31（feat/2.6.0-settings-v2，c120f443）：PR #20 关闭未合，在新目录结构上重做设置二级页 + 关于。生产 run 38065676001 全绿；后续 fix #34（904d1537，生产 run 38069096652 全绿）。线上冒烟通过。
- 三站 pages.dev 301：space PR #33（4534272c，生产 run 38067150017）、blog PR #7（生产 run 38066740389）、book PR #3（生产 run 38066771478）；线上三个 301 均生效（保留 path+query）。
