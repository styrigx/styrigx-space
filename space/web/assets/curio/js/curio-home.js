/* assets/js/curio-home.js —— 奇趣首页（P4-3 奇趣拆页）：首页只有平铺入口，每个分区是独立子页。浏览器 IIFE；node 测试时导出纯函数。
 *
 * 1. 旧 hash 地址兼容（客户端，不是 301）：拆页前首页用 hash 分区——#devices、#games 转到设备 / 游戏子页，#c/<分类 id> 转到发现子页并带上这个 hash。
 *    目标地址取首页入口上已经按语言算好的 href（模板 sgx-lang-path.html），本文件不手写语言前缀；用 location.replace，不留历史。
 * 2. 私人入口：音乐仅本人可见。入口默认被 CSS 藏着（html 没有 .cu-music-ok 时不显示 data-entry="music"）；
 *    问 /curio/api/access（进门即可，只回布尔），music = true 才给 <html> 加 .cu-music-ok。没权限、出错都保持藏着。
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
  if (/^#c\/\d+$/.test(h)) return { entry: 'finds', hash: h };
  return null;
}
var pure = { legacyTarget: legacyTarget };
if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

var doc = G.document;
var t = legacyTarget(G.location.hash);
if (t) {
  var a = doc.querySelector('#cu-entries [data-entry="' + t.entry + '"]');
  if (a) { G.location.replace(a.getAttribute('href') + t.hash); return; }
}
fetch('/curio/api/access', { credentials: 'same-origin', cache: 'no-store' }).then(function(r){
  return r.ok ? r.json() : null;
}).then(function(j){
  if (j && j.ok && j.music === true) doc.documentElement.classList.add('cu-music-ok');
}).catch(function(){});
})();
