/**
 * @fileoverview v6 的账号命令错误处理（sub / app / passkey / device / profile；终端 cmds/sub、cmds/acct 判过门才进来）。
 * 依据：v6-commands「自己的账号」「授权与订阅（root，或 sudo）」；路由表里原来要再验证的，v6 一律 = 路由档本身（route-access.js 规则 6）。
 * - C.gated(o, run)：直接 run（v6 P4 起旧的 sudo root reauth 删了；留这个名字给调用方，参数不变）。
 * - C.authErrFor(o, res)：服务端 401（v6 会话没了 / 过期）→「没有登录 · 先 su <用户>」（= 身份层 notSignedIn），
 *   403 forbidden（档不够，如 root 空闲弹回 styrigx）→「当前用户没有这个权限 · 先 su root」（= 终端 needRoot6），
 *   两种都让终端身份重新问一次（提示符跟上）；别的错误回 false 交给调用方。
 * 纯函数式挂载（不碰 DOM），单测直接用。
 */

/**
 * @param {any} C 账号层上下文（./layer.js；要有 t / err）
 * @param {{ refresh?: () => any }|null|undefined} who 终端身份（core/who.js createWho）
 */
export function mountV6Direct(C, who) {
  /** @param {any} _opt @param {() => void} run */
  C.gated = function (_opt, run) { run(); };
  /** @param {any} _opt @param {{s:number, j:any}} res @returns {boolean} */
  C.authErrFor = function (_opt, res) {
    const forbidden = !!res && res.s === 403 && !!res.j && res.j.error === 'forbidden';
    if (!res || (res.s !== 401 && !forbidden)) return false;
    if (forbidden) C.err(C.t('v6.forbidden'), 'su root');
    else C.err(C.t('v6.notSignedIn'));
    try { if (who && typeof who.refresh === 'function') who.refresh(); } catch (e) {}
    return true;
  };
  /** 同 authErrFor（v6 P4 起只有 v6 会话） @param {{s:number, j:any}} res */
  C.authErr = function (res) { return C.authErrFor(null, res); };
}
