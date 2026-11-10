/**
 * 命名入口 ProxyAdmin（WorkerEntrypoint）：代理订阅的管理 RPC，只经服务绑定调用（account Worker 的 PROXY 绑定）。
 * 公网 fetch 路由表里没有任何管理或刷新路径。鉴权（会话、reauth）在 account Worker 做完才会调到这里。
 * 改动后的自动刷新：await 完再回，调用方拿到的就是刷新后的状态（刷新整轮 ≤ 约 20 秒）。
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as admin from '../core/sub/admin.js';
import { runRefresh } from '../core/sub/pipeline.js';
import { dbReady } from '../core/sub/store.js';

const NOT_READY = Object.freeze({ ok: false, error: 'config' });

export class ProxyAdmin extends WorkerEntrypoint {
  async status() { return dbReady(this.env) ? admin.status(this.env) : NOT_READY; }

  async setKey(pubkey) {
    if (!dbReady(this.env)) return NOT_READY;
    const r = await admin.setKey(this.env, pubkey);
    return r.ok ? { ...r, refresh: await runRefresh(this.env) } : r;
  }

  async newLink() { return dbReady(this.env) ? admin.newLink(this.env) : NOT_READY; }

  /** 新机场：整轮刷新；同名改链接：试拉成功后只为这个源重出成品（不再拉一次） */
  async addAirport(name, url) {
    if (!dbReady(this.env)) return NOT_READY;
    const r = await admin.addAirport(this.env, name, url);
    if (!r.ok) return r;
    const { id, ...out } = r;
    return { ...out, refresh: await runRefresh(this.env, id ? { ids: [id], noFetch: true } : {}) };
  }

  /** 改名：不刷新（来源名不写进成品，原成品就是新路径的内容） */
  async rename(from, to) { return dbReady(this.env) ? admin.rename(this.env, from, to) : NOT_READY; }
  async upload(name, text) { return this.#changed(() => admin.upload(this.env, name, text)); }
  async setEnabled(name, on) { return this.#changed(() => admin.setEnabled(this.env, name, on)); }
  async remove(name) { return this.#changed(() => admin.remove(this.env, name)); }

  async refresh() { return dbReady(this.env) ? runRefresh(this.env) : NOT_READY; }

  /** @param {() => Promise<any>} fn */
  async #changed(fn) {
    if (!dbReady(this.env)) return NOT_READY;
    const r = await fn();
    return r.ok ? { ...r, refresh: await runRefresh(this.env) } : r;
  }
}
