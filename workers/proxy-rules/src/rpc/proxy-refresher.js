/**
 * 命名入口 ProxyRefresher（WorkerEntrypoint）：只给本 Worker 自己经服务绑定 SELF 调——刷新流水线把每个源放进单独一次调用，
 * 各算各的 CPU（免费档每次 10 ms，见 core/sub/pipeline.js）。account Worker 绑的是 ProxyAdmin，调不到这里。
 * 锁不在调用方 owner 手里就什么都不做。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { refreshSourceById } from '../core/sub/pipeline.js';
import { dbReady } from '../core/sub/store.js';

export class ProxyRefresher extends WorkerEntrypoint {
  /** @param {string} id @param {string} owner @param {number} now @param {string} ua */
  async refreshSource(id, owner, now, ua) {
    if (!dbReady(this.env)) return { ok: false, error: 'config' };
    return refreshSourceById(this.env, String(id), String(owner), Number(now), String(ua));
  }
}
