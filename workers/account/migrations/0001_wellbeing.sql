-- 网站数字健康（B2-7）：每天每个区域的累计停留秒数（站长本人，跨设备合并）。D1 styrigx-account（账号 Worker styrigx-account）。
-- 2026-10-24 从网关 D1 styrigx-auth-gateway 的 0002_wellbeing.sql 搬来；代码里也有 CREATE TABLE IF NOT EXISTS 兜底，此 migration 用于 wrangler d1 migrations apply。
CREATE TABLE IF NOT EXISTS wb_daily (
  day TEXT NOT NULL,
  k TEXT NOT NULL,
  t TEXT NOT NULL DEFAULT '',
  sec INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, k)
);
