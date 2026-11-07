-- 站点监测 styrigx-status 的基线表结构（2026-11 D1 合库）：库 styrigx-space-gateway（主站数据统一进这一个库），迁移记录表 d1_migrations_status。
-- 等于旧库 styrigx-status 跑完 migrations-archive/0001–0005 后的表结构，表名和索引名一律加 status_ 前缀（库里还有网关表和短链 share_*）。
-- 列的顺序和旧库一致（status_state.first_fail_at 在最后，旧库是 ALTER 加的），搬数据时按列名插入。
-- 只建表建索引，不放数据、不删数据（存量行由 .github/workflows/d1-cutover.yml 从旧库 styrigx-status 搬来并改表名）。
-- 时间一律毫秒时间戳（UTC）；day 是北京时间日期 YYYY-MM-DD。

-- 每次检查一行，留 7 天（每小时整点按 at 清一次；只写不查，健康闸门 space/scripts/health-gate.mjs 经 D1 REST 按 at 读）
CREATE TABLE IF NOT EXISTS status_checks (
  site TEXT NOT NULL,
  at   INTEGER NOT NULL,
  ok   INTEGER NOT NULL,      -- 1 正常 / 0 失败
  code INTEGER NOT NULL,      -- HTTP 状态码；没拿到回应是 0
  ms   INTEGER NOT NULL,      -- 耗时（超时记 10000）
  err  TEXT                   -- 失败原因：timeout / network / status / binding
);
CREATE INDEX IF NOT EXISTS status_checks_at ON status_checks (at);

-- 每站每天一行，长期保留
CREATE TABLE IF NOT EXISTS status_daily (
  site     TEXT NOT NULL,
  day      TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  ms_sum   INTEGER NOT NULL DEFAULT 0,   -- 只算成功的耗时；平均 = ms_sum / ok_count
  PRIMARY KEY (site, day)
);

-- 每站当前状态（连续失败次数、这一串失败的第一次时间、最近一次结果）
CREATE TABLE IF NOT EXISTS status_state (
  site      TEXT PRIMARY KEY,
  fails     INTEGER NOT NULL DEFAULT 0,
  last_at   INTEGER NOT NULL DEFAULT 0,
  last_ok   INTEGER NOT NULL DEFAULT 0,
  last_code INTEGER NOT NULL DEFAULT 0,
  last_ms   INTEGER NOT NULL DEFAULT 0,
  last_err  TEXT,
  first_fail_at INTEGER NOT NULL DEFAULT 0
);

-- 故障：连续 3 次失败时开（started_at = 第一次失败的时间），恢复时写 ended_at
CREATE TABLE IF NOT EXISTS status_incidents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site       TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  cause      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS status_incidents_site ON status_incidents (site, started_at);

-- 每站每小时一行，给 /summary 算近 24 小时可用率和响应时间
CREATE TABLE IF NOT EXISTS status_hourly (
  site     TEXT NOT NULL,
  hour     INTEGER NOT NULL,             -- 整点毫秒时间戳（UTC）
  total    INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  ms_sum   INTEGER NOT NULL DEFAULT 0,   -- 只算成功的耗时
  PRIMARY KEY (site, hour)
);

-- 用量快照（D1_CLOUDFLARE_USAGE）。只有一行（id = 1）：最近一次成功的 Cloudflare 用量快照 + 最近一次尝试的结果（src/usage.js）。
CREATE TABLE IF NOT EXISTS status_usage (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at      INTEGER,        -- 最近一次成功收集的时间；从没成功过是 NULL
  data            TEXT,           -- 快照 JSON：{ fetched_at, workers, d1, r2, kv, errors }
  last_attempt_at INTEGER,        -- 最近一次尝试（成功或失败）
  last_error      TEXT            -- 最近一次失败的原因短码（api-error）；成功后清空
);

-- 免费额度用量缓存（D1_CLOUDFLARE_USAGE）。只有一行（id = 1）：/summary 按需刷新，5 分钟缓存（src/quota.js）。
CREATE TABLE IF NOT EXISTS status_quota (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at      INTEGER,
  data            TEXT,           -- 快照 JSON：{ fetched_at, day, month, workers, kv, d1, r2, errors }
  last_attempt_at INTEGER,        -- 5 分钟缓存按它算
  last_error      TEXT
);
