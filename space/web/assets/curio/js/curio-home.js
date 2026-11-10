/* assets/js/curio-home.js —— 奇趣首页的旧地址兼容（浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 2026-11 对齐 PR-C2 起奇趣首页 /curio/ 就是「发现」（设计稿 pg=curio：ls curio/，默认 finds/ tab），分区切换是页头的下划线 tab。
 * 拆页前首页用 hash 分区：#devices、#games 转到设备 / 游戏子页（客户端 location.replace，不是 301，不留历史）；
 * #c/<分类 id> 现在就在首页生效（curio.js 认这个 hash），不用跳。目标地址取页头 tab 上已经按语言算好的 href（模板 sgx-lang-path.html），本文件不手写语言前缀。
 */
(function(){
"use strict";
var G = typeof globalThis !== 'undefined' ? globalThis : this;

/**
 * 旧 hash → 去哪个子页：{entry, hash} 或 null（不用跳）。
 * @param {string} hash
 */
function legacyTarget(hash){
  var h = String(hash || '');
  if (h === '#devices' || h.indexOf('#devices/') === 0) return { entry: 'devices', hash: '' };
  if (h === '#games' || h.indexOf('#games/') === 0) return { entry: 'games', hash: '' };
  return null;
}
var pure = { legacyTarget: legacyTarget };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

var doc = G.document;
var t = legacyTarget(G.location.hash);
if (t) {
  var a = doc.querySelector('#cu-tabs [data-ctab="' + t.entry + '"]');
  if (a) G.location.replace(a.getAttribute('href') + t.hash);
}
})();
