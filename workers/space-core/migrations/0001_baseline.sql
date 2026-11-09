-- styrigx-space-core 的基线表结构（进站 v3 L2b，2026-11-09）：库 D1 styrigx-space-core，迁移记录表 d1_migrations_core（一套迁移、一个绑定 D1_SPACE）。
-- 等于旧库 styrigx-space-gateway 里网关（migrations-archive/gateway/0001–0009）和分享链接（migrations-archive/share/0001–0003）
-- 两套迁移跑完后的表结构，合成一份；只建表建索引，不放数据、不删数据（存量行由 .github/workflows/d1-cutover.yml 从旧库原样搬来，表名不变）。
-- 监测（status_*）不在这里：它有自己的库 styrigx-status（workers/status/migrations/0001_baseline.sql）。
-- 全部 IF NOT EXISTS：预览库 styrigx-test-preview 里这些表早就在（旧迁移建的），在那里跑本文件是空操作。
-- 网关段与 src/core/d1-state.js 的 SCHEMA（代码兜底建表）逐条一致、lock_reset_switch 与 src/core/lock-reset-switch.js 的 CREATE_SQL 一致（d1-state.test.mjs 核对）。

-- ---- 进站（D1_SPACE；每张表有 realm 列，网关只读写 realm = 'lock' 的行）----

-- 纪元：只用 UPDATE ... SET value = value + 1 推进（原子）。
CREATE TABLE IF NOT EXISTS epoch (realm TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- 通行密钥：record = 记录的 JSON（name、provider、aaguid、createdAt、lastUsedAt、credId、publicKey、signCount、uv）。
CREATE TABLE IF NOT EXISTS passkey (realm TEXT NOT NULL, credential_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (realm, credential_id));

-- 解锁密码：record = 记录的 JSON（salt、hash、iterations、peppered、updatedAt）。
CREATE TABLE IF NOT EXISTS password (realm TEXT PRIMARY KEY, record TEXT NOT NULL);

-- KV → D1 一次性导入标记（2026-10-27 的 migrate-kv-to-d1.mjs 写，运行时不读；L3 随旧表一起删）。
CREATE TABLE IF NOT EXISTS kv_migration (name TEXT PRIMARY KEY, migrated_at INTEGER NOT NULL);

-- WebAuthn user handle（逐字节照搬，红线）；legacy_handle 是账号拆分 PR2 加的列（旧 0007），网关不读写。
CREATE TABLE IF NOT EXISTS user_handle (realm TEXT PRIMARY KEY, handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '');

-- 一次性 challenge：只经 DELETE ... RETURNING 消费。
CREATE TABLE IF NOT EXISTS challenge (realm TEXT NOT NULL, id TEXT NOT NULL, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id));

-- 输错限速（单 IP 行 + 全局行 bucket = '*'；AI 全站总闸 realm = 'ai'）。
CREATE TABLE IF NOT EXISTS attempt_limit (realm TEXT NOT NULL, kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, kind, bucket));

-- 临时钥匙（code_hash = SHA-256(pepper|码)；分享链接的钥匙 link = 1、code_hash 为 NULL）。
CREATE TABLE IF NOT EXISTS tempkey (realm TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', code_hash TEXT, link INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id));
CREATE UNIQUE INDEX IF NOT EXISTS tempkey_code ON tempkey (realm, code_hash);

-- 设备（网关从没写过；为了和旧库表一一对应先保留，L3 删）。
CREATE TABLE IF NOT EXISTS device (realm TEXT NOT NULL, device_id TEXT NOT NULL, record TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (realm, device_id));

-- 审计（只追加，保留 7 天）。
CREATE TABLE IF NOT EXISTS audit (realm TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, decoy INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL, PRIMARY KEY (realm, id));
CREATE INDEX IF NOT EXISTS audit_ts ON audit (realm, ts);

-- 恢复开关（Sloan 在后台控制台手动插行；见 src/core/lock-reset-switch.js）。
CREATE TABLE IF NOT EXISTS lock_reset_switch (hash TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);

-- ---- 分享链接（原 styrigx-share，进站 v3 L2 并入；同一个绑定 D1_SPACE）----

-- share_link：一条短链一行。code = /s/<码> 里的 22 位码；session_sec = 0 普通短链，> 0 带临时会话（key_id = 分享链接钥匙 id，在 tempkey 表）；
--   revoked_at 非空 = 已作废；opens / last_open_at = 被打开的次数和最近一次。过期 / 作废 7 天后在列表接口里顺手删掉。
CREATE TABLE IF NOT EXISTS share_link (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '/', session_sec INTEGER NOT NULL DEFAULT 0, key_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, opens INTEGER NOT NULL DEFAULT 0, last_open_at INTEGER);
CREATE INDEX IF NOT EXISTS share_link_created ON share_link (created_at);

-- share_fail：/s/<码> 打不开的计数（按 IP；10 次锁 15 分钟）。
CREATE TABLE IF NOT EXISTS share_fail (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
