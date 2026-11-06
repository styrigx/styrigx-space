-- 退役站点的监测历史清理（2026-11，Gray 批准「删 清干净」）：
-- 监测目标只剩 space / proxy-rules / ai（src/targets.js TARGETS）。博客 blog、奇趣 curio、日刻 daymark（合并 PR3 起并入主站）、
-- 旧图志 atlas（域名下线）、book（已下线）、muse-invite（已删）、站内搜索 search / 聊天 chat（P4-2 起合成 ai）
-- 留下的检查记录、每日 / 每小时汇总、当前状态和故障记录一并删除。汇总接口本来就只按 TARGETS 出站点卡，
-- 但近期故障列表（incidents 最近 20 条）不按站点过滤，退役站的旧故障会一直挤在里面——这里删掉。
-- 按站点存数据的表（0001–0004 里全部）：checks、daily、hourly、state、incidents；usage / quota 是单行快照，与站点无关。
-- 有意的数据删除；部署时 deploy.yml 的 deploy-status-worker 先 wrangler d1 migrations apply 再部署。
DELETE FROM checks    WHERE site NOT IN ('space', 'proxy-rules', 'ai');
DELETE FROM daily     WHERE site NOT IN ('space', 'proxy-rules', 'ai');
DELETE FROM hourly    WHERE site NOT IN ('space', 'proxy-rules', 'ai');
DELETE FROM state     WHERE site NOT IN ('space', 'proxy-rules', 'ai');
DELETE FROM incidents WHERE site NOT IN ('space', 'proxy-rules', 'ai');
