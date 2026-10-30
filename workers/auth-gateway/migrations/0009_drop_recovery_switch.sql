-- 账号拆分 PR4（方案 9.4）：删旧恢复开关表 recovery_switch。网关代码只读写 lock_reset_switch（0008 已把旧表的行拷过去）。
-- 预览（styrigx-test-preview）：CI「Apply D1 migrations to preview」按编号先跑 0008（拷行）再跑本文件。
-- 正式库 styrigx-auth-gateway：部署 job 不跑 d1 migrations apply；旧表已由 scripts/migrate-account-auth.mjs --cleanup --confirm DROP，
-- 本文件只为预览库走迁移。
DROP TABLE IF EXISTS recovery_switch;
