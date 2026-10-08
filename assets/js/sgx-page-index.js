(function(){
  /* 双时钟 */
  (function(){
    var root=document.getElementById('dual-clock');
    if(!root)return;
    var en=document.documentElement.lang==='en';
    var CITY={zh:{'Asia/Shanghai':'北京','Asia/Tokyo':'东京','Asia/Hong_Kong':'香港','Asia/Seoul':'首尔','Asia/Taipei':'台北','Asia/Singapore':'新加坡','Asia/Dubai':'迪拜','America/Los_Angeles':'洛杉矶','America/New_York':'纽约','America/Chicago':'芝加哥','America/Toronto':'多伦多','America/Vancouver':'温哥华','Europe/London':'伦敦','Europe/Paris':'巴黎','Europe/Berlin':'柏林','Australia/Sydney':'悉尼','Pacific/Auckland':'奥克兰'},
              en:{'Asia/Shanghai':'Beijing','Asia/Tokyo':'Tokyo','Asia/Hong_Kong':'Hong Kong','Asia/Seoul':'Seoul','Asia/Taipei':'Taipei','Asia/Singapore':'Singapore','Asia/Dubai':'Dubai','America/Los_Angeles':'Los Angeles','America/New_York':'New York','America/Chicago':'Chicago','America/Toronto':'Toronto','America/Vancouver':'Vancouver','Europe/London':'London','Europe/Paris':'Paris','Europe/Berlin':'Berlin','Australia/Sydney':'Sydney','Pacific/Auckland':'Auckland'}};
    var SUN='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    var MOON='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    function firstTz(){return window.__firstTz?window.__firstTz():'UTC'}
    function remoteTzNow(){
      /* 第二时区：localStorage 可配（设置页），默认洛杉矶；与第一时区相同时换另一个 */
      var ft=firstTz();
      var remoteTz=window.__secondTz?window.__secondTz():'America/Los_Angeles';
      if(remoteTz===ft){remoteTz=(ft==='Asia/Shanghai')?'America/Los_Angeles':'Asia/Shanghai'}
      return remoteTz;
    }
    function hour12Now(){return window.__hour12?window.__hour12():false}
    function cityName(tz){var m=en?CITY.en:CITY.zh;return m[tz]||tz.split('/').pop().replace(/_/g,' ')}
    function tzOffsetMin(tz,d){
      try{
        var utc=new Date(d.toLocaleString('en-US',{timeZone:'UTC'}));
        var tzd=new Date(d.toLocaleString('en-US',{timeZone:tz}));
        return Math.round((tzd-utc)/60000);
      }catch(e){return 0}
    }
    function parts(tz,d,h12){
      try{
        var f=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour12:h12,weekday:'short',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
        var p={};f.formatToParts(d).forEach(function(x){p[x.type]=x.value});
        var h=parseInt(p.hour,10);if(h===24)h=0;
        return {h:h,mi:p.minute,ap:p.dayPeriod||'',wd:p.weekday,mo:p.month,day:p.day};
      }catch(e){return null}
    }
    var WD_ZH={'Sun':'周日','Mon':'周一','Tue':'周二','Wed':'周三','Thu':'周四','Fri':'周五','Sat':'周六'};
    function analogMode(){try{return localStorage.getItem('sgx-gl-clockstyle')==='1'}catch(e){return false}}
    function analogSVG(h,mi,fg){
      var ha=(h%12)*30+parseInt(mi,10)*0.5, ma=parseInt(mi,10)*6;
      var ticks='';for(var i=0;i<12;i++){var a=i*30*Math.PI/180,x1=50+44*Math.sin(a),y1=50-44*Math.cos(a),x2=50+38*Math.sin(a),y2=50-38*Math.cos(a);ticks+='<line x1="'+x1.toFixed(1)+'" y1="'+y1.toFixed(1)+'" x2="'+x2.toFixed(1)+'" y2="'+y2.toFixed(1)+'" stroke="'+fg+'" stroke-width="'+(i%3===0?3:1.5)+'" stroke-linecap="round" opacity=".55"/>'}
      return '<svg viewBox="0 0 100 100" class="analog-face" aria-hidden="true"><circle cx="50" cy="50" r="47" fill="none" stroke="'+fg+'" stroke-width="2" opacity=".35"/>'+ticks
        +'<line x1="50" y1="50" x2="50" y2="28" stroke="'+fg+'" stroke-width="4.5" stroke-linecap="round" transform="rotate('+ha+' 50 50)"/>'
        +'<line x1="50" y1="50" x2="50" y2="16" stroke="'+fg+'" stroke-width="3" stroke-linecap="round" transform="rotate('+ma+' 50 50)"/>'
        +'<circle cx="50" cy="50" r="3.5" fill="'+fg+'"/></svg>';
    }
    function renderHalf(pre,tz,d,h12){
      var q=parts(tz,d,h12);if(!q)return 0;
      var isDay=q.h>=6&&q.h<18;
      document.getElementById(pre+'-icon').innerHTML=isDay?SUN:MOON;
      document.getElementById(pre+'-city').textContent=cityName(tz);
      var timeEl=document.getElementById(pre+'-time');
      if(analogMode()){
        timeEl.innerHTML=analogSVG(q.h,q.mi,isDay?'currentColor':'#ffffff');
        timeEl.classList.add('analog-on');
      }else{
        var hh=h12?(q.h%12===0?12:q.h%12):q.h;
        timeEl.classList.remove('analog-on');
        timeEl.textContent=String(hh).padStart(2,'0')+':'+q.mi+(h12?' '+q.ap:'');
      }
      document.getElementById(pre+'-date').textContent=en?(q.wd+', '+q.mo+'/'+q.day):(q.mo+'月'+q.day+'日 '+WD_ZH[q.wd]);
      var half=document.getElementById(pre==='clk-l'?'clk-l':'clk-r');
      half.classList.toggle('clock-night',!isDay);
      half.classList.toggle('clock-day',isDay);
      return q.h;
    }
    function tick(){
      var d=new Date(),h12=hour12Now(),ft=firstTz(),rtz=remoteTzNow();
      renderHalf('clk-l',ft,d,h12);
      renderHalf('clk-r',rtz,d,h12);
      var diffH=Math.round((tzOffsetMin(rtz,d)-tzOffsetMin(ft,d))/60);
      var el=document.getElementById('clk-r-diff');
      if(diffH===0){el.textContent=en?'Same time':'同一时区'}
      else if(diffH>0){el.textContent=en?diffH+' hrs ahead':'+'+diffH+' 小时'}
      else{el.textContent=en?(-diffH)+' hrs behind':diffH+' 小时'}
    }
    window.__sgxVisibleInterval(tick,60000); /* 2.3.15 B6：不可见时暂停 */
    window.addEventListener('sgx-settings-changed',tick);
  })();

  /* 天气 */
  (function(){
    var root=document.getElementById('weather');
    if(!root)return;
    var en=document.documentElement.lang==='en';
    var CACHE='sgx-weather';
    var WMO=[
      [0,'Clear','晴','☀️','🌙'],[1,'Mainly clear','晴','🌤️','🌙'],[2,'Partly cloudy','多云','⛅','☁️'],
      [3,'Overcast','阴','☁️','☁️'],[45,'Fog','雾','🌫️','🌫️'],[48,'Rime fog','雾凇','🌫️','🌫️'],
      [51,'Light drizzle','毛毛雨','🌦️','🌦️'],[53,'Drizzle','毛毛雨','🌦️','🌦️'],[55,'Heavy drizzle','大毛毛雨','🌧️','🌧️'],
      [61,'Light rain','小雨','🌧️','🌧️'],[63,'Rain','中雨','🌧️','🌧️'],[65,'Heavy rain','大雨','🌧️','🌧️'],
      [71,'Light snow','小雪','🌨️','🌨️'],[73,'Snow','中雪','🌨️','🌨️'],[75,'Heavy snow','大雪','❄️','❄️'],
      [80,'Light showers','阵雨','🌦️','🌦️'],[81,'Showers','阵雨','🌧️','🌧️'],[82,'Heavy showers','暴雨','⛈️','⛈️'],
      [95,'Thunderstorm','雷阵雨','⛈️','⛈️'],[96,'Storm with hail','冰雹','⛈️','⛈️']
    ];
    function wmoInfo(code,isDay){
      for(var i=0;i<WMO.length;i++){if(WMO[i][0]===code)return{desc:en?WMO[i][1]:WMO[i][2],icon:isDay?WMO[i][3]:WMO[i][4]}}
      return{desc:en?'Unknown':'未知',icon:'☁️'};
    }
    function bgFor(code,isDay){
      if(!isDay)return'linear-gradient(135deg,#33316e,#1c1a45)';
      if(code===0||code===1)return'linear-gradient(135deg,#4a9fe3,#1e6fc4)';
      if(code===2)return'linear-gradient(135deg,#5b8ec4,#2e5a8a)';
      if(code>=51)return'linear-gradient(135deg,#3d5f8f,#1d2f4d)';
      return'linear-gradient(135deg,#6b8aa5,#3d5a75)';
    }
    function tempUnit(){try{return localStorage.getItem('sgx-temp-unit')==='f'?'f':'c'}catch(e){return 'c'}}
    function fmtT(c){return tempUnit()==='f'?Math.round(c*9/5+32):Math.round(c)}
    function render(d,instant){
      try{if(localStorage.getItem('sgx-weather-show')==='0'){root.classList.add('hidden');return}}catch(e){}
      var cur=d.current,day=d.daily;
      var isDay=cur.is_day===1;
      var info=wmoInfo(cur.weather_code,isDay);
      root.style.background=bgFor(cur.weather_code,isDay);
      document.getElementById('wx-city').textContent=d.city||(en?'Los Angeles':'洛杉矶');
      document.getElementById('wx-temp').textContent=fmtT(cur.temperature_2m)+'°';
      document.getElementById('wx-icon').textContent=info.icon;
      document.getElementById('wx-desc').textContent=info.desc;
      var hi=fmtT(day.temperature_2m_max[0]),lo=fmtT(day.temperature_2m_min[0]);
      document.getElementById('wx-hilo').textContent=(en?'H:':'最高 ')+hi+'°  '+(en?'L:':'最低 ')+lo+'°';
      root.classList.remove('hidden');
      /* 无缓存时只淡入数字，不闪整张卡 */
      if(!instant){
        var nums=document.getElementById('wx-main');
        if(nums){nums.classList.add('wx-fade','wx-out');
          requestAnimationFrame(function(){requestAnimationFrame(function(){nums.classList.remove('wx-out')})});}
      }
    }
    window.__renderWeather=function(){
      var c=cached();
      if(c)render(c,true);
      else{try{if(localStorage.getItem('sgx-weather-show')==='0')root.classList.add('hidden')}catch(e){}}
    };
    window.addEventListener('sgx-settings-changed',window.__renderWeather);
    /* localStorage 30 分钟缓存：429/失败用上次缓存，完全没有数据时隐藏温度 */
    function cached(){
      try{var c=JSON.parse(localStorage.getItem(CACHE));if(c&&Date.now()-c.ts<30*60*1000)return c.data}catch(e){}
      return null;
    }
    function save(data){try{localStorage.setItem(CACHE,JSON.stringify({ts:Date.now(),data:data}))}catch(e){}}
    function noData(){
      /* 完全没有数据：隐藏温度数字，保留卡片占位 */
      var t=document.getElementById('wx-temp');if(t)t.style.visibility='hidden';
      var ic=document.getElementById('wx-icon');if(ic)ic.textContent='☁️';
    }
    function fetchWx(lat,lon,city){
      var u='https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1';
      return fetch(u).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(j){
        return{current:j.current,daily:j.daily,city:city};
      });
    }
    var c=cached();
    if(c){render(c,true);return}
    var LA={lat:34.05,lon:-118.24,city:null};
    fetch('/api/geo').then(function(r){return r.json()}).catch(function(){return{}})
      .then(function(g){
        var lat=parseFloat(g.latitude),lon=parseFloat(g.longitude);
        if(!isFinite(lat)||!isFinite(lon)){lat=LA.lat;lon=LA.lon}
        return fetchWx(lat,lon,g.city||null);
      })
      .then(function(d){save(d);render(d,false)})
      .catch(function(){
        /* 降级：洛杉矶天气；再失败则用缓存，完全没有数据时隐藏温度 */
        fetchWx(LA.lat,LA.lon,null).then(function(d){save(d);render(d,false)}).catch(function(){
          var old=null;
          try{var oc=JSON.parse(localStorage.getItem(CACHE));if(oc&&oc.data)old=oc.data}catch(e){}
          if(old)render(old,true);else noData();
        });
      });
  })();
  /* ===== 正在播放：真播放器（Apple 30s 试听） ===== */
  var songs=[];try{songs=JSON.parse(document.getElementById('np-data').textContent)||[]}catch(e){}
  var npW=document.getElementById('np-widget'),seedIdx=0;
  try{seedIdx=parseInt((npW&&npW.dataset.idx)||'0',10)||0}catch(e){}
  /* 上次听的歌（head 预读）优先，没有则用模板按日期固定的那首，绝不随机切换 */
  var mi=seedIdx;
  if(typeof window.__npIdx==='number'&&window.__npIdx>=0&&window.__npIdx<songs.length)mi=window.__npIdx;
  var cov=document.getElementById('np-cover'),ti=document.getElementById('np-title'),
      ar=document.getElementById('np-art'),lk=document.getElementById('np-link'),
      au=document.getElementById('np-audio'),badge=document.getElementById('np-badge'),
      prog=document.getElementById('np-prog'),bar=document.getElementById('np-bar'),
      curT=document.getElementById('np-cur'),durT=document.getElementById('np-dur'),
      btnPlay=document.getElementById('np-play'),
      icPlay=document.getElementById('np-ic-play'),icPause=document.getElementById('np-ic-pause'),icExt=document.getElementById('np-ic-ext');
  var playing=false, retried=false;
  function fmt(s){s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
  function npSave(){try{localStorage.setItem('sgx-np-idx',String(mi))}catch(e){}}
  function hasPv(){return !!(songs[mi]&&songs[mi].preview)}
  function setIcons(){
    var hp=hasPv();
    icPlay.classList.toggle('hidden',!hp||playing);
    icPause.classList.toggle('hidden',!hp||!playing);
    icExt.classList.toggle('hidden',hp);
    if(badge)badge.style.display=hp?'':'none';
    if(prog)prog.style.display=hp?'':'none';
    btnPlay.setAttribute('aria-label',hp?(playing?(document.documentElement.lang==='en'?'Pause':'暂停'):(document.documentElement.lang==='en'?'Play':'播放')):(document.documentElement.lang==='en'?'Open link':'打开链接'));
  }
  function mediaSession(){
    if(!('mediaSession' in navigator)||!songs[mi])return;
    try{
      navigator.mediaSession.metadata=new MediaMetadata({
        title:songs[mi].title||'',artist:songs[mi].artist||'',
        artwork:songs[mi].cover?[{src:songs[mi].cover,sizes:'512x512',type:'image/webp'}]:[]
      });
      navigator.mediaSession.setActionHandler('previoustrack',function(){step(-1);play()});
      navigator.mediaSession.setActionHandler('nexttrack',function(){step(1);play()});
      navigator.mediaSession.setActionHandler('play',function(){play()});
      navigator.mediaSession.setActionHandler('pause',function(){pause()});
    }catch(e){}
  }
  function dexNote(show){
    var n=document.getElementById('nav-music-note');
    if(n)n.style.display=show?'':'none';
    if(!show){var p=document.getElementById('dex-music-pop');if(p)p.classList.add('hidden')}
  }
  /* DeX 迷你窗：内容同步 + 开关 + 按钮 */
  (function(){
    var note=document.getElementById('nav-music-note'),pop=document.getElementById('dex-music-pop');
    if(!note||!pop)return;
    window.__npSyncPop=function(){
      if(!songs[mi])return;
      document.getElementById('dmp-cover').src=songs[mi].cover;
      document.getElementById('dmp-cover').alt=songs[mi].title;
      document.getElementById('dmp-title').textContent=songs[mi].title;
      document.getElementById('dmp-artist').textContent=songs[mi].artist||'';
      document.getElementById('dmp-ic-play').classList.toggle('hidden',playing);
      document.getElementById('dmp-ic-pause').classList.toggle('hidden',!playing);
    };
    note.addEventListener('click',function(e){
      e.stopPropagation();
      window.__npSyncPop&&window.__npSyncPop();
      pop.classList.toggle('hidden');
    });
    document.addEventListener('click',function(e){
      if(!pop.classList.contains('hidden')&&!e.target.closest('#dex-music-pop')&&!e.target.closest('#nav-music-note'))pop.classList.add('hidden');
    });
    document.getElementById('dmp-prev').addEventListener('click',function(){step(-1);window.__npSyncPop&&window.__npSyncPop()});
    document.getElementById('dmp-next').addEventListener('click',function(){step(1);window.__npSyncPop&&window.__npSyncPop()});
    document.getElementById('dmp-play').addEventListener('click',function(){playing?pause():play();window.__npSyncPop&&window.__npSyncPop()});
  })();
  function render(){
    if(!songs.length)return;
    var s=songs[mi];
    cov.src=s.cover;cov.alt=s.title;ti.textContent=s.title;ar.textContent=s.artist||'';lk.href=s.url;
    pause(true);
    au.removeAttribute('src');au.load();
    bar.style.width='0%';curT.textContent='0:00';durT.textContent=s.preview?'0:30':'--:--';
    retried=false;setIcons();mediaSession();
    if(window.__npSyncPop)window.__npSyncPop();
  }
  function step(d){
    mi=(mi+d+songs.length)%songs.length;npSave();render();
  }
  function play(){
    if(!hasPv()){window.open(songs[mi].url,'_blank','noopener');return}
    if(!au.src)au.src=songs[mi].preview;
    au.play().catch(function(){});
  }
  function pause(silent){
    if(!au.paused)au.pause();
    if(playing||!silent){playing=false;setIcons();dexNote(false)}
  }
  au.addEventListener('play',function(){playing=true;setIcons();dexNote(true);mediaSession();if(window.__npSyncPop)window.__npSyncPop()});
  au.addEventListener('pause',function(){playing=false;setIcons();dexNote(false);if(window.__npSyncPop)window.__npSyncPop()});
  au.addEventListener('timeupdate',function(){
    var d=au.duration||30;
    bar.style.width=Math.min(100,(au.currentTime/d)*100)+'%';
    curT.textContent=fmt(au.currentTime);durT.textContent=fmt(d);
  });
  au.addEventListener('ended',function(){
    /* 播完自动下一首，跳过没有试听的歌 */
    var n=mi;
    for(var k=0;k<songs.length;k++){n=(n+1)%songs.length;if(songs[n].preview)break}
    mi=n;npSave();render();play();
  });
  au.addEventListener('error',function(){
    /* 报错时用 iTunes lookup(JSONP)重取一次 */
    if(retried||!songs[mi]||!songs[mi].apple_id)return;
    retried=true;
    var cb='__npPv'+Date.now();
    window[cb]=function(d){
      try{
        var pu=d&&d.results&&d.results[0]&&d.results[0].previewUrl;
        if(pu){songs[mi].preview=pu;au.src=pu;au.play().catch(function(){})}
      }catch(e){}
      try{delete window[cb]}catch(e){};if(sc.parentNode)sc.remove();
    };
    var sc=document.createElement('script');
    sc.src='https://itunes.apple.com/lookup?callback='+cb+'&id='+encodeURIComponent(songs[mi].apple_id)+'&country='+encodeURIComponent(songs[mi].apple_country||'us');
    sc.onerror=function(){try{delete window[cb]}catch(e){};if(sc.parentNode)sc.remove()};
    document.head.appendChild(sc);
    setTimeout(function(){if(window[cb]){try{delete window[cb]}catch(e){};if(sc.parentNode)sc.remove()}},12000);
  });
  /* 供歌单页调用：暂停首页试听 */
  window.__npPause=function(){pause()};
  if(songs.length){
    render();
    document.getElementById('np-prev').addEventListener('click',function(){step(-1)});
    document.getElementById('np-next').addEventListener('click',function(){step(1)});
    btnPlay.addEventListener('click',function(){playing?pause():play()});
  }
  /* 首页刷新回到顶部 */
  if('scrollRestoration' in history){history.scrollRestoration='manual';}
  window.scrollTo(0,0);
})();
// 触屏：手机上用 bottom sheet 显示批注，大屏触屏仍用封面浮层
(function() {
  var isMobile=function(){return window.matchMedia('(max-width:639px)').matches};
  var en=document.documentElement.lang==='en';
  function openCommentSheet(title,comment){
    if(!window.__openSheet)return;
    window.__openSheet({title:title,html:'<p class="text-sm leading-relaxed text-m-on-surface px-1">'+comment.replace(/</g,'&lt;')+'</p>'});
  }
  if (window.matchMedia('(hover: none)').matches) {
    document.querySelectorAll('.cover-toggle').forEach(function(el) {
      var isLink = el.tagName === 'A';
      var commentEl=el.querySelector('.cover-comment p');
      var comment=commentEl?commentEl.textContent:'';
      var title=el.getAttribute('aria-label')||'';
      function toggle(e) {
        if(isMobile()&&comment){ if(e)e.preventDefault(); openCommentSheet(title,comment); return; }
        if (el.classList.contains('comment-open')) {
          if (!isLink) { el.classList.remove('comment-open'); }
        } else {
          if (e) e.preventDefault();
          document.querySelectorAll('.cover-toggle.comment-open').forEach(function(o) {
            if (o !== el) o.classList.remove('comment-open');
          });
          el.classList.add('comment-open');
        }
      }
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
      });
    });
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.cover-toggle')) {
        document.querySelectorAll('.cover-toggle.comment-open').forEach(function(o) {
          o.classList.remove('comment-open');
        });
      }
    });
  }
})();
(function(){
  var pills=document.querySelectorAll('#garden-filters .garden-pill'),
      stagePills=document.querySelectorAll('#garden-filters .stage-pill'),
      cards=document.querySelectorAll('#garden-grid .garden-card'),
      activeTag='', activeStage='',
      activeCls='rounded-full px-4 py-1.5 text-sm font-medium bg-m-primary text-m-on-primary transition-colors',
      idleCls='rounded-full px-4 py-1.5 text-sm font-medium border border-m-outline text-m-on-surface-variant hover:border-m-primary transition-colors';
  function apply(){
    cards.forEach(function(c){
      var okTag=!activeTag||c.dataset.tags.split(',').indexOf(activeTag)!==-1,
          okStage=!activeStage||c.dataset.stage===activeStage;
      c.style.display=(okTag&&okStage)?'':'none';
    });
  }
  function bind(list, kind, set){
    list.forEach(function(p){p.addEventListener('click',function(){
      list.forEach(function(x){x.className=(kind==='garden'?'garden-pill ':'stage-pill ')+idleCls});
      p.className=(kind==='garden'?'garden-pill ':'stage-pill ')+activeCls;
      set(kind==='garden'?p.dataset.tag:p.dataset.stage);
      apply();
    })});
  }
  bind(pills, 'garden', function(v){activeTag=v});
  bind(stagePills, 'stage', function(v){activeStage=v});
})();