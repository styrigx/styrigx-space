/**
 * 割接（v6 cutover）单测共用：网关 SpaceVerifier 的 v6 部分替身——admit(cookie, method, path, opts) / auditRoot(cookie, command, ip)。
 *
 * 放行判断用真的账号代码（workers/account/src/core/route-access.js 的 ROUTE_ACCESS + core/admit.js admitDecision = permits），
 * 和账号 Worker rpc/account-verifier.js checkAdmit 一样：问 action 的，路由必须真列了这个 action，回答里带回 action。
 * 这样子站接口 Worker 的测试测到的是「路由表里的档」本身，而不是替身里另写一份。
 *
 * 身份按 sgx-session 的值（测试里约定的名字）：
 * - root     uid 0（su root 之后的栈顶），非救援
 * - rescue   uid 0，救援会话（白名单外一律拒）
 * - styrigx  uid 1000，默认七组（wheel、sudoers、listen、ai、status、curio-write、daymark-write）
 * - alice    uid 1001，只有 listen
 * - temp     uid 1002，无组（临时用户）
 * - bob      uid 1003，只有 ai（2c：能用 AI，但不是站长，看不到私密召回）
 * - 其他值   坏 / 过期令牌（没有身份）
 *
 * v6Space(base, { calls, audits }) → 在 base（conclusionAuth 那种 { conclusion }）上加 admit / auditRoot；calls 记每次 admit 的参数，audits 记 auditRoot。
 */
const SRC = new URL('../../workers/account/src/', import.meta.url).href;
const RA = await import(SRC + 'core/route-access.js');
const AD = await import(SRC + 'core/admit.js');
const G = await import(SRC + 'core/groups.js');

export const IDENTITIES = Object.freeze({
  root: { uid: 0, name: 'root', groups: [], rescue: false },
  rescue: { uid: 0, name: 'root', groups: [], rescue: true },
  styrigx: { uid: 1000, name: 'styrigx', groups: [...G.STYRIGX_DEFAULT_GROUPS], rescue: false },
  alice: { uid: 1001, name: 'alice', groups: ['listen'], rescue: false },
  temp: { uid: 1002, name: 'temp', groups: [], rescue: false },
  bob: { uid: 1003, name: 'bob', groups: ['ai'], rescue: false },
});

/** @param {string} cookie */
export function whoOf(cookie) {
  const m = /(?:^|;\s*)sgx-session=([^;]+)/.exec(cookie || '');
  return m && Object.prototype.hasOwnProperty.call(IDENTITIES, m[1]) ? IDENTITIES[m[1]] : null;
}

/** 同 checkAdmit 的判断（真路由表 + permits） */
export function admitFor(cookie, method, path, opts) {
  const asked = !!(opts && opts.action !== undefined);
  const action = asked ? String(opts.action) : '';
  const id = whoOf(cookie);
  const rule = RA.ruleOf(method, path);
  if (asked && !(rule && rule.actions && Object.prototype.hasOwnProperty.call(rule.actions, action))) return { allowed: false, reason: 'action', uid: id ? id.uid : null, root: false, rescue: false, action };
  const q = asked ? { action } : undefined;
  const level = RA.levelOf(method, path, q);
  if (!rule || !level) return { allowed: false, reason: 'not-listed', uid: null, root: false, rescue: false, action };
  const allowed = AD.admitDecision(id, level, { rescue: RA.rescueOf(method, path, q) });
  return { allowed, reason: allowed ? 'ok' : 'need-' + level, uid: id ? id.uid : null, root: !!id && id.uid === 0, rescue: !!id && id.rescue, action };
}

/** @param {any} base @param {{calls?: any[], audits?: any[], throws?: boolean}} [o] */
export function v6Space(base, o = {}) {
  return Object.assign({}, base, {
    async admit(cookie, method, path, opts) {
      if (o.calls) o.calls.push({ cookie, method, path, opts });
      if (o.throws) throw new Error('down');
      return admitFor(cookie, method, path, opts);
    },
    async auditRoot(cookie, command, ip) {
      const id = whoOf(cookie);
      const ok = !!id && id.uid === 0 && !id.rescue;
      if (o.audits) o.audits.push({ command, ip, ok });
      return ok;
    },
  });
}
