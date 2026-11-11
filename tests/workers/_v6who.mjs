/**
 * 子站接口 Worker（curio-core / daymark-core）单测共用：网关 SpaceVerifier 的 v6 替身，按「谁」给结论（应用授权与旧结论 conclusion() 删除后，
 * 定稿 v5.3 §十二：奇趣 / 日刻只经 SpaceVerifier.admit 问 v6 会话的档）。
 *
 * 放行判断用真的账号路由表 + permits（_v6admit.mjs admitFor），身份按「谁」，不看 cookie 的值（请求里仍要带 sgx-session，
 * 子站 _auth.js 没有这个 cookie 不问网关）：
 * - null / ''   没有 v6 身份（访客）
 * - 'owner'     root（全部档；旧测试里「账号已登录、全部作用域、带复验」的继任）
 * - 'styrigx'   站长（默认七组：写组、listen、ai …；root 档的导入 / 导出 / 删整个专题不够）
 * - 'noscope'   alice（只有 listen：写组不够 → 403 forbidden）
 * - 'lock'      temp（有身份、没有组）
 * - 'garbage'   网关回了看不懂的东西（当没有身份）
 *
 * whoAuth(who, { throws, calls, audits }) → env.SPACE：admit(cookie, method, path, opts) / auditRoot(cookie, command, ip)；
 * calls 记每次 admit 的参数，audits 记 auditRoot。
 */
import { admitFor } from './_v6admit.mjs';

const AS = Object.freeze({ owner: 'root', styrigx: 'styrigx', noscope: 'alice', lock: 'temp', root: 'root', alice: 'alice', temp: 'temp' });

/** @param {string|null|undefined} who @param {{throws?: boolean, calls?: any[], audits?: any[]}} [o] */
export function whoAuth(who, o = {}) {
  const name = who && Object.prototype.hasOwnProperty.call(AS, who) ? AS[who] : '';
  return {
    async admit(cookie, method, path, opts) {
      if (o.calls) o.calls.push({ cookie, method, path, opts });
      if (o.throws) throw new Error('down');
      if (who === 'garbage') return { ok: true, junk: 1 };
      return admitFor(name ? 'sgx-session=' + name : '', method, path, opts);
    },
    async auditRoot(cookie, command, ip) {
      const ok = name === 'root';
      if (o.audits) o.audits.push({ command, ip, ok });
      return ok;
    },
  };
}
