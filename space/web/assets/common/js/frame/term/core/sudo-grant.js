/* ---------- D-3 a′「先验后发票」（偏离稿 v3.12 第 9 节） ----------
 * 页面上 root 档的操作（奇趣导出 / 导入 / 删专辑、日刻删专题）：sudoers 不是 root 时，页面（curio.js / daymark.js sudoTicket）先在 window 上登记一笔待办
 * { line, grant:{method, path, action?}, done(ticket), at }，再发 sgx:sudo（auth/sudo.js SUDO_EVENT，detail.line）预填 line；终端回车原样这一行 → sudo 命令 takeSudoGrant 取走它，
 * 身份层验凭据、领票后 done(票)，页面带 X-Sgx-Sudo 头只发一次真请求。子站的 IIFE 脚本（curio / daymark）直接写同一个键名。
 * 放在 term/core/ 里：终端代码只许 import term/** 之内（gen-common 过检）。 */

/** window 上待办的键名 */
export const SUDO_GRANT_KEY = '__sgxSudoGrant';
/** 待办多久没回车就作废 */
export const SUDO_GRANT_WAIT_MS = 5 * 60 * 1000;

/**
 * 终端回车的这一行正好是页面预填的那行（且没过期）→ 取走并回待办；否则 null（不动它）。
 * @param {string} line @param {any} [win] @param {number} [now]
 * @returns {{line:string, grant:{method:string, path:string, action?:string}, done:(t:string)=>void}|null}
 */
export function takeSudoGrant(line, win, now) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  const p = w && w[SUDO_GRANT_KEY];
  if (!p || typeof p !== 'object' || typeof p.line !== 'string' || typeof p.done !== 'function' || !p.grant) return null;
  const t = typeof now === 'number' ? now : Date.now();
  if (!(t - Number(p.at || 0) < SUDO_GRANT_WAIT_MS)) { try { delete w[SUDO_GRANT_KEY]; } catch (e) {} return null; }
  if (String(line).trim() !== p.line) return null;
  try { delete w[SUDO_GRANT_KEY]; } catch (e) {}
  return { line: p.line, grant: { method: String(p.grant.method || ''), path: String(p.grant.path || ''), action: p.grant.action ? String(p.grant.action) : undefined }, done: p.done };
}
