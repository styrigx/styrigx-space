/**
 * styrigx-proxy-rules 部署入口（wrangler.toml 的 main）：只接线，逻辑在 app.js 往后。
 * 骨架见 workers/README.md；本 Worker 的职责 / 路由见 workers/proxy-rules/README.md。
 */
export { default } from './app.js';
