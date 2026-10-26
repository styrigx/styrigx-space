-- styrigx-status 免费额度用量缓存（2026-10-27）。只有一行（id = 1）：最近一次成功的「今天操作次数」快照 + 最近一次尝试的结果。
-- /summary 被请求时按需刷新（src/quota.js readQuota：距上次尝试满 5 分钟才查 Cloudflare GraphQL），不走 Cron。时间一律毫秒时间戳（UTC）。
CREATE TABLE IF NOT EXISTS quota (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at      INTEGER,        -- 最近一次成功查询的时间；从没成功过是 NULL
  data            TEXT,           -- 快照 JSON：{ fetched_at, day, month, workers, kv, d1, r2, errors }（字段见 src/quota.js collectQuota）
  last_attempt_at INTEGER,        -- 最近一次尝试（成功或失败）；5 分钟缓存按它算
  last_error      TEXT            -- 最近一次失败的原因短码（api-error）；成功后清空
);
