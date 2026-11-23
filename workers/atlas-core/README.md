# styrigx-atlas-core

Atlas：内容层的接口 Worker。命名：带 `-core` 的是两层核心，`styrigx-space-core`（平台底座）和 `styrigx-atlas-core`（内容层）一对；不带 `-core` 的是 Pages 和单独设计的独立 Worker（ai、account 等）。2026-11-14 起把奇趣（原 `styrigx-curio-core`）和日刻（原 `styrigx-daymark-core`）合成一个 Worker、一个 D1、一个 R2；前端不动，公开路径 `/curio/api/*`、`/daymark/api/*` 不变。

## 现在在哪一步

**状态**：2026-11-14 切换完成：本 Worker 挂 `styrigx.com/curio/api/*`、`styrigx.com/daymark/api/*`，由 CI 的 `deploy-atlas-core` 部署；status 经 `JOB_ATLAS` 调每小时任务，ai 的 `CURIO` 指本 Worker。旧 `styrigx-curio-core`、`styrigx-daymark-core` 及其 D1 / R2 已下线，仓库里的旧目录也已删除（2026-11-14 合并进 atlas-core）。
所有响应带 `X-Atlas-Runtime: worker`（产品头 `X-Curio-Runtime` / `X-Daymark-Runtime` 照旧保留）。

## 入口

```
src/index.js           部署入口：只接线（default、CurioReader、DaymarkReader、HourlyJob）
src/app.js             按公开地址前缀分流：/curio/api/*、/music/api/*、/games/api/* → curio/app.js，/daymark/api/* → daymark/index.js，其他 404；runHourly 先奇趣后日刻
src/rpc/daymark-reader.js DaymarkReader：给 styrigx-ai 的今日一句（R-35）
src/rpc/hourly-job.js  HourlyJob：给 styrigx-status（JOB_ATLAS）
src/curio/             奇趣：app.js、routes.js（访问表）、api/、search-index.js、photo-sweep.js、reader.js；CurioReader 在 curio/rpc/reader.js
src/music/janitor.js   音乐空记录清理（Janitor）：清扫时段（UTC 19 点）随每小时任务跑；开关 MUSIC_JANITOR（不设 = report 只报不删，singles 只删空单曲，all 空单曲 + 空专辑连封面），见下「音乐空记录清理」
src/music/routes.js    音乐（/music/api/*，music 搬家第 2 步加、第 4 步起唯一；旧 /curio/api/music* 已删）的路由表与访问表；handler 仍在 src/curio/api/music*.js，由 curio/app.js 按前缀选表
src/games/routes.js    游戏（/games/api/*，奇趣重组设计稿 v1.0 PR 1）的路由表与访问表（product games）；handler 在 src/games/api/（games.js、cover.js），复用 src/curio/api/_items.js、_items-post.js、_photo.js，由 curio/app.js 按前缀选表
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

## 音乐空记录清理（Janitor）

上传窗「放弃剩下的」留下的空单曲 / 空专辑不当场删（可复用），由 `src/music/janitor.js` 每天清扫时段（UTC 19 点 = 北京 03 点，与照片清扫同一轮）统一处理。

- **空记录**：`music_albums` 一行，0 首曲目；`created_at > 0`，且 `created_at`、`updated_at` 都早于 24 小时；没有未过期的播放令牌。`created_at = 0`（年龄不明）只报不删。
- **开关** `MUSIC_JANITOR`（Worker 变量，`wrangler.toml` 不写）：只认三个值：不设或写错 = `report`，只打一行日志（数量 + id），不删任何东西；`singles` 只删空单曲（空专辑只报）；`all` 空单曲 + 空专辑都删，连各自的 R2 封面（Gray 2026-11-22 定空专辑也删；专辑删空原本是故意保留的，所以仍要显式开 `all`）。
- **删的时候**：每条一个 `db.batch`，DELETE 里再核一遍上面的条件（扫完之后有人传了歌 / 换了封面 / 在听就删 0 行、跳过）；连带删它的过期令牌；D1 提交后才删 R2 封面（要在 `music/` 下、没有别的记录或歌手头像引用）；每轮最多 20 条（单曲、专辑合计），多的下一轮。
- **只报不删**：`report` 下的全部空记录、`singles` 下的空专辑；建了 24 小时以上、音频不在 R2 的曲目（`r2_key` 空或 `music/` 下列不到），日志里报数量和曲目 id。
- D1 读不到整轮不删；R2 列不到只是缺音频那项报不出来。单测 `tests/workers/atlas-core/music-janitor.test.mjs`。
