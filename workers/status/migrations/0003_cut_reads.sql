-- styrigx-status 降低 D1 读取量（2026-10-23）。
-- 起因：loadPrev 每分钟用「最近一次成功之后最早的失败」子查询扫整张 checks 表（索引不含 ok），
-- 一天 1440 次，checks 越长越多（7 天约 5 万行 → 每天约 7000 万行读取），免费额度 500 万行 / 天第二天就到 75%。
-- 1) state 记下这一串失败的第一次时间，loadPrev 只读 state（5 行）。
ALTER TABLE state ADD COLUMN first_fail_at INTEGER NOT NULL DEFAULT 0;
-- 2) 每站每小时一行，给 /summary 算近 24 小时可用率和响应时间（约 125 行），不再读 checks。
CREATE TABLE IF NOT EXISTS hourly (
  site     TEXT NOT NULL,
  hour     INTEGER NOT NULL,             -- 整点毫秒时间戳（UTC）
  total    INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  ms_sum   INTEGER NOT NULL DEFAULT 0,   -- 只算成功的耗时
  PRIMARY KEY (site, hour)
);
-- 3) checks 现在只写不查，只有整点清理按 at 删：换成 at 索引（清理只碰要删的行），去掉没人用的 (site, at)。
DROP INDEX IF EXISTS checks_site_at;
CREATE INDEX IF NOT EXISTS checks_at ON checks (at);
