-- 2.11 恢复开关：记录开关值的 hash、首次见到时间、是否已用。
-- 代码里也有 CREATE TABLE IF NOT EXISTS 兜底，此 migration 用于 wrangler d1 migrations apply。
CREATE TABLE IF NOT EXISTS recovery_switch (
  hash TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
