-- v6 P4 收尾：space-core 旧进站 8 张表（定稿 v6-identity-final.md v5.4 §十一；Gray 2026-11-11 19:52「12既然没用就删干净」、20:11 批准连同两个一次性迁移脚本一起删）。
--
-- 部署绿后执行：等删掉这些表的建表语句的那次 space-core 部署（deploy-space-core）变绿之后再执行；不进 workers/space-core/migrations/，CI 不会自动跑。
-- 执行须 Gray 批准，执行前确认 D1 Time Travel 时间点：
--   npx wrangler d1 execute styrigx-space-core --remote --file docs/ops/v6-p4-drop-space-legacy.sql
--
-- 依据（本 PR 起）：
-- - workers/space-core/src/core/d1-state.js SCHEMA（兜底建表）只剩 attempt_limit、audit（含索引 audit_ts）；sweepExpired 白名单只剩 attempt_limit|audit；
--   部署后兜底建表不会把下面的表建回来。
-- - 一次性迁移脚本 space/scripts/v6-identity-migrate.mjs、space/scripts/migrate-kv-to-d1.mjs 已删（Gray 20:11）；
--   space/scripts/kv-budget.mjs RESET_D1_TABLES 去掉 passkey、password（只清预览库的 attempt_limit 与 account_* 表）。
-- - 全仓 workers/*/src、space/scripts、space/web/assets、.github 对这 8 张表名 0 读写；只剩历史迁移
--   workers/space-core/migrations/0001_baseline.sql 与 migrations-archive/ 的建表 / 搬数据语句（历史记录，不改）。
-- - 8 张表都只有主键，没有单独的索引（audit_ts 属于 audit，不动）。
-- 不动：attempt_limit（AI 全站总闸）、audit（/api/space-audit）；share_link / share_fail 见 docs/ops/v6-p4-drop-share.sql。
DROP TABLE IF EXISTS epoch;
DROP TABLE IF EXISTS passkey;
DROP TABLE IF EXISTS password;
DROP TABLE IF EXISTS user_handle;
DROP TABLE IF EXISTS challenge;
DROP TABLE IF EXISTS device;
DROP TABLE IF EXISTS kv_migration;
DROP TABLE IF EXISTS lock_reset_switch;
