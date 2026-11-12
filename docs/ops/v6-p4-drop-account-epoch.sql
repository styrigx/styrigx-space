-- v6 P4 收尾：删账号库里的 account_epoch 表（旧账号会话的纪元表）。
--
-- 定稿 v5.6 §十一只写了「account_epoch 清行」，生产已于 2026-11-11 清空；drop 由 Gray 2026-11-12 15:59 定（按 Muse 建议：已空、没代码读）。
-- 随待批的生产 SQL 一起，Gray 批准后手动执行（不进 workers/account/migrations/，CI 不会自动跑）：
--   npx wrangler d1 execute styrigx-account --remote --file docs/ops/v6-p4-drop-account-epoch.sql
-- 执行前先在 dashboard 记下 D1 Time Travel 还原点。
--
-- 依据：
-- - Worker 代码 0 读写：`git grep -n "account_epoch" -- 'workers/*/src'` 只剩 lib/db.js 的注释。
-- - 建表位置：workers/account/migrations/0005_account_tables.sql:15（历史迁移，不改）。
--
-- 不可逆：表本身已空，删掉不丢数据。

DROP TABLE IF EXISTS account_epoch;
