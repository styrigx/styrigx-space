-- 账号拆分方案 9.4：恢复开关表统一为 lock_reset_switch（模块和旧 KV 键早已叫 lock-reset-switch），列同 0001_recovery_switch.sql。
-- 编号：网关 0007 已被 user_handle legacy_handle 占用，本迁移顺延为 0008。
-- 网关代码（functions/_kernel/lock-reset-switch.js）只读写 lock_reset_switch，CREATE_SQL 与这里的建表语句相同（单测核对）。
-- 预览（styrigx-test-preview）：CI「Apply D1 migrations to preview」跑本文件。
-- 正式库 styrigx-auth-gateway：部署 job 不跑 d1 migrations apply，同一段 SQL 由 scripts/migrate-account-auth.mjs 执行
-- （--lock-reset-switch 拷行，部署新代码之前跑；SWITCH_CREATE / SWITCH_COPY 与这里逐条一致，单测核对）。
-- 旧表 recovery_switch 留到 PR4：scripts/migrate-account-auth.mjs --cleanup --confirm DROP。
CREATE TABLE IF NOT EXISTS lock_reset_switch (
  hash TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO lock_reset_switch (hash, first_seen, used)
  SELECT hash, first_seen, used FROM recovery_switch;
