# styrigx-atlas-core

Atlas：内容层的接口 Worker。命名：带 `-core` 的是两层核心，`styrigx-space-core`（平台底座）和 `styrigx-atlas-core`（内容层）一对；不带 `-core` 的是 Pages 和单独设计的独立 Worker（ai、account 等）。2026-11-14 起把奇趣（原 `styrigx-curio-core`）和日刻（原 `styrigx-daymark-core`）合成一个 Worker、一个 D1、一个 R2；前端不动，公开路径 `/curio/api/*`、`/daymark/api/*` 不变。

## 现在在哪一步

**PR1：只有代码，不部署、不挂路由。** 线上仍由 `styrigx-curio-core`、`styrigx-daymark-core` 服务。后续（每个生产动作先经 Gray 点头）：
（已建 D1 / R2 `styrigx-atlas-core`，2026-11-14）→ 拷数据（逐表核行数、对象数）→ 部署不挂路由冒烟 → 切换（短暂只读、补拷增量、路由与 status / ai 的服务绑定改指 Atlas、CI 换 deploy-atlas）→ 观察 → 报清单下线旧 Worker / D1 / R2 和 `workers/curio-core`、`workers/daymark-core`。

## 入口

```
src/index.js           部署入口：只接线（default、CurioReader、HourlyJob）
src/app.js             按公开地址前缀分流：/curio/api/* → curio/app.js，/daymark/api/* → daymark/index.js，其他 404；runHourly 先奇趣后日刻
src/rpc/hourly-job.js  HourlyJob：给 styrigx-status（切换后 JOB_CURIO / JOB_DAYMARK 合成一条）
src/curio/             奇趣，workers/curio-core/src 原样平移（不含它的 index.js、rpc/hourly-job.js，由上面接手）；CurioReader 在 curio/rpc/reader.js
src/daymark/           日刻，workers/daymark-core/src 原样平移
```

旧两个 Worker 下线前，`src/curio/`、`src/daymark/` 必须和旧目录逐字一致（`tests/workers/atlas-core-core/core.test.mjs`）：改奇趣 / 日刻业务代码时两边一起改。访问档、守卫、路由表都在各自目录里，本 Worker 不另加。

## 绑定

绑定名和旧两个 Worker 一字不差，业务代码不改：
- D1 `styrigx-atlas-core`：`D1_FINDS`、`D1_DEVICES`、`D1_GAMES`、`D1_MOVIES`、`D1_MUSIC`（奇趣）、`D1_QUOTES`（日刻），同一个库。
- R2 `styrigx-atlas-core`：`R2_PHOTOS`、`R2_MUSIC`，同一个桶；对象键和旧桶一样（icons/、imports/、photos/、music/…）。
- 服务绑定 `SPACE` → `styrigx-space-core` 的 `SpaceVerifier`。
- KV `KV_SEARCH_INDEX`（同旧两个 Worker；奇趣写 `site:curio`、日刻写 `site:daymark`）。
- 无 Cron（每小时由 status 调 HourlyJob）。

## 数据与迁移

`migrations/` 重新起头：`0001_curio.sql` = 奇趣旧迁移 0001+0003+0004+0005 跑完的结构，`0002_daymark.sql` = 日刻旧迁移（不含 0003 种子句子）跑完的结构；只有结构，数据从旧库拷。之后的结构变更接着编号，已上线的文件不改名、不重新编号。旧两个目录的迁移留到旧库下线。
