/**
 * 测试用：给 node 注册 cloudflare:workers 的替身（WorkerEntrypoint 只记 ctx / env，同 Workers 运行时的构造参数顺序）。
 * 入口测试（account-entrypoints.test.mjs）在 import entrypoints.js / worker.js 之前 import 本文件。
 * node --test 每个测试文件一个进程，替身不会影响别的文件。
 */
import { register } from 'node:module';

const STUB = 'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const HOOKS = `
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
  }
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(HOOKS));
