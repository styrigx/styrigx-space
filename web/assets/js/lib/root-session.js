/**
 * @fileoverview 根凭证 → 站长会话交换。
 * 锁屏未配置场景：/api/root-auth 成功后只签发锁屏门票（sgx-door，door=lock，by=root），
 * 需调用 /api/root-session 换取站长会话（by=root，1 小时）才能进入站长页面，
 * 否则无会话会被 middleware 拦回。
 * 锁屏已配置场景：访客走假入口（服务端 401），不调用此函数。
 */

/**
 * 调用 /api/root-session 换取站长会话。
 * @returns {Promise<{ok: boolean, status: number}>}
 */
export function exchangeRootSession() {
  return fetch('/api/root-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    credentials: 'same-origin',
  })
    .then(function (r) {
      return r.text().then(function (t) {
        let j = null;
        try {
          j = JSON.parse(t);
        } catch (e) {}
        return { ok: !!(j && j.ok), status: r.status };
      });
    })
    .catch(function () {
      return { ok: false, status: 0 };
    });
}
