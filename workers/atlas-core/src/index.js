/**
 * @fileoverview styrigx-atlas-core 部署入口：只接线（workers/README.md 骨架）。
 * - default：接口分流 + Cron（app.js）
 * - CurioReader：给 styrigx-ai 的服务绑定 RPC，奇趣只读固定查询（curio/rpc/reader.js，名字不变）
 * - HourlyJob：给 styrigx-status 的服务绑定，每小时任务（rpc/hourly-job.js，先奇趣后日刻）
 * 单测 import app.js，不经过这里（cloudflare:workers 只在 Workers 里有）。
 */
export { default } from './app.js';
export { CurioReader } from './curio/rpc/reader.js';
export { HourlyJob } from './rpc/hourly-job.js';
