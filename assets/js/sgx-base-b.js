/* ===== 手机悬浮 Dock：滚动隐藏 + 选中高亮块滑动 ===== */
(function(){
  var dock=document.getElementById('phone-dock'),pill=document.getElementById('dock-pill');
  if(!dock)return;
  function reduced(){return document.documentElement.classList.contains('reduced-motion')}
  /* 选中态：首页不选中任何一个 */
  function paintActive(){
    var pg=document.body.getAttribute('data-page');
    var btns=dock.querySelectorAll('.dock-btn');
    var active=null;
    btns.forEach(function(b){
      var on=b.getAttribute('data-dock')===pg;
      b.classList.toggle('dock-active',on);
      if(on)active=b;
    });
    if(active){
      pill.style.display='';
      pill.style.left=(active.offsetLeft+6)+'px';
      pill.style.width=(active.offsetWidth-12)+'px';
    }else{
      pill.style.display='none';
    }
  }
  paintActive();
  window.__sgxScroll.onResize(paintActive);
  /* 滚动时隐藏，停 0.6s 后或滚到底时出现；减弱动效时不隐藏 */
  var t=null;
  var ssBar=document.getElementById('settings-searchbar-wrap');
  function show(){dock.classList.remove('dock-hide');if(ssBar)ssBar.classList.remove('sgx-hide')}
  /* 2.3.15 B4：走全局调度器 */
  window.__sgxScroll.onScroll(function(){
    if(reduced())return;
    dock.classList.add('dock-hide');
    if(ssBar)ssBar.classList.add('sgx-hide');
    if(t)clearTimeout(t);
    t=setTimeout(show,600);
  });
  /* DeX 模式下确保隐藏（CSS 已处理，这里兜底清状态） */
  var prevHook=window.__dexLayoutChanged;
  window.__dexLayoutChanged=function(m){
    if(prevHook)prevHook(m);
    if(m!=='dex')paintActive();
  };
})();
/* ===== 桌面布局系统：resize 跟随 + 顶栏时钟/天气 + 应用抽屉 ===== */
(function(){
  var en=document.documentElement.lang==='en';
  var get=window.__sgxGet, set=window.__sgxSet;

  /* resize 时重算布局（防抖）；2.3.15 B4：走全局调度器 */
  var rt=null;
  window.__sgxScroll.onResize(function(){
    if(rt)clearTimeout(rt);
    rt=setTimeout(function(){if(window.__applyLayout)window.__applyLayout()},180);
  });

  /* ---- 顶栏时钟/日期：第一帧前写入，遵守小时制 + 第一时区设置 ---- */
  var tEl=document.getElementById('nav-time'),dEl=document.getElementById('nav-time-date');
  function fmtTz(tz,h12){
    try{return new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:!!h12}).format(new Date())}catch(e){return''}
  }
  function tickTray(){
    if(!tEl)return;
    var tz=window.__firstTz?window.__firstTz():'UTC';
    var h12=window.__hour12?window.__hour12():false;
    var s=fmtTz(tz,h12);
    if(s)tEl.textContent=s;
    var d=new Date();
    var wdzh=['周日','周一','周二','周三','周四','周五','周六'],wden=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var mp=(d.getMonth()+1),dp=d.getDate();
    dEl.textContent=en?(mp+'/'+dp+' '+wden[d.getDay()]):(mp+'月'+dp+'日 '+wdzh[d.getDay()]);
  }
  window.__sgxVisibleInterval(tickTray,15000); /* 2.3.15 B6：不可见时暂停 */
  window.addEventListener('sgx-settings-changed',tickTray);

  /* ---- 当前页面：DeX Dock 图标下方小圆点 ---- */
  (function(){
    var pg=document.body.getAttribute('data-page');
    if(!pg)return;
    document.querySelectorAll('#dex-dock [data-navpage]').forEach(function(a){
      if(a.getAttribute('data-navpage')===pg)a.classList.add('dex-dock-active');
    });
  })();

  /* ---- 顶栏天气（图标 + 温度）：localStorage 30 分钟缓存；429/失败用上次缓存；完全没有数据时隐藏温度 ---- */
  (function(){
    var icEl=document.getElementById('nav-wx-ic'),tEl2=document.getElementById('nav-wx-t');
    var btn=document.getElementById('nav-wx');
    if(!icEl||!tEl2||!btn)return;
    var WXI={0:'☀️',1:'🌤️',2:'⛅',3:'☁️',45:'🌫️',48:'🌫️',51:'🌦️',53:'🌦️',55:'🌧️',61:'🌧️',63:'🌧️',65:'🌧️',71:'🌨️',73:'🌨️',75:'❄️',80:'🌦️',81:'🌧️',82:'⛈️',95:'⛈️',96:'⛈️'};
    function cachedFresh(){try{var c=JSON.parse(localStorage.getItem('sgx-weather'));if(c&&Date.now()-c.ts<30*60*1000)return c.data}catch(e){}return null}
    function cachedAny(){try{var c=JSON.parse(localStorage.getItem('sgx-weather'));if(c&&c.data)return c.data}catch(e){}return null}
    function save(d){try{localStorage.setItem('sgx-weather',JSON.stringify({ts:Date.now(),data:d}))}catch(e){}}
    function fmtT(c){var unit='c';try{unit=get('sgx-temp-unit')==='f'?'f':'c'}catch(e){}return unit==='f'?Math.round(c*9/5+32):Math.round(c)}
    function render(d){
      if(!d||!d.current)return;
      icEl.textContent=WXI[d.current.weather_code]||'☁️';
      tEl2.textContent=fmtT(d.current.temperature_2m)+'°';
      btn.style.display='';
      btn.title=(d.city||'')+(en?' weather':' 天气');
      renderWxPop(d);
    }
    function hide(){btn.style.display='none'}
    /* 天气面板内容 */
    function renderWxPop(d){
      var pop=document.getElementById('nav-wx-pop');
      if(!pop||!d||!d.current)return;
      var cur=d.current,day=d.daily;
      var h='<div class="wxp-city">'+((d.city||'').replace(/</g,'&lt;')||(en?'Weather':'天气'))+'</div>'
        +'<div class="wxp-main"><span class="wxp-ic">'+(WXI[cur.weather_code]||'☁️')+'</span>'
        +'<span class="wxp-temp clock-num">'+fmtT(cur.temperature_2m)+'°</span></div>';
      if(day&&day.temperature_2m_max&&day.temperature_2m_min){
        h+='<div class="wxp-hilo">'+(en?'H:':'最高 ')+fmtT(day.temperature_2m_max[0])+'°  '+(en?'L:':'最低 ')+fmtT(day.temperature_2m_min[0])+'°</div>';
      }
      pop.innerHTML='<div class="dex-pop-card">'+h+'</div>';
    }
    var c=cachedFresh();if(c){render(c)}
    /* 和首页小组件共用一份缓存；首页会负责拉取，这里只做兜底拉取 */
    if(!c){
      fetch('/api/geo').then(function(r){return r.json()}).catch(function(){return{}}).then(function(g){
        var lat=parseFloat(g.latitude),lon=parseFloat(g.longitude);
        if(!isFinite(lat)||!isFinite(lon))throw 0;
        return fetch('https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1')
          .then(function(r){if(!r.ok)throw 0;return r.json()})
          .then(function(j){var d={current:j.current,daily:j.daily,city:g.city||''};save(d);render(d)});
      }).catch(function(){
        /* 失败用上次缓存（不限 30 分钟），完全没有数据才隐藏 */
        var old=cachedAny();
        if(old)render(old);else hide();
      });
    }
    window.addEventListener('sgx-settings-changed',function(){var cc=cachedFresh();if(cc)render(cc)});
    /* 天气面板：从顶栏往下展开 */
    window.__toggleWxPop=function(e){
      var pop=document.getElementById('nav-wx-pop');
      if(!pop)return;
      if(e)e.stopPropagation();
      var cc=cachedFresh()||cachedAny();
      if(cc)renderWxPop(cc);
      pop.classList.toggle('open');
    };
    btn.addEventListener('click',window.__toggleWxPop);
    document.addEventListener('click',function(e){
      var pop=document.getElementById('nav-wx-pop');
      if(pop&&pop.classList.contains('open')&&!pop.contains(e.target)&&!btn.contains(e.target))pop.classList.remove('open');
    });
    document.addEventListener('keydown',function(e){
      if(e.key==='Escape'){var pop=document.getElementById('nav-wx-pop');if(pop)pop.classList.remove('open')}
    });
  })();

  /* ---- DeX 应用抽屉（底部 Dock 按钮，从 Dock 上方往上展开） ---- */
  (function(){
    var dr=document.getElementById('dex-drawer'),btn=document.getElementById('dex-dock-drawer'),
        input=document.getElementById('dex-drawer-search'),grid=document.getElementById('dex-drawer-grid');
    if(!dr||!btn)return;
    function open(){
      dr.classList.remove('hidden');
      requestAnimationFrame(function(){requestAnimationFrame(function(){dr.classList.add('open')})});
      setTimeout(function(){if(input)input.focus()},80);
    }
    function close(){
      dr.classList.remove('open');
      setTimeout(function(){if(!dr.classList.contains('open'))dr.classList.add('hidden')},240);
    }
    window.__closeDexDrawer=close;
    window.__dexDrawerOpen=function(){return dr.classList.contains('open')};
    btn.addEventListener('click',function(e){e.stopPropagation();dr.classList.contains('open')?close():open()});
    dr.querySelectorAll('[data-dex-drawer-close]').forEach(function(el){el.addEventListener('click',close)});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&dr.classList.contains('open'))close()});
    if(input)input.addEventListener('input',function(){
      var q=input.value.trim().toLowerCase();
      grid.querySelectorAll('a').forEach(function(a){
        a.style.display=(!q||(a.dataset.name||'').toLowerCase().indexOf(q)!==-1)?'':'none';
      });
    });
    /* 抽屉内跳转：主页用普通跳转，子页面用 replace（与 Dock 一致） */
    grid.addEventListener('click',function(e){
      var a=e.target.closest&&e.target.closest('a[href]');
      if(!a||a.target==='_blank')return;
      var p=location.pathname;
      var isHome=(p==='/'||p==='/en'||p==='/en/');
      if(isHome)return;
      e.preventDefault();location.replace(a.getAttribute('href'));
    });
  })();

  /* ---- 顶栏时钟面板（双时钟 + 日历，从顶栏往下展开） ---- */
  (function(){
    var pop=document.getElementById('dex-clock-pop'),btn=document.getElementById('nav-time-center');
    if(!pop||!btn)return;
    var TZN={zh:{'Asia/Shanghai':'北京','America/Los_Angeles':'洛杉矶','America/New_York':'纽约','Europe/London':'伦敦','Asia/Tokyo':'东京','Asia/Hong_Kong':'香港','Asia/Seoul':'首尔'},
             en:{'Asia/Shanghai':'Beijing','America/Los_Angeles':'Los Angeles','America/New_York':'New York','Europe/London':'London','Asia/Tokyo':'Tokyo','Asia/Hong_Kong':'Hong Kong','Asia/Seoul':'Seoul'}};
    function tzName(tz){var m=en?TZN.en:TZN.zh;var v=m[tz];return v||tz.split('/').pop().replace(/_/g,' ')}
    var fmtTz=window.__sgxFmtTz;
    function calendar(){
      var d=new Date(),y=d.getFullYear(),mo=d.getMonth();
      var first=new Date(y,mo,1).getDay(),days=new Date(y,mo+1,0).getDate();
      var h='<div class="dex-cal-h">'+y+(en?'/':'年')+(mo+1)+(en?'':'月')+'</div><div class="dex-cal-g">';
      (en?['S','M','T','W','T','F','S']:['日','一','二','三','四','五','六']).forEach(function(w){h+='<span class="dex-cal-w">'+w+'</span>'});
      for(var i=0;i<first;i++)h+='<span></span>';
      for(var dd=1;dd<=days;dd++)h+='<span class="dex-cal-d'+(dd===d.getDate()?' today':'')+'">'+dd+'</span>';
      return h+'</div>';
    }
    function render(){
      var local=window.__firstTz?window.__firstTz():'UTC';
      var r=window.__secondTz?window.__secondTz():'America/Los_Angeles';
      if(r===local)r=(local==='Asia/Shanghai')?'America/Los_Angeles':'Asia/Shanghai';
      var h12=window.__hour12?window.__hour12():false;
      document.getElementById('dex-pop-local').textContent=fmtTz(local,h12);
      document.getElementById('dex-pop-local-c').textContent=tzName(local);
      document.getElementById('dex-pop-r').textContent=fmtTz(r,h12);
      document.getElementById('dex-pop-r-c').textContent=tzName(r);
      document.getElementById('dex-pop-cal').innerHTML=calendar();
    }
    function open(){render();pop.classList.remove('hidden');pop.classList.add('open')}
    function close(){pop.classList.remove('open');pop.classList.add('hidden')}
    window.__closeDexClock=close;
    function toggle(e){if(e)e.stopPropagation();pop.classList.contains('open')?close():open()}
    btn.addEventListener('click',toggle);
    document.addEventListener('click',function(e){if(pop.classList.contains('open')&&!pop.contains(e.target))close()});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&pop.classList.contains('open'))close()});
  })();

  /* ---- 离开 dex 模式时关闭所有浮层 ---- */
  var prevHook=window.__dexLayoutChanged;
  window.__dexLayoutChanged=function(m){
    if(prevHook)prevHook(m);
    if(m!=='dex'){
      if(window.__closeDexDrawer)window.__closeDexDrawer();
      if(window.__closeDexClock)window.__closeDexClock();
    }
  };
})();