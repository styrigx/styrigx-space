-- styrigx-status 初始表（2026-10-22）。时间一律毫秒时间戳（UTC）；day 是北京时间日期 YYYY-MM-DD。

-- 每次检查一行，留 7 天（每小时整点清一次）
CREATE TABLE IF NOT EXISTS checks (
  site TEXT NOT NULL,
  at   INTEGER NOT NULL,
  ok   INTEGER NOT NULL,      -- 1 正常 / 0 失败
  code INTEGER NOT NULL,      -- HTTP 状态码；没拿到回应是 0
  ms   INTEGER NOT NULL,      -- 耗时（超时记 10000）
  err  TEXT                   -- 失败原因：timeout / network / status
);
CREATE INDEX IF NOT EXISTS checks_site_at ON checks (site, at);

-- 每站每天一行，长期保留
CREATE TABLE IF NOT EXISTS daily (
  site     TEXT NOT NULL,
  day      TEXT NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  ms_sum   INTEGER NOT NULL DEFAULT 0,   -- 只算成功的耗时；平均 = ms_sum / ok_count
  PRIMARY KEY (site, day)
);

-- 每站当前状态（连续失败次数、最近一次结果）
CREATE TABLE IF NOT EXISTS state (
  site      TEXT PRIMARY KEY,
  fails     INTEGER NOT NULL DEFAULT 0,
  last_at   INTEGER NOT NULL DEFAULT 0,
  last_ok   INTEGER NOT NULL DEFAULT 0,
  last_code INTEGER NOT NULL DEFAULT 0,
  last_ms   INTEGER NOT NULL DEFAULT 0,
  last_err  TEXT
);

-- 故障：连续 3 次失败时开（started_at = 第一次失败的时间），恢复时写 ended_at
CREATE TABLE IF NOT EXISTS incidents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site       TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  cause      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_site ON incidents (site, started_at);
