-- D-2 C 收尾（偏离收尾定稿 v4.1；Gray 2026-11-18 16:39「drop 直接核 核完删」）：status_checks 自 0002（2026-11-16）起停写，
-- 读也早已改走 status_minute / status_hourly。删表连同索引。须先部署去掉 monitor.js 里 DELETE status_checks 的版本，再手动执行本迁移（报 Gray 批）。
DROP INDEX IF EXISTS status_checks_at;
DROP TABLE IF EXISTS status_checks;
