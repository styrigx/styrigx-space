/**
 * @fileoverview 割接：v6 root 直接做的账号命令（sub / app；终端 cmds/sub、cmds/acct 判过 v6 root 才传 o.direct）。
 * 依据：v6-commands「授权与订阅（root，或 sudo）」；路由表 POST /api/account/proxy、/api/account/grants 是 root 档（#401 接了 v6，
 * 服务端对 v6 root 不要旧账号会话、不要 reauth 票——route-access.js 规则 5：原来要再验证的，v6 一律 = root 档、sudo 每次重验）。
 * - C.gated(o, run, lead)：o.direct → 直接 run；否则旧的 C.withReauth（sudo root reauth，P4 删）。同 #402 share 的 gated。
 * - C.authErrFor(o, res)：o.direct 时服务端 401（v6 会话没了 / 过期）→「没有登录 · 先 su <用户>」（= 身份层 notSignedIn），
 *   403 forbidden（档不够，如 root 空闲弹回 styrigx）→「当前用户没有这个权限 · 先 su root」（= 终端 needRoot6，#402 share 同一句），
 *   两种都让终端身份重新问一次（提示符跟上），不碰旧账号会话的状态；别的错误回 false 交给调用方。否则旧的 C.authErr。
 * 纯函数式挂载（不碰 DOM），单测直接用。
 */

/**
 * @param {any} C 账号层上下文（./layer.js；要有 t / err / withReauth / authErr）
 * @param {{ refresh?: () => any }|null|undefined} who 终端身份（core/who.js createWho）
 */
export function mountV6Direct(C, who) {
  /** @param {{direct?: boolean}|undefined} opt @param {() => void} run @param {string} lead */
  C.gated = function (opt, run, lead) {
    if (opt && opt.direct) { run(); return; }
    C.withReauth(run, lead);
  };
  /** @param {{direct?: boolean}|undefined} opt @param {{s:number, j:any}} res @returns {boolean} */
  C.authErrFor = function (opt, res) {
    if (!(opt && opt.direct)) return C.authErr(res);
    const forbidden = !!res && res.s === 403 && !!res.j && res.j.error === 'forbidden';
    if (!res || (res.s !== 401 && !forbidden)) return false;
    if (forbidden) C.err(C.t('v6.forbidden'), 'su root');
    else C.err(C.t('v6.notSignedIn'));
    try { if (who && typeof who.refresh === 'function') who.refresh(); } catch (e) {}
    return true;
  };
}
