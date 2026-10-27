-- 设置云同步（/api/prefs）：一项设置一行，逐项「新的赢」。D1 styrigx-account（账号 Worker styrigx-account，绑定 D1_SETTINGS_SYNC）。
-- 2026-10-28 从 KV styrigx-account 的 account-prefs（{ items, updatedAt }）搬来；旧值用 scripts/migrate-prefs-kv-to-d1.mjs 一次性导入。
--   k          localStorage 键（只收 sgx- 开头，见 src/api/prefs.js KEY_RE）
--   v          值；NULL = 这一项被恢复默认（本地删了 key）
--   t          客户端改动时间（毫秒）：写入用 UPSERT ... WHERE excluded.t > settings_sync.t，旧设备的旧值原子地写不进来
--   updated_at 服务器写入时间（毫秒）；接口返回的 updatedAt = MAX(updated_at)
-- 代码里遇到 "no such table" 会自己补建（同一条 CREATE TABLE IF NOT EXISTS），此 migration 用于 wrangler d1 migrations apply。
CREATE TABLE IF NOT EXISTS settings_sync (
  k TEXT NOT NULL PRIMARY KEY,
  v TEXT,
  t INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
