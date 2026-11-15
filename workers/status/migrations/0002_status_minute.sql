-- D-2 方案 C（Gray 2026-11-15 21:19 定；偏离稿 v3.13 第 9 节）：一分钟一行，一轮全部检查结果存 JSON。
-- 取代每站每分钟写 status_checks / status_hourly / status_daily / status_state；hourly、daily 改整点汇总（src/monitor.js aggregate）。
-- 主键即时间，不另建索引（索引更新也计 D1 写入行）。status_checks 停写，按原清理节奏逐日删空，之后另出迁移 DROP。
-- data：[{"s":站,"ok":1|0,"code":HTTP 码,"ms":耗时,"err":失败原因|null}]
CREATE TABLE IF NOT EXISTS status_minute (
  at   INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);
