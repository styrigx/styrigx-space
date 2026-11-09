/**
 * @fileoverview styrigx-ai 部署入口：只接线（workers/README.md 骨架）。
 */
export { default } from './app.js';
/* HourlyJob：给 styrigx-status 的服务绑定 JOB_AI，每小时同步语义召回（2026-11-10 起本 Worker 不自带 Cron） */
export { HourlyJob } from './rpc/hourly-job.js';
