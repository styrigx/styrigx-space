# docs/ 入口索引

> 状态：现行 ｜ 最后更新：2026-11-06

本目录放设计文档、任务书、子站文档和截图。仓库整体结构见根目录 [`STRUCTURE.md`](../STRUCTURE.md)（2026-11 合站起主站和三个子站是 `space/web/` 一个 Hugo 站；含旧布局 `atlas/`、`dist/site/` 的换算说明）。

状态说明：**现行** = 和现在的代码一致，改代码时顺手改文档；**历史** = 当时的记录，正文保持原样、不再更新、不代表现状，只留作查来龙去脉。每份文档开头都有「状态 ｜ 最后更新」一行。

## 现行

| 文档 | 用途 |
|---|---|
| [`architecture.md`](architecture.md) | 分层规范：前端 lib ← auth ← shell ← apps ← entries 的依赖方向、Worker 边界（`space/scripts/check-layers.mjs` 检查的规则出处） |
| [`auth-state-machine.md`](auth-state-machine.md) | 四站锁屏 / 解锁 / 回跳 / 复验 / 账号页的状态机：唯一状态源是网关验签过的 cookie |
| [`status-apis.md`](status-apis.md) | 六个只读状态接口的分工表：谁回答、鉴权要求、返回口径、调用方 |
| [`ui-cookie-contract.md`](ui-cookie-contract.md) | 外观 cookie `sgx-ui` 契约：主站写、三个子站只读，字段 / 版本 / 夹具 / 改格式的步骤 |
| [`palette-usage.md`](palette-usage.md) | 七色调色板怎么用：色彩角色 token、数据源、生成与校验 |
| [`repo-split-task.md`](repo-split-task.md) | 仓库分包任务书（2026-11-06，历史）：根目录分 `space/`（主站）/ `atlas/`（子站）两包、docs 整理、版本徽章；2026-11 合站后 `atlas/` 已并进 `space/web/` |
| [`blog/content-series.md`](blog/content-series.md) | 博客：文章系列（series）的 frontmatter 写法 |
| [`blog/sgx-ui-cookie.md`](blog/sgx-ui-cookie.md) | 博客：`sgx-ui` cookie 读端（博客这一侧，契约以主站为准） |
| [`curio/STRUCTURE.md`](curio/STRUCTURE.md) | 奇趣子站结构（合站前的站内相对路径：`web/…` 现在在 `space/web/` 的 `<目录>/curio/` 下） |
| [`daymark/STRUCTURE.md`](daymark/STRUCTURE.md) | 日刻子站结构（合站前的站内相对路径：`web/…` 现在在 `space/web/` 的 `<目录>/daymark/` 下） |
| [`screenshots/`](screenshots/) | 根 README 用的截图（中英各三张：首页手机 / 首页 DeX / 设置手机） |

## 历史

| 文档 | 用途 |
|---|---|
| [`2.4.1-three-site-lock-design.md`](2.4.1-three-site-lock-design.md) | 2.4.1 三站真实锁屏方案（2026-10-29 起作废）；现行规则见 `architecture.md`、`auth-state-machine.md` |
| [`styrigx-3.0-task.md`](styrigx-3.0-task.md) | Styrigx 3.0 任务书（2026-10-10 当时的规则，2026-10-29 起不再现行）；现行规则同上 |

历史文档留在原位只做标记，不删、不改正文（路径随仓库分包更新的除外）；以后整篇过时又不便原位保留的，移到 `docs/archive/`。
