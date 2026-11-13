# ADR-0001：子站并入一个仓库、一个 Hugo 站

| 项 | 值 |
|---|---|
| 状态 | 已采纳（已实施） |
| 日期 | 2026-11-08（最终一步 #310 合并，Asia/Shanghai） |
| 决策者 | Sloan Gray |
| 取代 | `docs/repo-split-task.md`（2026-11-06 分包任务书） |

## 1. 背景

1.1 早期每个站点一个仓库、一个子域名：主站 `styrigx.com`（styrigx-space）、博客 `blog.styrigx.com`、书库 `book.styrigx.com`，以及后来的图志仓库 styrigx-atlas（`atlas.styrigx.com`，承载奇趣与日刻）。每站各有 Pages 项目、各自同步一份共享外壳（`sync-shell.mjs` + `sgx-shell.lock.json`）。

1.2 问题：
- 锁屏要跨子域共享会话，需要 `Domain=.styrigx.com` cookie、公钥分发与跨站回跳，路径多、出错面大；
- 外壳副本经常不同步，改一处要发四个 PR；
- 四次构建、四套 CI、四份依赖升级。

## 2. 决定

2.1 **一个仓库**：子站代码全部并入 styrigx-space；styrigx-atlas 等旧仓库归档。

2.2 **一个域名、按路径分站**：子站在 `styrigx.com/blog/`、`/curio/`、`/daymark/`，由站点核心按路径前缀走子站关口；子站接口挂 `styrigx.com/<站>/api/*`。旧子域名与 `atlas.styrigx.com` 下线。

2.3 **一个 Hugo 站**：`space/web/` 一份 `hugo.yaml`，一次构建出四站，产物 `space/web/public/` 由一个 Pages 项目 `styrigx-space` 发布。子站内容按站分目录（`content|layouts|assets|static|data/<站>/`）。

2.4 **共享外壳不复制**：子站直接使用主站的 partial 与 JS；`gen-common.mjs` 只生成派生文件并在 CI `--check`。

2.5 **共用脚本归 `space/scripts/`**（2026-11-05 拥有者选 B 方案）：根目录不留 `scripts/`，子站自己的脚本在 `space/scripts/<站>/`。

2.6 主站专用的检查（CSP 内联哈希、技术名词检查、内联脚本计数）排除 `/blog/`、`/curio/`、`/daymark/`。

## 3. 实施记录

| 日期 | 变更 |
|---|---|
| 2026-10-21 | 书库子站 `book.styrigx.com` 下线（#156） |
| 2026-11-02 | 子站并入图志 `atlas.styrigx.com`，网关与主站引用一次改完（#252） |
| 2026-11-02 起 | 合并 PR1：图志站点与两个接口 Worker 搬入本仓库；PR2：四站各自构建后拼成一棵树 |
| 2026-11-03 | 合并 PR3（533d8bd）：网关按 `styrigx.com/<站>/` 前缀分发，图志 301，接口 Worker 挂主域名 |
| 2026-11-06 | 根目录分 `space/`（主站 + 基建）与 `atlas/`（子站）两包（#282）；删除 `atlas.styrigx.com` 跳转（#285） |
| 2026-11-08 | 主站与三子站合成一个 Hugo 站，`atlas/`、`assemble.mjs`、`dist/site/`、各站 `sync-shell.mjs` 删除（#310） |
| 2026-11-09 | docs 整理：`STRUCTURE.md` 并入 `docs/architecture/repo-structure.md`，`renovate.json` 移入 `.github/` |

## 4. 后果

4.1 正面：子站与主站同源，进站会话只需一个 cookie；四站一次构建、一次部署、一套 CI；外壳只有一份。

4.2 负面：单个构建失败会挡住所有站点；Hugo 模板需要守卫子站中文地址（`/<站>/zh/…` 由 front matter `url` 给出，写错即构建失败）。

4.3 旧布局换算（读旧提交时用）：`web/atlas/` → `space/web/`；`web/<站>/`、`atlas/web/<站>/` → `space/web/` 下 `<目录>/<站>/`；`scripts/<站>/`、`atlas/scripts/<站>/` → `space/scripts/<站>/`。
