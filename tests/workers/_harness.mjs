/**
 * Worker 单测的公共测试台。纯工具（derToPem、makeKV）的实现在 _harness.cjs（e2e 的 CJS 测试台也用它），这里转出。
 *
 * - derToPem(der, label) / makeKV(seed?, opts?) / makeAuthD1(opts?)：见 _harness.cjs
 * - withAuthD1(env, db?)：给网关 env 补 D1_LOCK_AUTH / D1_ACCOUNT_AUTH / D1_ROOT_AUTH（同一个库）
 * - forbiddenKV(name, touched)：碰一下就抛错的 KV（网关运行时没有 KV、没有回落），碰过的记进 touched
 * - genKeyPair()：一对临时 Ed25519 钥匙 { priv, pub }（PEM），当 SGX_LOCK_* / SGX_ACCOUNT_* 用
 * - postReq(url, body, headers?)：JSON POST；默认带 Content-Type 和 Origin（= url 的 origin，真实浏览器 POST 必带）；
 *   headers 里 Origin: null 表示不带 Origin
 *
 * 带元数据的 KV 替身（getWithMetadata：头像、auth-worker / security-headers 里写死 lock-epoch 的那份）
 * 行为各不相同，留在各自的测试文件里。
 */
import harness from './_harness.cjs';

/** @type {(der: ArrayBuffer|Uint8Array, label: string) => string} */
export const derToPem = harness.derToPem;
/** @type {(seed?: Record<string, any>, opts?: {throwOn?: ((k: string) => boolean) | null}) => any} */
export const makeKV = harness.makeKV;
/** @type {(opts?: {migrations?: boolean, epochs?: Record<string, number>, legacyKv?: any}) => any} */
export const makeAuthD1 = harness.makeAuthD1;

/** 同一个 KV 替身对应同一个 D1 替身（测试里常常对同一份 kv 多次拼 env，状态要跟着走） */
const d1ByKv = new WeakMap();

/**
 * 给网关 env 补上 D1 绑定（D1_LOCK_AUTH / D1_ACCOUNT_AUTH / D1_ROOT_AUTH，正式与预览都绑同一个库），返回同一个 env。
 * db 不给：按 env.KV_LOCK_DOOR（测试里那份「上线前的 KV」）取：第一次新建一个跑过迁移的库，并把这份 KV 当作导入脚本的来源
 * （makeAuthD1 legacyKv：模拟部署前跑过 scripts/migrate-kv-to-d1.mjs）；同一份 kv 拿到同一个库。网关代码本身不读 env 里的 KV。
 * @param {any} env @param {any} [db]
 */
export function withAuthD1(env, db) {
  let d = db;
  if (!d) {
    const key = env && env.KV_LOCK_DOOR;
    d = key && typeof key === 'object' ? authD1For(key) : makeAuthD1();
  }
  env.D1_LOCK_AUTH = d;
  env.D1_ACCOUNT_AUTH = d;
  env.D1_ROOT_AUTH = d;
  return env;
}

/**
 * 某份 kv 对应的 D1 替身（withAuthD1 用的同一个；没有就新建并登记，这份 kv 当作导入来源）。
 * @param {any} kv
 */
export function authD1For(kv) {
  let d = d1ByKv.get(kv);
  if (!d) { d = makeAuthD1({ legacyKv: kv }); d1ByKv.set(kv, d); }
  return d;
}
/**
 * 碰一下就抛错的 KV 替身：任何属性访问（get / put / list…）都记进 touched 再抛错。
 * 记下来是因为调用方可能吞掉异常按 fail closed 处理，单看结果看不出碰过。
 * @param {string} name @param {string[]} [touched]
 */
export function forbiddenKV(name, touched) {
  const log = touched || [];
  return new Proxy({}, {
    get(_t, prop) {
      log.push(name + '.' + String(prop));
      throw new Error('KV touched: ' + name + '.' + String(prop));
    },
    has(_t, prop) {
      log.push(name + ' has ' + String(prop));
      throw new Error('KV touched: ' + name);
    },
  });
}

/** @returns {Promise<{priv: string, pub: string}>} */
export async function genKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    priv: derToPem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY'),
    pub: derToPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
  };
}

/**
 * @param {string} url
 * @param {any} body
 * @param {Record<string, string|null>} [headers]
 */
export function postReq(url, body, headers = {}) {
  /** @type {Record<string, any>} */
  const h = { 'Content-Type': 'application/json', 'Origin': new URL(url).origin, ...headers };
  if (h['Origin'] === null) delete h['Origin'];
  return new Request(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
}
