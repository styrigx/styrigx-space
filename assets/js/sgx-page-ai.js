(function(){
  'use strict';
  var EN=document.documentElement.lang==='en';
  function t(zh,en){return EN?en:zh}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function hostOf(u){try{return new URL(u).hostname}catch(e){return''}}

  /* ---------- 平台列表：name、home、url 模板、prefill、中英文说明 ---------- */
  var PLATFORMS=[
    {id:'chatgpt',   name:'ChatGPT',  home:'https://chatgpt.com/',               url:'https://chatgpt.com/?prompt={q}',            prefill:true,  zh:'OpenAI',    en:'OpenAI'},
    {id:'perplexity',name:'Perplexity',home:'https://www.perplexity.ai/',        url:'https://www.perplexity.ai/search/new?q={q}', prefill:true,  zh:'AI 搜索',   en:'AI search'},
    {id:'googleai',  name:'Google AI',home:'https://www.google.com/search?udm=50',url:'https://www.google.com/search?udm=50&q={q}',prefill:true,  zh:'AI 模式',   en:'AI Mode'},
    {id:'grok',      name:'Grok',     home:'https://grok.com/',                  url:'https://grok.com/?q={q}',                   prefill:true,  zh:'xAI',       en:'xAI'},
    {id:'deepseek',  name:'DeepSeek', home:'https://chat.deepseek.com/',         url:'https://chat.deepseek.com/?q={q}',          prefill:true,  zh:'深度求索',  en:'DeepSeek'},
    {id:'kimi',      name:'Kimi',     home:'https://www.kimi.com/',              url:'https://www.kimi.com/?p={q}',               prefill:true,  zh:'月之暗面',  en:'Moonshot'},
    {id:'gemini',    name:'Gemini',   home:'https://gemini.google.com/app',      url:'',                                         prefill:false, zh:'Google',    en:'Google'},
    {id:'muse',      name:'Muse',   home:'https://muse.ai/',                   url:'',                                         prefill:false, zh:'Meta', en:'Meta'},
    {id:'doubao',    name:'豆包',     home:'https://www.doubao.com/chat/',        url:'',                                         prefill:false, zh:'字节跳动',  en:'ByteDance'},
    {id:'tongyi',    name:'通义千问', home:'https://www.tongyi.com/',             url:'',                                         prefill:false, zh:'阿里巴巴',  en:'Alibaba'}
  ];
  var byId={};PLATFORMS.forEach(function(p){byId[p.id]=p});

  var input=document.getElementById('ai-q'),
      grid=document.getElementById('ai-grid'),
      micBtn=document.getElementById('ai-mic'),
      clearBtn=document.getElementById('ai-clear'),
      openAllBtn=document.getElementById('ai-openall');

  /* ---------- 收藏 ---------- */
  var LS_FAV='sgx-ai-fav', DEFAULT_FAV=['chatgpt','perplexity','googleai'];
  /* 旧 id 迁移：claude -> muse（2.3.13） */
  function migrateFavs(a){
    var changed=false;
    a=a.map(function(id){if(id==='claude'){changed=true;return 'muse'}return id});
    return {a:a,changed:changed};
  }
  function getFavs(){
    try{
      var v=localStorage.getItem(LS_FAV);
      if(v===null){localStorage.setItem(LS_FAV,JSON.stringify(DEFAULT_FAV));return DEFAULT_FAV.slice()}
      var a=JSON.parse(v);
      if(!Array.isArray(a))return DEFAULT_FAV.slice();
      var m=migrateFavs(a);
      if(m.changed)setFavs(m.a);
      return m.a;
    }catch(e){return DEFAULT_FAV.slice()}
  }
  function setFavs(a){try{localStorage.setItem(LS_FAV,JSON.stringify(a))}catch(e){}}
  function isFav(id){return getFavs().indexOf(id)>=0}
  function toggleFav(id){
    var favs=getFavs(),i=favs.indexOf(id);
    if(i>=0)favs.splice(i,1);else favs.push(id);
    setFavs(favs);renderGrid();
    if(window.__sgxToast)window.__sgxToast(i>=0?t('已取消收藏','Unfavorited'):t('已收藏','Favorited'));
  }

  /* ---------- 输入框：自动增高 / sessionStorage / ?q= ---------- */
  var LS_Q='sgx-ai-q';
  function autogrow(){
    input.style.height='auto';
    var lh=parseFloat(getComputedStyle(input).lineHeight)||24;
    var maxH=lh*6;
    var h=Math.min(input.scrollHeight,maxH);
    input.style.height=h+'px';
    input.style.overflowY=input.scrollHeight>maxH?'auto':'hidden';
  }
  function saveQ(){try{sessionStorage.setItem(LS_Q,input.value)}catch(e){}}
  (function initQ(){
    var q=null;
    try{q=new URLSearchParams(location.search).get('q')}catch(e){}
    if(q){input.value=q}
    else{try{var s=sessionStorage.getItem(LS_Q);if(s)input.value=s}catch(e){}}
    autogrow();
  })();
  input.addEventListener('input',function(){saveQ();autogrow()});

  clearBtn.addEventListener('click',function(){input.value='';saveQ();autogrow();input.focus()});

  /* 语音：复用 2.3.5 统一组件（含错误提示） */
  if(window.__sgxVoice){
    window.__sgxVoice(micBtn,{input:function(){return input},onResult:function(){saveQ();autogrow()}});
  }

  /* 快捷键：Ctrl/⌘+Enter 用第一个收藏平台打开；Esc 清空 */
  input.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){
      e.preventDefault();
      var f=getFavs().map(function(id){return byId[id]}).filter(Boolean)[0];
      if(f)openPlatform(f,input.value);
    }else if(e.key==='Escape'){
      input.value='';saveQ();autogrow();
    }
  });

  /* 提示词芯片：填入输入框前缀 */
  document.querySelectorAll('.ai-chip').forEach(function(ch){
    ch.addEventListener('click',function(){
      var pre=ch.getAttribute('data-chip')||'';
      var cur=input.value.replace(/^\s+/,'');
      input.value=pre+(cur?'\n'+cur:'');
      saveQ();autogrow();input.focus();
    });
  });

  /* ---------- 打开逻辑 ---------- */
  function copyThenOpen(q,done){
    function fin(ok){
      if(ok){if(window.__sgxToast)window.__sgxToast(t('问题已复制，粘贴即可','Question copied, just paste'))}
      else{
        if(window.__sgxToast)window.__sgxToast(t('复制失败，请手动复制','Copy failed, please copy manually'));
        try{input.focus();input.select()}catch(e){}
      }
      done();
    }
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(q).then(function(){fin(true)},function(){fin(false)});
      }else fin(false);
    }catch(e){fin(false)}
  }
  function openPlatform(p,q){
    q=(q||'').trim();
    var url=(p.prefill&&q)?p.url.replace('{q}',encodeURIComponent(q)):p.home;
    if(p.prefill||!q){
      window.open(url,'_blank','noopener');
      return;
    }
    /* 不支持预填：先复制问题再打开官网 */
    copyThenOpen(q,function(){window.open(url,'_blank','noopener')});
  }
  function openAll(){
    var favs=getFavs().map(function(id){return byId[id]}).filter(Boolean);
    if(!favs.length)return;
    var q=input.value.trim();
    var needCopy=q&&favs.some(function(p){return !p.prefill});
    function go(){
      favs.forEach(function(p){
        var url=(p.prefill&&q)?p.url.replace('{q}',encodeURIComponent(q)):p.home;
        window.open(url,'_blank','noopener');
      });
    }
    if(needCopy)copyThenOpen(q,go);else go();
  }
  if(openAllBtn)openAllBtn.addEventListener('click',openAll);

  /* ---------- 平台网格渲染 ---------- */
  window.__aiFavFallback=function(img,name){
    try{
      var ch=String(name||'?').trim().charAt(0)||'?';
      var s=document.createElement('span');
      s.className=img.className;s.setAttribute('aria-hidden','true');
      s.style.cssText='display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:var(--m-on-surface-variant);';
      s.textContent=ch;img.replaceWith(s);
    }catch(e){img.style.display='none'}
  };
  function cardHTML(p){
    var host=hostOf(p.home);
    var fav=isFav(p.id);
    var desc=EN?p.en:p.zh;
    return '<button type="button" class="ai-plat" role="listitem" data-id="'+p.id+'" aria-label="'+esc(p.name)+'">'
      +'<img src="https://www.google.com/s2/favicons?domain='+esc(host)+'&sz=64" alt="" loading="lazy" decoding="async" width="48" height="48" class="ai-plat-ic" onerror="__aiFavFallback(this,\''+esc(p.name).replace(/'/g,"\\'")+'\')">'
      +'<span class="ai-plat-name">'+esc(p.name)+'</span>'
      +'<span class="ai-plat-desc">'+esc(desc)+'</span>'
      +'<span class="ai-star'+(fav?' on':'')+'" aria-hidden="true">★</span>'
      +'</button>';
  }
  function renderGrid(){
    grid.innerHTML=PLATFORMS.map(cardHTML).join('');
    bindCards();
  }
  function bindCards(){
    grid.querySelectorAll('.ai-plat').forEach(function(el){
      var id=el.getAttribute('data-id'),p=byId[id];
      el.addEventListener('click',function(){openPlatform(p,input.value)});
      /* 长按收藏（触屏） */
      var timer=null,fired=false;
      function start(){fired=false;timer=setTimeout(function(){fired=true;toggleFav(id)},550)}
      function cancel(){if(timer){clearTimeout(timer);timer=null}}
      el.addEventListener('touchstart',start,{passive:true});
      el.addEventListener('touchend',cancel);
      el.addEventListener('touchmove',cancel,{passive:true});
      /* 右键收藏（桌面） */
      el.addEventListener('contextmenu',function(e){e.preventDefault();toggleFav(id)});
      /* 长按后吞掉 click */
      el.addEventListener('click',function(e){
        if(fired){e.preventDefault();e.stopPropagation();fired=false}
      },{capture:true});
    });
  }
  renderGrid();
})();