# styrigx-atlas-core

Atlas：内容层的接口 Worker。命名：带 `-core` 的是两层核心，`styrigx-space-core`（平台底座）和 `styrigx-atlas-core`（内容层）一对；不带 `-core` 的是 Pages 和单独设计的独立 Worker（ai、account 等）。2026-11-14 起把奇趣（原 `styrigx-curio-core`）和日刻（原 `styrigx-daymark-core`）合成一个 Worker、一个 D1、一个 R2；前端不动，公开路径 `/curio/api/*`、`/daymark/api/*` 不变。

## 现在在哪一步

**状态**：2026-11-14 切换完成：本 Worker 挂 `styrigx.com/curio/api/*`、`styrigx.com/daymark/api/*`，由 CI 的 `deploy-atlas-core` 部署；status 经 `JOB_ATLAS` 调每小时任务，ai 的 `CURIO` 指本 Worker。旧 `styrigx-curio-core`、`styrigx-daymark-core` 及其 D1 / R2 已下线，仓库里的旧目录也已删除（2026-11-14 合并进 atlas-core）。
所有响应带 `X-Atlas-Runtime: worker`（产品头 `X-Curio-Runtime` / `X-Daymark-Runtime` 照旧保留）。

## 入口

```
src/index.js           部署入口：只接线（default、CurioReader、DaymarkReader、HourlyJob）
src/app.js             按公开地址前缀分流：/curio/api/*、/music/api/* → curio/app.js，/daymark/api/* → daymark/index.js，其他 404；runHourly 先奇趣后日刻
src/rpc/daymark-reader.js DaymarkReader：给 styrigx-ai 的今日一句（R-35）
src/rpc/hourly-job.js  HourlyJob：给 styrigx-status（JOB_ATLAS）
src/curio/             奇趣：app.js、routes.js（访问表）、api/、search-index.js、photo-sweep.js、reader.js；CurioReader 在 curio/rpc/reader.js
src/music/routes.js    音乐（/music/api/*，music 搬家第 2 步加、第 4 步起唯一；旧 /curio/api/music* 已删）的路由表与访问表；handler 仍在 src/curio/api/music*.js，由 curio/app.js 按前缀选表
src/daymark/           日刻：index.js、routes.js（访问表）、api/、search-index.js、rpc/hourly-job.js
src/common/visibility.js 公用（组权限 v1.1，ADR-0007）：visibility(context) → { showPrivate, canManage }（分别问 action private / manage）、filterPrivate、privateNotFound；奇趣、日刻、音乐的公开读都只经它
```

访问档、守卫、路由表都在 `src/curio/`、`src/music/`、`src/daymark/` 各自目录里，本 Worker 不另加。单测：`tests/workers/atlas-core/`（`core.test.mjs` 分流 / 迁移 / 配置，`curio*.test.mjs`、`daymark*.test.mjs` 两边业务）。

## 绑定

绑定名沿用旧两个 Worker 的（业务代码按这些名字取）：
- D1 `styrigx-atlas-core`：`D1_FINDS`、`D1_DEVICES`、`D1_GAMES`、`D1_MOVIES`、`D1_MUSIC`（奇趣）、`D1_QUOTES`（日刻），同一个库。
- R2 `styrigx-atlas-core`：`R2_PHOTOS`、`R2_MUSIC`，同一个桶；对象键和旧桶一样（icons/、imports/、photos/、music/…）。
- 服务绑定 `SPACE` → `styrigx-space-core` 的 `SpaceVerifier`。
- KV `KV_SEARCH_INDEX`（`styrigx-space-core` 那份全站搜索索引；奇趣写 `site:curio`、日刻写 `site:daymark`）。
- 无 Cron（每小时由 status 调 HourlyJob）。

## 数据与迁移

`migrations/` 重新起头：`0001_curio.sql` = 奇趣旧迁移 0001+0003+0004+0005 跑完的结构，`0002_daymark.sql` = 日刻旧迁移（不含 0003 种子句子）跑完的结构；只有结构，数据 2026-11-14 从旧库拷入。之后的结构变更接着编号，已上线的文件不改名、不重新编号。旧两个目录（含种子迁移）已随旧 Worker 下线删除。
