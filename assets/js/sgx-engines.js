/* 2.4.0 F：搜索引擎共享定义（浏览器页 + 设置页共用）。
   localStorage key 保持 'sgx-search-engine' 不变；google 为默认，不存值（key 不存在即 google）。
   图标引用 layouts/partials/sgx-icon-sprite.html 里的 sgx-ic-eng-* 内联 SVG。 */
window.__sgxEngines = (function(){
  'use strict';
  var get = window.__sgxGet, set = window.__sgxSet;
  var LS = 'sgx-search-engine';
  var ENGINES = {
    google:     { n: 'Google',     u: 'https://www.google.com/search?q=%s',   icon: 'sgx-ic-eng-google' },
    bing:       { n: 'Bing',       u: 'https://www.bing.com/search?q=%s',     icon: 'sgx-ic-eng-bing' },
    duckduckgo: { n: 'DuckDuckGo', u: 'https://duckduckgo.com/?q=%s',         icon: 'sgx-ic-eng-duckduckgo' },
    yahoo:      { n: 'Yahoo',      u: 'https://search.yahoo.com/search?p=%s', icon: 'sgx-ic-eng-yahoo' },
    ecosia:     { n: 'Ecosia',     u: 'https://www.ecosia.org/search?q=%s',   icon: 'sgx-ic-eng-ecosia' }
  };
  var ORDER = ['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia'];

  function cur(){
    var e = null;
    try{ e = get(LS); }catch(e){}
    return ENGINES[e] ? e : 'google';
  }
  function name(id){
    var e = ENGINES[id] || ENGINES.google;
    return e.n;
  }
  function url(id, q){
    var e = ENGINES[id] || ENGINES.google;
    return e.u.replace('%s', encodeURIComponent(q == null ? '' : q));
  }
  function iconUse(id, size){
    var e = ENGINES[id] || ENGINES.google;
    size = size || 22;
    return '<svg width="' + size + '" height="' + size + '" aria-hidden="true"><use href="#' + e.icon + '"></use></svg>';
  }
  function notify(){
    try{ window.dispatchEvent(new Event('sgx-settings-changed')); }catch(e){}
  }
  function setCur(id){
    if(!ENGINES[id]) return;
    try{ set(LS, id === 'google' ? null : id); }catch(e){}
    notify();
  }
  /* 跨标签页同步：别的标签页改了引擎，本页收到 storage 事件后走同一套通知 */
  window.addEventListener('storage', function(ev){
    if(ev && ev.key === LS) notify();
  });

  return {
    LS: LS, ENGINES: ENGINES, ORDER: ORDER,
    cur: cur, name: name, url: url, iconUse: iconUse, setCur: setCur, notify: notify
  };
})();
