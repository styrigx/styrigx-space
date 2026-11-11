-- v6 P4（定稿 v6-identity-final.md v5.3 §十三 P4 行）：分享短链删除后，删 space-core 库里的两张分享表。
--
-- 需 Gray 批准后手动执行（不进 workers/space-core/migrations/，CI 不会自动跑）：
--   npx wrangler d1 execute styrigx-space-core --remote --file docs/ops/v6-p4-drop-share.sql
-- 执行前先跑只读核对 docs/ops/v6-p4-predeploy-check.sql，看还有几条有效分享链接。
--
-- 依据：
-- - 本 PR 起 Worker 代码 0 读写：`git grep -n "share_link\|share_fail" -- 'workers/*/src' space/web/assets` 0 命中；
--   余下命中只在注释、迁移历史（0001/0002）和迁移测试里。
-- - 建表位置：workers/space-core/migrations/0001_baseline.sql:49（share_link）、:50（索引 share_link_created）、:53（share_fail）。
-- - deploy.yml 的部署后表核对已不再要求 share_link / share_fail（同 PR）。
--
-- 不可逆：表里的分享链接记录（码、目标、打开次数）一并删掉。DROP INDEX 随表一起删，单列出来只为写明。

DROP INDEX IF EXISTS share_link_created;
DROP TABLE IF EXISTS share_link;
DROP TABLE IF EXISTS share_fail;
