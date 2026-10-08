/* ===== 全站搜索：统一走 /browser/ ===== */
(function(){
  var en=document.documentElement.lang==='en';
  var bUrl=en?'/en/browser/':'/browser/';
  window.__openSearch=function(){ location.href=bUrl+'#focus'; };
  function goBrowser(){ location.href=bUrl+'#focus'; }
  document.addEventListener('keydown',function(e){
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){
      var t=e.target;
      if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable))return;
      e.preventDefault();goBrowser();
    }
  });
})();
/* ===== 返回逻辑：一级 App 一次回主页，二级回一级；Dock 切换不累积历史 ===== */
(function(){
  var en=document.documentElement.lang==='en';
  var home=en?'/en/':'/';
  var PRIMARY={'/browser/':1,'/en/browser/':1,'/files/':1,'/en/files/':1,'/settings/':1,'/en/settings/':1,
    '/books/':1,'/en/books/':1,'/music/':1,'/en/music/':1,'/goodlock/':1,'/en/goodlock/':1};
  function isFilesType(){
    var p=location.pathname;
    return (p==='/files/'||p==='/en/files/')&&location.search.indexOf('type=')!==-1;
  }
  function parentOf(){
    var p=location.pathname;
    /* 二级页面：/files/?type=xxx 回 /files/ */
    if(p==='/files/'||p==='/en/files/')return en?'/en/files/':'/files/';
    return home;
  }
  function goBack(){
    if(isFilesType()){location.replace(en?'/en/files/':'/files/');return}
    var p=location.pathname;
    if(PRIMARY[p]){location.replace(home);return}
    location.replace(parentOf());
  }
  /* 事件委托：按钮在 <main> 里，脚本可能先执行 */
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('[data-go-back]');
    if(b){e.preventDefault();goBack()}
  });
  /* Dock 在 App 之间切换：子页面用 replace 不累积历史；主页用普通跳转保留历史。
     目标：任意 Dock 切换后 history.length 不超过「进入前 +1」，系统返回一次回主页。 */
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('#phone-dock a[href],#dex-dock a[href]');
    if(!a)return;
    var p=location.pathname;
    var isHome=(p==='/'||p==='/en'||p==='/en/');
    if(isHome)return; /* 主页：不拦截，普通跳转 */
    e.preventDefault();location.replace(a.getAttribute('href'));
  });
  /* 直接打开 App 页：最多插入一次主页历史，保证系统返回一次回到主页。
     历史永远只有「主页 → 当前 App」两条，再返回一次就离开网站。
     判断：referrer 为空或站外；sessionStorage 防重复插入（刷新不重复插）。 */
  (function(){
    if(!document.body.classList.contains('subpage'))return;
    var ref='';try{ref=document.referrer||''}catch(e){}
    var ext=true;
    try{ext=!ref||new URL(ref).origin!==location.origin}catch(e){}
    var done=false;
    try{done=sessionStorage.getItem('sgx-hist-root')==='1'}catch(e){}
    if(!ext||done)return;
    try{
      var p=location.pathname;
      var isFT=(p==='/files/'||p==='/en/files/')&&location.search.indexOf('type=')!==-1;
      var parent=isFT?(en?'/en/files/':'/files/'):home;
      var curUrl=location.pathname+location.search+location.hash; /* 先保存：replaceState 会改掉 location */
      history.replaceState({sgxRoot:1},'',parent);
      history.pushState({sgxHere:1},'',curUrl);
      sessionStorage.setItem('sgx-hist-root','1');
    }catch(e){}
  })();
  /* 2.3.14.7：大标题滚动联动动画（跟滚动位置联动，不是定时动画）。
     - 上滚：大标题随滚动上移最多 24px，同时透明度 1→0；标题区滚过约一半时完全消失。不缩放、不变字号。
     - 大标题完全消失后，小标题才开始出现（透明度 0→1，带 6px 从下往上位移）。两者不重叠、不同时可见。
     - 下拉：反过来，小标题先淡出，大标题回位淡入。
     - 只改 opacity 和 transform，不改高度、不触发重排；passive + rAF；减少动画时只做淡入淡出。
     悬浮返回键保持原来的二值 show 逻辑；页面太短不能滚动时全部复位不显示。 */
  function initBackFloat(){
    var head=document.querySelector('[data-subpage-head]');
    var floats=document.querySelectorAll('.subpage-back-float');
    var minis=document.querySelectorAll('.subpage-mini-title');
    if(!head||(!floats.length&&!minis.length))return;
    var hero=head.querySelector('.subpage-hero');
    function reduced(){
      return document.documentElement.classList.contains('reduced-motion')||
        (window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }
    function onScroll(y){
      var headH=head.offsetHeight||1;
      var canScroll=document.documentElement.scrollHeight>window.innerHeight+10;
      var rm=reduced();
      /* 大标题：滚动 0 → 标题区一半，透明度 1→0，上移最多 24px */
      if(hero){
        var hp=canScroll?Math.min(Math.max(y/(headH*0.5),0),1):0;
        hero.style.opacity=String(1-hp);
        hero.style.transform=rm?'':'translateY('+(-24*hp).toFixed(1)+'px)';
      }
      /* 小标题：大标题完全消失（0.5）之后才开始出现，0.5→0.7 区间淡入 */
      var mp=canScroll?Math.min(Math.max((y-headH*0.5)/(headH*0.2),0),1):0;
      minis.forEach(function(m){
        m.style.opacity=String(mp);
        m.style.transform=rm?'translateX(-50%)':'translateX(-50%) translateY('+(6*(1-mp)).toFixed(1)+'px)';
      });
      /* 悬浮返回键：保持原来的二值逻辑 */
      var show=canScroll&&y>headH*0.55;
      floats.forEach(function(f){f.classList.toggle('show',!!show)});
      /* 滚动后小标题/返回键与顶栏合并为同一层模糊底 */
      document.body.classList.toggle('subpage-scrolled',!!show);
    }
    /* 2.3.15 B4：走全局调度器（只读分发下来的 y，不自己读 scrollY） */
    window.__sgxScroll.onScroll(onScroll);
    window.__sgxScroll.onResize(function(){onScroll(window.scrollY||0);});
    onScroll(window.scrollY||0);
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',initBackFloat);
  }else{
    initBackFloat();
  }
  /* 2.3.14.5：一级页折叠态返回键：有站内上一页就 history.back()，否则回对应语言首页 */
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('[data-back-top]');
    if(!b)return;
    e.preventDefault();
    var same=false;
    try{var r=document.referrer;same=!!r&&new URL(r).origin===location.origin;}catch(_){}
    if(same){history.back();}
    else{location.href=(document.documentElement.lang==='en')?'/en/':'/';}
  });
})();

/* ===== 主题模式（浅色/深色/跟随系统）===== */
window.__applyTheme=function(){
  var m=null;try{m=localStorage.getItem('sgx-theme-mode')}catch(e){}
  var dark=m==='dark'||((!m||m==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark',dark);
  return dark;
};
window.__setThemeMode=function(mode){
  try{
    if(mode==='system'){localStorage.removeItem('sgx-theme-mode')}
    else{localStorage.setItem('sgx-theme-mode',mode)}
  }catch(e){}
  window.__applyTheme();
  window.dispatchEvent(new Event('sgx-theme-changed'));
};
try{
  var mq=window.matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener||mq.addListener).call(mq,'change',function(){
    var m=null;try{m=localStorage.getItem('sgx-theme-mode')}catch(e){}
    if(!m||m==='system')window.__applyTheme();
  });
}catch(e){}

/* ===== 通用 bottom sheet ===== */
(function(){
  var wrap=document.getElementById('sheet-wrap'),panel=document.getElementById('sheet-panel'),
      title=document.getElementById('sheet-title'),body=document.getElementById('sheet-body');
  function close(){wrap.classList.remove('open');wrap.classList.add('closing');setTimeout(function(){wrap.classList.remove('closing');if(!wrap.classList.contains('open'))wrap.classList.add('hidden')},260)}
  window.__closeSheet=close;
  window.__openSheet=function(opts){
    opts=opts||{};
    wrap.classList.remove('closing');
    title.textContent=opts.title||'';
    title.style.display=opts.title?'':'none';
    body.innerHTML='';
    if(opts.html){
      var d=document.createElement('div');d.className='px-3 pb-2';d.innerHTML=opts.html;body.appendChild(d);
    }else{
      (opts.options||[]).forEach(function(o){
        var b=document.createElement('button');
        b.className='sheet-opt';b.setAttribute('type','button');
        b.innerHTML='<span class="flex-1 min-w-0"><span class="block font-medium truncate">'+o.label+'</span>'
          +(o.sub?'<span class="block text-xs text-m-on-surface-variant truncate">'+o.sub+'</span>':'')+'</span>'
          +(o.checked?'<span class="text-m-primary">✓</span>':'');
        b.addEventListener('click',function(){close();if(opts.onPick)opts.onPick(o.value)});
        body.appendChild(b);
      });
    }
    wrap.classList.remove('hidden');
    requestAnimationFrame(function(){requestAnimationFrame(function(){wrap.classList.add('open')})});
  };
  wrap.querySelectorAll('[data-sheet-close]').forEach(function(el){el.addEventListener('click',close)});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!wrap.classList.contains('hidden'))close()});
  /* 手机下滑关闭 */
  var sy=null;
  panel.addEventListener('touchstart',function(e){if(e.touches.length===1)sy=e.touches[0].clientY},{passive:true});
  panel.addEventListener('touchmove',function(e){
    if(sy===null||e.touches.length!==1)return;
    var dy=e.touches[0].clientY-sy;
    if(dy>90&&panel.scrollTop<=0&&window.matchMedia('(max-width:639px)').matches){sy=null;close()}
  },{passive:true});
})();

/* ===== 搜索手机右滑关闭：见上方搜索 IIFE ===== */
/* ===== 双击顶栏回顶部（One UI 习惯）===== */
(function(){
  var nav=document.getElementById('site-nav');
  if(!nav)return;
  var lastTap=0;
  nav.addEventListener('dblclick',function(e){
    /* 双击顶栏空白处或标题时回顶部；点击按钮/链接时不触发 */
    if(e.target.closest('button')||e.target.closest('a'))return;
    window.scrollTo({top:0,behavior:'smooth'});
  });
  /* 移动端 touch 双击 */
  nav.addEventListener('touchend',function(e){
    if(e.target.closest('button')||e.target.closest('a'))return;
    var now=Date.now();
    if(now-lastTap<350){
      e.preventDefault();
      window.scrollTo({top:0,behavior:'smooth'});
      lastTap=0;
    }else{lastTap=now}
  },{passive:false});
})();
/* ===== Good Lock 实验室：全站生效的模块 ===== */
(function(){
  var en=document.documentElement.lang==='en';
  var get=window.__sgxGet, set=window.__sgxSet;
  function modOn(key,defOn){var v=get(key);return defOn?(v!=='0'):(v==='1')}
  function reduced(){return document.documentElement.classList.contains('reduced-motion')||(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)}

  /* ---- 视差壁纸 ---- */
  function parallaxOn(){return modOn('sgx-gl-parallax',false)}
  function applyParallax(x,y){
    if(!parallaxOn()||reduced())return;
    var __wp=document.getElementById('sgx-wallpaper');if(__wp)__wp.style.backgroundPosition=x.toFixed(1)+'px '+y.toFixed(1)+'px';
  }
  if(parallaxOn()&&!reduced()){
    var raf=null,lx=0,ly=0;
    window.addEventListener('mousemove',function(e){
      lx=(e.clientX/window.innerWidth-0.5)*22;ly=(e.clientY/window.innerHeight-0.5)*22;
      if(!raf)raf=requestAnimationFrame(function(){raf=null;applyParallax(lx,ly)});
    },{passive:true});
    window.addEventListener('deviceorientation',function(e){
      if(e.gamma===null||e.beta===null)return;
      applyParallax(e.gamma*0.35,e.beta*0.2);
    },{passive:true});
  }

  /* ---- 点击音效（Web Audio 合成） ---- */
  function blip(){
    try{
      var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
      var ctx=window.__glAC||(window.__glAC=new AC());
      if(ctx.state==='suspended')ctx.resume();
      var o=ctx.createOscillator(),g=ctx.createGain(),t=ctx.currentTime;
      o.type='sine';o.frequency.setValueAtTime(1250,t);o.frequency.exponentialRampToValueAtTime(880,t+0.05);
      g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(0.06,t+0.008);g.gain.exponentialRampToValueAtTime(0.0001,t+0.09);
      o.connect(g);g.connect(ctx.destination);o.start(t);o.stop(t+0.1);
    }catch(e){}
  }
  document.addEventListener('click',function(e){
    if(!modOn('sgx-gl-sound',false))return;
    if(e.target.closest&&e.target.closest('.app-tile,.dock-btn,.nav-act'))blip();
  },{passive:true});

  /* ---- 快捷键（桌面端） ---- */
  (function(){
    var pending=false,timer=null;
    document.addEventListener('keydown',function(e){
      if(!modOn('sgx-gl-keys',false))return;
      var t=e.target;
      if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable))return;
      if(e.metaKey||e.ctrlKey||e.altKey)return;
      var home=en?'/en/':'/',links=en?'/en/browser/':'/browser/',set=en?'/en/settings/':'/settings/';
      if(pending){
        pending=false;if(timer)clearTimeout(timer);
        var map={'h':home,'l':links,'b':'https://blog.styrigx.com','s':set};
        var u=map[e.key];
        if(u){e.preventDefault();if(u.indexOf('http')===0)window.open(u,'_blank');else location.href=u}
        return;
      }
      if(e.key==='g'){pending=true;timer=setTimeout(function(){pending=false},900)}
      else if(e.key==='?'){
        e.preventDefault();
        if(window.__openSheet)window.__openSheet({title:en?'Keyboard shortcuts':'快捷键',html:
          '<div class="px-2 pb-2 text-sm space-y-2">'
          +'<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">h</kbd></span><span class="text-m-on-surface-variant">'+(en?'Home':'首页')+'</span></div>'
          +'<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">l</kbd></span><span class="text-m-on-surface-variant">'+(en?'Internet':'浏览器')+'</span></div>'
          +'<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">b</kbd></span><span class="text-m-on-surface-variant">'+(en?'Blog':'博客')+'</span></div>'
          +'<div class="flex justify-between"><span><kbd class="kbd">g</kbd> <kbd class="kbd">s</kbd></span><span class="text-m-on-surface-variant">'+(en?'Settings':'设置')+'</span></div>'
          +'</div>'});
      }
    });
  })();

  /* ---- 边缘光效 ---- */
  if(modOn('sgx-gl-edgeglow',false)){document.body.classList.add('gl-edgeglow')}

  /* ---- 访客数字健康（只存本地） ---- */
  function dayStr(d){return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()}
  function areaOf(){var p=location.pathname;
    if(p==='/goodlock/'||p==='/en/goodlock/')return 'goodlock';
    if(p==='/settings/'||p==='/en/settings/')return 'settings';
    if(p==='/browser/'||p==='/en/browser/')return 'browser';
    return 'home';}
  var today=dayStr(new Date()),sessStart=Date.now(),sessArea=areaOf();
  function wellLoad(){try{var v=JSON.parse(get('sgx-well-v')||'null');if(v&&v.day===today)return v}catch(e){}return{day:today,min:0,areas:{}}}
  function wellSave(v){set('sgx-well-v',JSON.stringify(v))}
  function wellFlush(){var v=wellLoad(),add=(Date.now()-sessStart)/60000;v.min+=add;v.areas[sessArea]=(v.areas[sessArea]||0)+add;sessStart=Date.now();wellSave(v);return v}
  window.addEventListener('pagehide',wellFlush);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')wellFlush();else sessStart=Date.now()});
  window.__wellLoad=wellLoad;window.__wellFlush=wellFlush;
  /* 15 分钟温和提示（每天一次） */
  function showTip(){
    var txt=en?"You've been here 15 minutes, time for a stretch?":"已经看了 15 分钟，起来活动一下？";
    var t=document.createElement('div');
    t.id='well-toast';t.setAttribute('role','status');
    t.innerHTML='<span class="flex-1">'+txt+'</span><button type="button" id="well-toast-x" aria-label="'+(en?'Dismiss':'关闭')+'" class="w-9 h-9 -m-1 rounded-full flex items-center justify-center shrink-0">✕</button>';
    document.body.appendChild(t);
    requestAnimationFrame(function(){t.classList.add('show')});
    function hide(){t.classList.remove('show');setTimeout(function(){t.remove()},300)}
    document.getElementById('well-toast-x').addEventListener('click',hide);
    setTimeout(hide,12000);
  }
  function checkTip(){
    if(!modOn('sgx-gl-wellbeing',true))return;
    if(get('sgx-well-tip')==='0')return;
    if(get('sgx-well-tipday')===today)return;
    var v=wellLoad(),total=v.min+(Date.now()-sessStart)/60000;
    if(total>=15){set('sgx-well-tipday',today);showTip()}
  }
  window.__sgxVisibleInterval(checkTip,30000); /* 2.3.15 B6：不可见时暂停 */

  /* ---- 设置变更时重应用 ---- */
  window.addEventListener('sgx-settings-changed',function(){
    document.body.classList.toggle('gl-edgeglow',modOn('sgx-gl-edgeglow',false));
    if(parallaxOn()&&reduced()){var __wp2=document.getElementById('sgx-wallpaper');if(__wp2)__wp2.style.backgroundPosition='';}
  });
})();
/* ===== 应用商店功能开关（2.3.7）：sgx-apps-hidden =====
   未安装的应用不在首页网格、抽屉、浏览器搜索出现；商店里仍列出；直接访问 URL 可用。
   切换后触发 sgx-settings-changed，各处即时生效不刷新。 */
window.__sgxHiddenApps=function(){
  try{var v=JSON.parse(localStorage.getItem('sgx-apps-hidden')||'[]');return Array.isArray(v)?v:[]}catch(e){return[]}
};
window.__sgxSetAppHidden=function(id,hidden){
  try{
    var h=window.__sgxHiddenApps();
    var i=h.indexOf(id);
    if(hidden&&i===-1)h.push(id);
    if(!hidden&&i!==-1)h.splice(i,1);
    localStorage.setItem('sgx-apps-hidden',JSON.stringify(h));
  }catch(e){}
  window.dispatchEvent(new Event('sgx-settings-changed'));
};
/* 应用抽屉 + 首页网格按 hidden 过滤 */
window.__sgxApplyAppVisibility=function(){
  var h=window.__sgxHiddenApps();
  document.querySelectorAll('[data-appid]').forEach(function(el){
    var id=el.getAttribute('data-appid');
    el.style.display=h.indexOf(id)!==-1?'none':'';
  });
};
window.addEventListener('sgx-settings-changed',window.__sgxApplyAppVisibility);
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',window.__sgxApplyAppVisibility);
}else{
  window.__sgxApplyAppVisibility();
}
/* ===== 统一搜索条共享：toast + 语音搜索（2.3.5） ===== */
window.__sgxToast=(function(){
  var el=null,timer=null;
  return function(msg){
    if(!msg)return;
    if(!el){el=document.createElement('div');el.className='sgx-toast';el.setAttribute('role','status');document.body.appendChild(el)}
    el.textContent=msg;
    el.classList.add('show');
    if(timer)clearTimeout(timer);
    timer=setTimeout(function(){el.classList.remove('show')},3000);
  };
})();
/* 统一语音搜索：
   btn 麦克风按钮；opts: {input(元素或返回元素的函数), lang?, beforeStart?, onResult(txt)?}
   - 点击：按钮变主色+脉冲，占位变"正在聆听…"；再点停止
   - onresult：填入输入框并回调；onerror：按错误码 toast；8s 无结果自动停
   - 不支持 SpeechRecognition 时隐藏按钮 */
window.__sgxVoice=function(btn,opts){
  opts=opts||{};
  if(!btn)return;
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){btn.style.display='none';return}
  btn.style.display='';
  var en=document.documentElement.lang==='en';
  var rec=null,listening=false,stopTimer=null;
  function inputEl(){var i=opts.input;return typeof i==='function'?i():(i||null)}
  function setUI(on){
    listening=on;
    btn.classList.toggle('sgx-mic-on',on);
    if(on){btn.setAttribute('aria-pressed','true')}else{btn.removeAttribute('aria-pressed')}
    var ip=inputEl();
    if(ip){
      if(on){
        if(ip.getAttribute('data-sgx-ph')===null)ip.setAttribute('data-sgx-ph',ip.getAttribute('placeholder')||'');
        ip.setAttribute('placeholder',en?'Listening…':'正在聆听…');
      }else{
        var p=ip.getAttribute('data-sgx-ph');
        if(p!==null)ip.setAttribute('placeholder',p);
      }
    }
  }
  function stop(){
    if(stopTimer){clearTimeout(stopTimer);stopTimer=null}
    try{if(rec)rec.stop()}catch(e){}
    rec=null;
    if(listening)setUI(false);
  }
  function toggle(e){
    if(e){e.stopPropagation();if(e.preventDefault)e.preventDefault()}
    if(listening){stop();return}
    if(opts.beforeStart){try{opts.beforeStart()}catch(err){}}
    try{
      rec=new SR();
      rec.lang=en?'en-US':'zh-CN';
      rec.interimResults=false;rec.maxAlternatives=1;
      rec.onresult=function(ev){
        var txt='';
        try{txt=String((ev.results[0][0].transcript||'')).trim()}catch(err){}
        stop();
        if(txt){
          var ip=inputEl();
          if(ip)ip.value=txt;
          if(opts.onResult){try{opts.onResult(txt)}catch(err){}}
        }else{
          window.__sgxToast(en?"Didn't catch that":'没听到声音');
        }
      };
      rec.onerror=function(ev){
        var c=(ev&&ev.error)||'';
        stop();
        if(c==='not-allowed'){
          window.__sgxToast(en?'Please allow microphone access':'请允许麦克风权限');
        }else if(c==='network'||c==='service-not-allowed'){
          window.__sgxToast(en?"Voice recognition unavailable, try your keyboard's mic":'当前浏览器语音识别不可用，可以用键盘上的麦克风');
        }else if(c==='no-speech'){
          window.__sgxToast(en?"Didn't catch that":'没听到声音');
        }
      };
      rec.onend=function(){if(listening){rec=null;setUI(false)}};
      setUI(true);
      rec.start();
      stopTimer=setTimeout(stop,8000);
    }catch(err){stop()}
  }
  btn.addEventListener('click',toggle);
  if(btn.tagName!=='BUTTON'){
    btn.addEventListener('keydown',function(e){
      if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle(e)}
    });
  }
};