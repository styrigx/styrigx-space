/* assets/js/curio-home.js —— 奇趣首页的旧地址兼容（浏览器 IIFE；node 测试时导出纯函数）。
 *
 * 2026-11 对齐 PR-C2 起奇趣首页 /curio/ 就是「发现」（设计稿 pg=curio：ls curio/）。
 * 拆页前首页用 hash 分区：#devices 转到设备子页（客户端 location.replace，不是 301，不留历史）；
 * #c/<分类 id> 现在就在首页生效（curio.js 认这个 hash），不用跳。
 * 奇趣重组 PR 2（2026-11-22）：游戏搬成第五个子站 /games/，#games 的转跳删掉了；页头的分区 tab 行也去掉了，
 * 所以目标地址不再取 tab 上的 href，而是按本页地址算：首页（/curio/ 或 /curio/zh/，语言前缀原样保留）+ devices/。
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
  return null;
}
/**
 * 子页地址：首页路径（/curio/、/curio/zh/；没有结尾斜杠补上）+ <entry>/。
 * @param {string} pathname 当前（首页）路径 @param {string} entry
 */
function entryPath(pathname, entry){
  var p = String(pathname || '/curio/');
  if (p.charAt(p.length - 1) !== '/') p += '/';
  return p + entry + '/';
}
var pure = { legacyTarget: legacyTarget, entryPath: entryPath };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

var t = legacyTarget(G.location.hash);
if (t) G.location.replace(entryPath(G.location.pathname, t.entry) + t.hash);
})();
