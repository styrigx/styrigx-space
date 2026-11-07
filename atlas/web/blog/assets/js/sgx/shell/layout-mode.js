/* @sgx-shell:begin styrigx/styrigx-space@tree:b9f2d2854606 space/web/shared/shell v84f5013ce83d（space/scripts/blog/sync-shell.mjs 写入，勿手改） */
/* ---- layout-mode.js ---- */
/* 布局模式（P4-3 PR-4b，Gray 2026-11-07 定稿）：只有两种——手机 phone / 桌面 desktop，四个站同一条规则（共享外壳 layout-mode.js，各站原样内联进 <head>，首帧前定好，不闪）。
   - 手动（快捷面板 布局：手机 / 自动 / 桌面；localStorage sgx-layout = phone / auto / desktop，同源四站同一份）：手机 / 桌面直接照办，下面的都不看。
     X 等应用内浏览器没有「桌面版网站」开关，靠这里手动选桌面。旧值兼容：mobile → phone，dex / pc → desktop；其他未知值 = 自动。?layout=auto 逃生口按自动算。
   - 自动：视口宽 < 720 CSS px（手机竖屏、电脑上开的窄窗口、分屏）→ 手机；否则浏览器不是手机版网站模式 → 桌面
     （navigator.userAgentData.mobile；没有 userAgentData 时看 UA 里的 Mobi / Android…Mobile / iPhone）。
     手机上三星浏览器切「桌面版网站」：UA 报桌面 → 桌面。另认「虚拟视口」：浏览器不理 viewport meta、按约 980 宽排版
     （布局视口比屏幕宽 1.25 倍以上，__sgxDesktopSite）也算桌面版网站——UA 还报手机时（切换后页面还没重载、或某次跳转没带上桌面 UA）
     各站照样给桌面，四站同一视口同一结果（P4-3 PR-4b 修复，Gray 2026-11-07 录屏：奇趣在 980 视口下还是手机布局）。
   - 设备 __sgxDevice()（和布局无关，只给顶栏宽分档）：手机 phone = UA 报手机，或「粗指针 + 屏幕短边 < 600 CSS px」（手机开桌面版网站时 UA 报桌面，
     但屏幕还是手机屏）；其余（电脑、平板）desktop。调用方写进 <html data-sgx-device="phone|desktop">。
   - 视口变了（拖窗口、分屏、转屏、切桌面版网站）不刷新页面：__sgxLayoutWatch(fn) 用 matchMedia 听 720 那条线和横竖屏，
     bfcache 恢复（pageshow persisted）也重算一次，变了就调 fn（各站传 __applyLayout）。
   经典脚本 ES5，只定义全局函数，不碰 DOM；调用方把结果写进 <html data-sgx-layout="phone|desktop" data-sgx-device="phone|desktop"> 和各站自己的 layout-* 类。
   主站 space/web/assets/js/lib/prefs.js resolveLayout() 是同一条规则（tests/space/ui/layout/layout-mode.test.mjs 对表）。
   另外两件首帧前的事也在这里（四站同一份、同一个时机：外观预读之后、样式表生效之前），见文件末尾：
   - 手动桌面 + 手机屏 → viewport 改成固定 980 宽（__sgxViewportSync）；
   - 首帧底色：color-scheme / theme-color / 最低优先级的 html 底色跟着本站深浅色走，不跟系统（__sgxFirstPaint）。 */
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
function __sgxScreenW(){
  try{var s=screen,a=s.width,b=s.height;return a>0&&b>0?[a,b]:null}catch(e){return null}
}
function __sgxDesktopSite(){
  var w=window.innerWidth,s=__sgxScreenW(),c=0;
  try{c=document.documentElement.clientWidth||0}catch(e){}
  if(c>w)w=c;
  return !!s&&typeof w==='number'&&w>=720&&w>s[0]*1.25;
}
function __sgxDevice(){
  if(__sgxUaMobile())return 'phone';
  var s=__sgxScreenW(),k=false;
  try{k=window.matchMedia('(pointer: coarse)').matches}catch(e){}
  return k&&!!s&&Math.min(s[0],s[1])<600?'phone':'desktop';
}
function __sgxLayoutAuto(){
  /* viewport 被本文件改成了 980（手动桌面 + 手机屏）：视口宽已经不是浏览器自己给的，只按 UA 判断（自动此刻会给什么，快捷面板「自动 · …」用） */
  if(__sgxViewportForced())return __sgxUaMobile()?'phone':'desktop';
  var w=window.innerWidth;
  if(typeof w==='number'&&w>0&&w<720)return 'phone';
  return !__sgxUaMobile()||__sgxDesktopSite()?'desktop':'phone';
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
    window.addEventListener('pageshow',function(e){if(e&&e.persisted)on()});
  }catch(e){}
}
/* 手动桌面 + 手机屏（2026-11-07 Gray 真机：X 应用内浏览器没有「桌面版网站」开关，快捷面板选「桌面」只有顶栏出了页名胶囊，正文还是手机版）：
   四站 viewport meta 是 width=device-width，布局视口还是手机宽（S23 Ultra 384），正文网格靠宽度断点，照样排手机版。
   这时把 viewport 改成固定 __SGX_DESKTOP_VW = 980 宽：和三星 / Chrome「桌面版网站」给的布局视口一样（#297 起四站的桌面版就是按这个宽对齐、截图验过的），
   浏览器像桌面版网站那样整页缩小显示；1280 会把字缩到 0.3 倍，太小。
   只在「偏好 = 桌面」且「手机屏」（__sgxPhoneScreen：屏幕短边 < 600 CSS px，且是触屏或 UA 报手机——同 __sgxDevice 的手机线；电脑上的小窗口不算）时改；自动 / 手机偏好、平板、DeX、电脑一律不动；
   浏览器已经在桌面版网站（不理 meta）时改了也不起作用，结果不变。原 content 记在 data-sgx-vp，换回别的偏好时还原。
   时机：本文件内联在四站 <head>、viewport meta 之后，加载时先跑一次（首帧就是桌面宽）；快捷面板切布局时 topbar.js 再调，变了先原地生效
   （等两帧看布局视口宽 / 整页适配对不对，停在放大比例上就临时补 initial-scale = maximum-scale 压回去），还不行才关面板整页重载（2026-11-07：重载会白闪）。应用内浏览器（Android WebView）认不认 meta 宽度取决于宿主 App 的设置，没在真机上验过。 */
var __SGX_DESKTOP_VW=980;
function __sgxPhoneScreen(){
  var s=__sgxScreenW(),k=false;
  if(!s||Math.min(s[0],s[1])>=600)return false;
  try{k=window.matchMedia('(pointer: coarse)').matches}catch(e){}
  return k||__sgxUaMobile();
}
function __sgxViewportMeta(){
  try{return document.querySelector('meta[name="viewport"]')}catch(e){return null}
}
function __sgxViewportForced(){
  var m=__sgxViewportMeta(),o=m?m.getAttribute('data-sgx-vp'):null;
  return o!==null&&m.getAttribute('content')!==o;
}
function __sgxViewportSync(){
  var m=__sgxViewportMeta();
  if(!m)return false;
  var o=m.getAttribute('data-sgx-vp');
  if(o===null){o=m.getAttribute('content')||'';m.setAttribute('data-sgx-vp',o)}
  var want=__sgxLayoutPref()==='desktop'&&__sgxPhoneScreen()?'width='+__SGX_DESKTOP_VW:o;
  if(m.getAttribute('content')===want)return false;
  m.setAttribute('content',want);
  return true;
}
/* 首帧底色（2026-11-07 Gray 真机：切站 / 切页整页白一下）：<meta name="color-scheme" content="light dark"> 让浏览器按「系统」深浅色给页面画布底色，
   本站选了深色、系统是浅色时，两个文档之间、样式表还没生效的那几帧露出的是浏览器的白底；theme-color（三星浏览器地址栏）同样按系统，博客还是写死的浅色。
   这里按 <html data-dark>（四站外观预读刚落好）把 color-scheme、theme-color 改成本站的深浅色，并在 <head> 最前面插一条最低优先级的 html 底色
   （@layer 第一个出现 = 最低层；各站样式表一到就按调色板盖过它，运行中切深浅色、换调色板都不受影响）。底色用默认调色板（雾霾蓝）的 bg-1。 */
function __sgxFirstPaint(){
  try{
    var d=document.documentElement,h=document.head,dk=d.getAttribute('data-dark')==='1'||d.classList.contains('dark'),i,l;
    var cs=dk?'dark':'light',tc=dk?'#10151a':'#f5f8fa',bg=dk?'#0a0e10':'#f2f6f7',sb=null;
    /* 快捷面板切布局、原地改视口没生效只能整页重载时（topbar.js），重载前把当时页面的实际底色（当前调色板）存进 sessionStorage sgx-fp-bg：
       这一帧就用它（只认不透明的 rgb()），用一次就删 */
    try{sb=sessionStorage.getItem('sgx-fp-bg');if(sb!==null)sessionStorage.removeItem('sgx-fp-bg')}catch(e){}
    if(sb&&/^rgb\(\d{1,3}, ?\d{1,3}, ?\d{1,3}\)$/.test(sb))bg=sb;
    l=document.querySelectorAll('meta[name="color-scheme"]');for(i=0;i<l.length;i++)l[i].setAttribute('content',cs);
    l=document.querySelectorAll('meta[name="theme-color"]');for(i=0;i<l.length;i++)l[i].setAttribute('content',tc);
    var st=document.getElementById('sgx-first-paint');
    if(!st){st=document.createElement('style');st.id='sgx-first-paint';h.insertBefore(st,h.firstChild)}
    st.textContent='@layer sgx-first-paint{html{background-color:'+bg+';color-scheme:'+cs+'}}';
  }catch(e){}
}
try{if(typeof document!=='undefined'){__sgxViewportSync();__sgxFirstPaint()}}catch(e){}
/* @sgx-shell:end */
