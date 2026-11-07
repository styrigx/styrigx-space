-- styrigx-status 用量快照（2026-10-22 PR3）。只有一行（id = 1）：最近一次成功的 Cloudflare 用量快照 + 最近一次尝试的结果。
-- 每小时 41 分由 Cron 写（src/usage.js runUsage）；/summary 读它给状态页「用量」卡片。时间一律毫秒时间戳（UTC）。
CREATE TABLE IF NOT EXISTS usage (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at      INTEGER,        -- 最近一次成功收集的时间；从没成功过是 NULL
  data            TEXT,           -- 快照 JSON：{ fetched_at, workers, d1, r2, kv, errors }（字段见 src/usage.js collectUsage）
  last_attempt_at INTEGER,        -- 最近一次尝试（成功或失败）
  last_error      TEXT            -- 最近一次失败的原因短码（api-error）；成功后清空
);
