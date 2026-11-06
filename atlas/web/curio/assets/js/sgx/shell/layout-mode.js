/* @sgx-shell:begin styrigx/styrigx-space@tree:075dba74b303 space/web/shared/shell v60d35f26850b（space/scripts/curio/sync-shell.mjs 写入，勿手改） */
/* ---- layout-mode.js ---- */
/* 布局模式（P4-3 PR-4b，Gray 2026-11-07 定稿）：只有两种——手机 phone / 桌面 desktop，四个站同一条规则（共享外壳 layout-mode.js，各站原样内联进 <head>，首帧前定好，不闪）。
   - 手动（快捷面板 布局：手机 / 自动 / 桌面；localStorage sgx-layout = phone / auto / desktop，同源四站同一份）：手机 / 桌面直接照办，下面的都不看。
     X 等应用内浏览器没有「桌面版网站」开关，靠这里手动选桌面。旧值兼容：mobile → phone，dex / pc → desktop；其他未知值 = 自动。?layout=auto 逃生口按自动算。
   - 自动：浏览器不是手机版网站模式 → 桌面（navigator.userAgentData.mobile；没有 userAgentData 时看 UA 里的 Mobi / Android…Mobile / iPhone）。
     手机上三星浏览器切「桌面版网站」报的是桌面，就给桌面样式。
     唯一的保险（只在自动里）：算出来是桌面、但视口宽 < 720 CSS px（电脑上开的窄窗口、分屏）→ 手机样式。
   - 视口变了（拖窗口、分屏、转屏）不刷新页面：__sgxLayoutWatch(fn) 用 matchMedia 听 720 那条线和横竖屏，变了就调 fn（各站传 __applyLayout）。
   经典脚本 ES5，只定义全局函数，不碰 DOM；调用方把结果写进 <html data-sgx-layout="phone|desktop"> 和各站自己的 layout-* 类。
   主站 space/web/assets/js/lib/prefs.js resolveLayout() 是同一条规则（tests/space/ui/layout/layout-mode.test.mjs 对表）。 */
function __sgxUaMobile(){
  try{
    var n=navigator,u=n.userAgentData;
    if(u&&typeof u.mobile==='boolean')return u.mobile;
    return /Mobi|Android.*Mobile|iPhone/.test(n.userAgent||'');
  }catch(e){return false}
}
function __sgxLayoutPref(){
  var m=null;
  try{
    if(new URLSearchParams(location.search).get('layout')==='auto')m='auto';
    else m=localStorage.getItem('sgx-layout');
  }catch(e){}
  if(m==='phone'||m==='mobile')return 'phone';
  if(m==='desktop'||m==='dex'||m==='pc')return 'desktop';
  return 'auto';
}
function __sgxLayoutAuto(){
  if(__sgxUaMobile())return 'phone';
  var w=window.innerWidth;
  return typeof w==='number'&&w>0&&w<720?'phone':'desktop';
}
function __sgxLayout(){
  var p=__sgxLayoutPref();
  return p==='auto'?__sgxLayoutAuto():p;
}
function __sgxLayoutWatch(fn){
  try{
    var on=function(){fn();try{window.dispatchEvent(new Event('sgx-layout-change'))}catch(e){}};
    var qs=['(min-width: 720px)','(orientation: portrait)'];
    for(var i=0;i<qs.length;i++){var q=window.matchMedia(qs[i]);if(q.addEventListener)q.addEventListener('change',on);else if(q.addListener)q.addListener(on)}
  }catch(e){}
}
/* @sgx-shell:end */
