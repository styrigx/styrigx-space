/**
 * @fileoverview 服务绑定 RPC 入口 CurioReader（2026-11 AI 语义召回）：只读固定查询，逻辑在 ../reader.js（node 单测直接测它）。
 * 只能通过服务绑定调用（styrigx-ai 的 wrangler.toml：service = "styrigx-curio-core"、entrypoint = "CurioReader"），公网路由进不来。
 * 调用方：styrigx-ai（workers/ai/src/core/fixed.js）。不验会话：styrigx-ai 只经网关进来，进门已由网关验过。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { runQuery } from '../reader.js';

export class CurioReader extends WorkerEntrypoint {
  /**
   * @param {string} name 查询名（reader.js QUERIES）
   * @param {any} params
   */
  async query(name, params) {
    return runQuery(this.env, String(name || ''), params || {});
  }
}
