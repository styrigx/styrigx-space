-- 部署绿后执行。
-- v6 P4-2：数字健康整套删除（定稿 v6-identity-final.md v5.5 §四「数字健康整套删除（上报、接口、展示、数据表；删表 SQL 随删除 PR 写成文件，部署绿后执行）」、
-- §十一「数字健康数据表删除：drop SQL 写成文件」、§十一末条「生产 SQL 在对应 PR 部署变绿后由 Hark 执行」；Gray 2026-11-11 18:26、19:59、20:15）。
--
-- 部署绿后执行：等本 PR 那次账号 Worker 部署（deploy-account-worker）变绿之后再执行；不进 workers/account/migrations/，CI 不会自动跑。
-- 执行前确认 D1 Time Travel 时间点：
--   npx wrangler d1 execute styrigx-account --remote --file docs/ops/v6-p4-drop-wellbeing.sql
--
-- wb_daily（uid, day, k, t, sec；0007 起主键 (uid, day, k)，没有单独的索引）：
-- - 读写它的只有 workers/account/src/api/wellbeing.js（POST / GET /api/wellbeing），本 PR 连同路由表、ROUTE_ACCESS、PUBLIC_API、网关访问表与转发表一起删除；
--   删后 workers/ space/ 的运行代码里没有任何 SELECT / INSERT / UPDATE / DELETE wb_daily，也没有兜底建表（建表兜底在已删的 api/wellbeing.js 里）。
-- - 仍提到表名的只有历史迁移 workers/account/migrations/0001_wellbeing.sql、0003_account_auth.sql（注释）、0007_v6_uid_columns.sql（不改；
--   已在正式 / 预览库跑过，wrangler 只跑没记录的迁移，不会再建）。
-- - wb_daily_v6 是 0007 的中间表（已改名回 wb_daily），一并 IF EXISTS 兜底。
DROP TABLE IF EXISTS wb_daily;
DROP TABLE IF EXISTS wb_daily_v6;
