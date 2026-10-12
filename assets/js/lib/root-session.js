/**
 * @fileoverview 根凭证 → 站长会话共用流程。
 * lock.js（锁屏未配置场景）与 security.js（安全页站长凭证）共用：
 * /api/root-auth 成功后调 /api/root-session 换站长会话（by=root，1 小时），再跳转。
 * 否则无会话会被 middleware 当访客拦。
 */

/**
 * 用根凭证换站长会话。
 * @param {string} key 根凭证
 * @returns {Promise<{ok:boolean, status:number, error?:string}>}
 */
export function exchangeRootSession(key) {
  return fetch('/api/root-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: key }),
    credentials: 'same-origin',
  })
    .then(function (r) {
      return r.json().then(function (j) { return { s: r.status, j: j }; });
    })
    .then(function (res) {
      const j = res.j;
      if (!j || !j.ok) {
        return { ok: false, status: res.s, error: (j && j.error) || 'auth' };
      }
      /* root-auth 成功 → 换站长会话 */
      return fetch('/api/root-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'same-origin',
      })
        .then(function (r2) {
          return r2.json().then(function (j2) { return { s: r2.status, j: j2 }; });
        })
        .then(function (res2) {
          if (res2.j && res2.j.ok) {
            return { ok: true, status: 200 };
          }
          return { ok: false, status: res2.s, error: (res2.j && res2.j.error) || 'session' };
        });
    })
    .catch(function () {
      return { ok: false, status: 0, error: 'network' };
    });
}
