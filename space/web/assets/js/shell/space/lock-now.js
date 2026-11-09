/**
 * @fileoverview 立即锁屏（只锁本机，不验证；Gray 2026-11-09 08:03）。盾牌的「立即锁屏」行和 lock 命令、NAVIGATE 底部 lock、站内终端 lock 用同一个。
 * 锁其他 / 所有设备要 reauth，在盾牌进站凭证层（keys.js → api.session.endAll）。
 * 原 auth/lock-now.js 的「立即锁定？」确认层删了（Gray C：没有弹层）。
 */

/**
 * 清本机进站会话（连带 reauth / reset 票）。成功回 true；调用方随后去 /?entry=1。
 * @param {{session: {end: () => Promise<{s: number, j: any}>}}} api shell/space/api.js
 * @returns {Promise<boolean>}
 */
export function lockNow(api) {
  return api.session.end().then(function (r) { return !!(r && r.s >= 200 && r.s < 300); }, function () { return false; });
}
