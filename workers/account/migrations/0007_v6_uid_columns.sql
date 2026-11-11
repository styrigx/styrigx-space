-- 2026-11-11 v6 身份统一 P2：头像以外的三张数据表加 uid（头像在 KV，按键前缀分，不用迁移）。D1 styrigx-account。
--
-- 2026-11-11 Gray 批准生产执行（条件：执行前记下 styrigx-account / styrigx-space-core 的 D1 Time Travel 时间点；
-- 凭据 SQL 人工审过再执行；迁移后 Gray 用手机上的旧通行密钥试 su styrigx / su root）。本文件从 migrations-pending/ 挪进 migrations/
-- （文件名不变），合并后由账号部署 job 的 `d1 migrations apply styrigx-account --remote` 执行；预览库由 main 上的 CI 跑。
-- 代码不用跟着改：lib/uid-schema.js 发现有了 uid 列（最多 60 秒）就自动按 uid 读写。
-- 迁移前代码照样能跑：没有 uid 列时这些表里的数据全当作 styrigx 的，只有 styrigx 能读写（别的 uid 读到空、写被拒 / 丢弃）。
--
-- 迁移对照（定稿 v4 §十一）：现有数据全部归 styrigx（uid 1000）。
-- settings_sync / wb_daily 的主键要带上 uid，SQLite 改不了主键，所以「新表 → 复制 → 删旧表 → 改名」；account_device 只加一列。
-- 数据量很小（settings_sync ≤ 160 行、wb_daily ≤ 35 天 × 十几个区域），一次跑完。

-- 设置云同步：主键 (uid, k)
CREATE TABLE settings_sync_v6 (
  uid INTEGER NOT NULL DEFAULT 1000,
  k TEXT NOT NULL,
  v TEXT,
  t INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, k)
);
INSERT INTO settings_sync_v6 (uid, k, v, t, updated_at) SELECT 1000, k, v, t, updated_at FROM settings_sync;
DROP TABLE settings_sync;
ALTER TABLE settings_sync_v6 RENAME TO settings_sync;

-- 数字健康：主键 (uid, day, k)
CREATE TABLE wb_daily_v6 (
  uid INTEGER NOT NULL DEFAULT 1000,
  day TEXT NOT NULL,
  k TEXT NOT NULL,
  t TEXT NOT NULL DEFAULT '',
  sec INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, day, k)
);
INSERT INTO wb_daily_v6 (uid, day, k, t, sec) SELECT 1000, day, k, t, sec FROM wb_daily;
DROP TABLE wb_daily;
ALTER TABLE wb_daily_v6 RENAME TO wb_daily;

-- 旧账号设备（account_device，v5 账号会话的设备记录）：归 styrigx。v6 的「设备」= account_sessions（本来就有 uid）。
ALTER TABLE account_device ADD COLUMN uid INTEGER NOT NULL DEFAULT 1000;
