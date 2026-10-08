/* 2.3.15 C5：公共 JS 工具模块（各页共享，避免重复定义） */
window.__sgxUtil = (function(){
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function isEn(){ return document.documentElement.lang === 'en'; }
  function lsGet(k, d){
    try { var v = localStorage.getItem(k); return v === null ? d : v; }
    catch(e){ return d; }
  }
  function lsSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
  function rafThrottle(fn){
    var ticking = false;
    return function(){
      if(ticking) return; ticking = true;
      requestAnimationFrame(function(){ ticking = false; fn(); });
    };
  }
  return { esc: esc, isEn: isEn, get: lsGet, set: lsSet, rafThrottle: rafThrottle };
})();
