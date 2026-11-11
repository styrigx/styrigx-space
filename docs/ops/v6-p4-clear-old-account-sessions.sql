-- v6 P4（定稿 v6-identity-final.md v5.3 §十三 P4 行）：旧账号会话删除后，清账号库里只给旧会话用的纪元行。
--
-- 需 Gray 批准后手动执行（不进 workers/account/migrations/，CI 不会自动跑）：
--   npx wrangler d1 execute styrigx-account --remote --file docs/ops/v6-p4-clear-old-account-sessions.sql
--
-- 只清 account_epoch（两行 session / reset，管旧 session / reauth / reset 票）：
-- - 读写它的只有 workers/account/src/lib/db.js:136（readEpoch）和 :155（bumpEpoch），两者在 workers/ space/ tests/ 里都无调用方。
-- - 只清行、不删表：workers/account/src/lib/db.js:30 的表结构清单和 tests/workers/account/_d1.mjs:24 还列着它，
--   删表定稿没点名，不在本 PR 范围。
--
-- 不清（仍在用）：
-- - account_device：workers/account/src/core/devices.js:146,158,188,201,217,229（/api/account/devices 的已吊销判断与保留期清理）。
-- - account_audit：workers/account/src/core/audit.js:59,61（账号审计写入与 30 天清理）。
-- - account_challenge：workers/account/src/lib/webauthn.js:281,283,300（通行密钥 challenge，v6 登录同样在用）。

DELETE FROM account_epoch;
