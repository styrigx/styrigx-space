-- 2026-10-29 账号拆分 PR2：user_handle 增加 legacy_handle 列（预览共库兼容；Sloan 确认）。
-- 为什么在网关这边加：预览里网关和账号共用一个测试库 styrigx-test-preview，CI「Apply D1 migrations to preview」先跑网关迁移（本目录），
-- 再跑账号的 workers/account/migrations/0003_account_auth.sql。0003 的 CREATE TABLE IF NOT EXISTS user_handle 遇到网关 0006 建好的表会跳过，
-- 账号代码要读的 legacy_handle 列就没有；这里先补上，0003 跳过后列已存在。正式账号库（styrigx-account）由 0003 自带此列，不经这里。
-- 网关代码不读写此列（它的 INSERT 只写 realm、handle，新列取默认 ''）；正式网关库加了这一列行为不变。
-- scripts/migrate-account-auth.mjs apply 时的 ALTER 补列保留为防御：列已存在就跳过。
-- 只能跑一次（SQLite 没有 ADD COLUMN IF NOT EXISTS）；wrangler d1 migrations apply 按 d1_migrations 记录只跑一次。
ALTER TABLE user_handle ADD COLUMN legacy_handle TEXT NOT NULL DEFAULT '';
