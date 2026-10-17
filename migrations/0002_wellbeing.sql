-- B2-7 网站数字健康：每天每个区域的累计停留秒数（站长本人，跨设备合并）。
-- 代码里也有 CREATE TABLE IF NOT EXISTS 兜底，此 migration 用于 wrangler d1 migrations apply。
CREATE TABLE IF NOT EXISTS wb_daily (
  day TEXT NOT NULL,
  k TEXT NOT NULL,
  t TEXT NOT NULL DEFAULT '',
  sec INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, k)
);
