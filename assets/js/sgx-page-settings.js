(function(){
  var en=document.documentElement.lang==='en';
  var $=function(id){return document.getElementById(id)};
  var get=window.__sgxGet, set=window.__sgxSet;
  var CHEVR='<svg width="18" height="18" class="w-[18px] h-[18px] text-m-on-surface-variant shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>';
  function setSwitch(id,on){var el=$(id);if(el)el.setAttribute('aria-checked',on?'true':'false')}
  function rowToggle(id,fn){
    var r=$(id);if(!r)return;
    r.addEventListener('click',fn);
    r.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();fn()}});
  }
  var appSheetRow=rowToggle;

  /* ---- 时区列表（两边共用） ---- */
  var TZS=[
    {id:'Asia/Shanghai',zh:'北京',en:'Beijing'},
    {id:'Asia/Taipei',zh:'台北',en:'Taipei'},
    {id:'Asia/Hong_Kong',zh:'香港',en:'Hong Kong'},
    {id:'Asia/Tokyo',zh:'东京',en:'Tokyo'},
    {id:'Asia/Seoul',zh:'首尔',en:'Seoul'},
    {id:'Asia/Singapore',zh:'新加坡',en:'Singapore'},
    {id:'Asia/Bangkok',zh:'曼谷',en:'Bangkok'},
    {id:'Asia/Dubai',zh:'迪拜',en:'Dubai'},
    {id:'Asia/Kolkata',zh:'加尔各答',en:'Kolkata'},
    {id:'Asia/Karachi',zh:'卡拉奇',en:'Karachi'},
    {id:'Europe/Moscow',zh:'莫斯科',en:'Moscow'},
    {id:'Europe/Berlin',zh:'柏林',en:'Berlin'},
    {id:'Europe/Paris',zh:'巴黎',en:'Paris'},
    {id:'Europe/London',zh:'伦敦',en:'London'},
    {id:'America/New_York',zh:'纽约',en:'New York'},
    {id:'America/Chicago',zh:'芝加哥',en:'Chicago'},
    {id:'America/Denver',zh:'丹佛',en:'Denver'},
    {id:'America/Los_Angeles',zh:'洛杉矶',en:'Los Angeles'},
    {id:'America/Anchorage',zh:'安克雷奇',en:'Anchorage'},
    {id:'Pacific/Honolulu',zh:'檀香山',en:'Honolulu'},
    {id:'America/Toronto',zh:'多伦多',en:'Toronto'},
    {id:'America/Vancouver',zh:'温哥华',en:'Vancouver'},
    {id:'Australia/Sydney',zh:'悉尼',en:'Sydney'},
    {id:'Pacific/Auckland',zh:'奥克兰',en:'Auckland'}
  ];
  function tzLabel(id){
    for(var i=0;i<TZS.length;i++){if(TZS[i].id===id)return en?TZS[i].en:TZS[i].zh}
    return String(id).split('/').pop().replace(/_/g,' ');
  }
  function deviceTz(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch(e){return'UTC'}}
  function tz1auto(){return get('sgx-tz1-auto')!=='0'}
  function firstCity(){return tz1auto()?tzLabel(deviceTz()):tzLabel(get('sgx-tz1')||'America/Los_Angeles')}
  function secondCity(){return tzLabel(get('sgx-tz2')||'America/Los_Angeles')}

  /* ---- 主题模式 ---- */
  function curMode(){return get('sgx-theme-mode')||'system'}
  function paintTheme(){
    var m=curMode();
    document.querySelectorAll('#theme-previews .theme-prev').forEach(function(b){
      b.setAttribute('aria-pressed',b.getAttribute('data-mode')===m?'true':'false');
    });
    setSwitch('sw-system',m==='system');
  }
  document.querySelectorAll('#theme-previews .theme-prev').forEach(function(b){
    b.addEventListener('click',function(){window.__setThemeMode(b.getAttribute('data-mode'));paintTheme()});
  });
  rowToggle('row-system',function(){
    var m=curMode();
    if(m==='system'){window.__setThemeMode(document.documentElement.classList.contains('dark')?'dark':'light')}
    else{window.__setThemeMode('system')}
    paintTheme();
  });
  window.addEventListener('sgx-theme-changed',paintTheme);
  paintTheme();

  /* ---- 主色色板（第一个 = 默认，即头像取色） ---- */
  function curPalette(){return get('sgx-palette')||'lake'}
  function paintPalette(){
    var p=curPalette();
    document.querySelectorAll('#palette-dots .swatch').forEach(function(b){
      b.setAttribute('aria-pressed',b.getAttribute('data-palette')===p?'true':'false');
    });
  }
  document.querySelectorAll('#palette-dots .swatch').forEach(function(b){
    b.addEventListener('click',function(){
      var p=b.getAttribute('data-palette');
      set('sgx-palette',p==='lake'?null:p);
      var d=document.documentElement;
      if(p==='lake'){d.removeAttribute('data-palette')}else{d.setAttribute('data-palette',p)}
      paintPalette();
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
  });
  paintPalette();

  /* ---- 字体大小 ---- */
  function paintFont(){
    var v=get('sgx-font-size')||'standard';
    document.querySelectorAll('#seg-font button').forEach(function(b){
      b.setAttribute('aria-pressed',b.getAttribute('data-v')===v?'true':'false');
    });
  }
  document.querySelectorAll('#seg-font button').forEach(function(b){
    b.addEventListener('click',function(){
      var v=b.getAttribute('data-v');
      set('sgx-font-size',v==='standard'?null:v);
      var d=document.documentElement;
      d.style.fontSize=v==='large'?'112.5%':(v==='small'?'87.5%':'');
      paintFont();
    });
  });
  paintFont();

  /* ---- 桌面布局：自动 / 手机 / DeX ---- */
  function paintLayout(){
    var v='auto';try{v=get('sgx-layout')||'auto'}catch(e){}
    if(v==='tablet'){v='auto';try{localStorage.setItem('sgx-layout','auto')}catch(e){}}
    document.querySelectorAll('#seg-layout button').forEach(function(b){
      b.setAttribute('aria-pressed',b.getAttribute('data-v')===v?'true':'false');
    });
  }
  document.querySelectorAll('#seg-layout button').forEach(function(b){
    b.addEventListener('click',function(){
      var v=b.getAttribute('data-v');
      try{if(v==='auto'){localStorage.removeItem('sgx-layout')}else{localStorage.setItem('sgx-layout',v)}}catch(e){}
      paintLayout();
      if(window.__applyLayout)window.__applyLayout();
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
  });
  paintLayout();

  /* ---- 搜索引擎（2.4.0 F：定义走共享模块 assets/js/sgx-engines.js，与浏览器页共用同一个 localStorage key） ---- */
  var SE = window.__sgxEngines;
  function engineName(){ return SE.name(SE.cur()); }

  /* ---- 常规管理行：当前值 ---- */
  function paintManage(){
    $('lang-val').textContent=en?'English':'中文';
    $('dt-val').textContent=firstCity()+' · '+secondCity();
    $('wx-val').textContent=get('sgx-temp-unit')==='f'?'℉':'℃';
  }
  paintManage();

  /* ---- 语言 ---- */
  rowToggle('row-lang',function(){
    window.__openSheet({title:en?'Language':'语言',options:[
      {label:'中文',value:'zh',checked:!en},
      {label:'English',value:'en',checked:en}
    ],onPick:function(v){
      try{localStorage.setItem('sgx-lang',v)}catch(e){}
      /* 跳到当前页面的对应语言版本，保留查询参数与 hash，用 replace 不产生历史 */
      var p=location.pathname,q=location.search,h=location.hash,np;
      if(v==='en'){np=p==='/'?'/en/':(p==='/en'||p.indexOf('/en/')===0?p:'/en'+p);}
      else{np=p.replace(/^\/en(\/|$)/,'/');if(np===''||np.charAt(0)!=='/')np='/';}
      location.replace(np+q+h);
    }});
  });

  /* ---- 日期和时间 ---- */
  function openDateTime(){
    var auto=tz1auto();
    var tz1cur=get('sgx-tz1')||'America/Los_Angeles';
    var h12=get('sgx-hour12')==='12';
    var html='<div class="px-1 pb-2">'
      +'<div class="set-row no-ic" id="dt-auto" role="button" tabindex="0">'
      +'<span class="flex-1 min-w-0"><span class="block font-medium">'+(en?'Use local time for primary timezone':'第一时区使用本地时间')+'</span>'
      +'<span class="block text-xs text-m-on-surface-variant mt-0.5">'+(en?'Turn off to pick manually':'关闭后可手动选择')+'</span></span>'
      +'<span class="switch" id="dt-auto-sw" role="switch" aria-checked="'+(auto?'true':'false')+'" aria-label="'+(en?'Use local time':'使用本地时间')+'"><span class="knob"></span></span></div>'
      +'<div class="set-row no-ic'+(auto?' is-disabled':'')+'" id="dt-tz1" role="button" tabindex="0">'
      +'<span class="flex-1 font-medium">'+(en?'Primary timezone':'第一时区')+'</span>'
      +'<span class="text-sm text-m-on-surface-variant">'+__sgxUtil.esc(auto?tzLabel(deviceTz()):tzLabel(tz1cur))+'</span>'+CHEVR+'</div>'
      +'<div class="set-row no-ic" id="dt-tz2" role="button" tabindex="0">'
      +'<span class="flex-1 font-medium">'+(en?'Second timezone':'第二时区')+'</span>'
      +'<span class="text-sm text-m-on-surface-variant">'+__sgxUtil.esc(secondCity())+'</span>'+CHEVR+'</div>'
      +'<div class="px-5 py-4"><p class="text-sm font-medium mb-3">'+(en?'Hour format':'小时制')+'</p>'
      +'<div class="seg" id="dt-hour" role="group" aria-label="'+(en?'Hour format':'小时制')+'">'
      +'<button type="button" data-v="12" aria-pressed="'+(h12?'true':'false')+'">'+(en?'12-hour':'12 小时制')+'</button>'
      +'<button type="button" data-v="24" aria-pressed="'+(h12?'false':'true')+'">'+(en?'24-hour':'24 小时制')+'</button>'
      +'</div></div>'
      +'<p class="px-5 pb-3 text-xs text-m-on-surface-variant">'+(en?'Home dual clock and taskbar time use these settings.':'首页双时钟和任务栏时间使用以上设置。')+'</p>'
      +'</div>';
    window.__openSheet({title:en?'Date & time':'日期和时间',html:html});
    var sheetRow=rowToggle;
    function rewire(){
      sheetRow('dt-auto',function(){
        var on=!tz1auto();
        set('sgx-tz1-auto',on?'1':'0');
        paintManage();window.dispatchEvent(new Event('sgx-settings-changed'));
        openDateTime();
      });
      if(!tz1auto()){sheetRow('dt-tz1',function(){openTzPicker('sgx-tz1',openDateTime)})}
      document.querySelectorAll('#dt-hour button').forEach(function(b){
        b.addEventListener('click',function(){
          set('sgx-hour12',b.getAttribute('data-v'));
          document.querySelectorAll('#dt-hour button').forEach(function(x){
            x.setAttribute('aria-pressed',x===b?'true':'false');
          });
          window.dispatchEvent(new Event('sgx-settings-changed'));
        });
      });
      sheetRow('dt-tz2',function(){openTzPicker('sgx-tz2',openDateTime)});
    }
    rewire();
  }
  rowToggle('row-datetime',openDateTime);

  /* ---- 时区选择器（顶部带搜索） ---- */
  function openTzPicker(key,back){
    var cur=key==='sgx-tz1'?(get('sgx-tz1')||'America/Los_Angeles'):(get('sgx-tz2')||'America/Los_Angeles');
    var html='<div class="px-1 pb-2">'
      +'<div class="px-4 pb-2"><input id="tzp-q" type="search" autocomplete="off" placeholder="'+(en?'Search timezones…':'搜索时区…')+'" aria-label="'+(en?'Search timezones':'搜索时区')+'"'
      +' class="w-full rounded-full border border-m-outline bg-m-container px-5 py-2.5 text-sm outline-none placeholder:text-m-on-surface-variant focus:border-m-primary"></div>'
      +'<div id="tzp-list"></div></div>';
    window.__openSheet({title:en?'Choose timezone':'选择时区',html:html});
    function renderList(q){
      q=(q||'').toLowerCase();
      var list=TZS.filter(function(t){
        return !q||t.id.toLowerCase().indexOf(q)>=0||t.zh.indexOf(q)>=0||t.en.toLowerCase().indexOf(q)>=0;
      });
      var box=$('tzp-list');
      box.innerHTML=list.length?list.map(function(t){
        var lb=en?t.en:t.zh;
        return '<button type="button" class="sheet-opt" data-tz="'+t.id+'">'
          +'<span class="flex-1 min-w-0"><span class="block font-medium truncate">'+__sgxUtil.esc(lb)+'</span>'
          +'<span class="block text-xs text-m-on-surface-variant truncate">'+t.id+'</span></span>'
          +(t.id===cur?'<span class="text-m-primary">✓</span>':'')+'</button>';
      }).join(''):'<p class="px-5 py-4 text-sm text-m-on-surface-variant text-center">'+(en?'No results':'无结果')+'</p>';
      box.querySelectorAll('.sheet-opt').forEach(function(b){
        b.addEventListener('click',function(){
          set(key,b.getAttribute('data-tz'));
          paintManage();
          window.dispatchEvent(new Event('sgx-settings-changed'));
          back();
        });
      });
    }
    renderList('');
    var qi=$('tzp-q');
    qi.addEventListener('input',function(){renderList(qi.value.trim())});
    setTimeout(function(){qi.focus()},300);
  }

  /* ---- 天气 ---- */
  function openWeather(){
    var show=get('sgx-weather-show')!=='0';
    var unit=get('sgx-temp-unit')==='f'?'f':'c';
    var html='<div class="px-1 pb-2">'
      +'<div class="set-row no-ic" id="wx-show" role="button" tabindex="0">'
      +'<span class="flex-1 font-medium">'+(en?'Show weather widget':'显示天气小组件')+'</span>'
      +'<span class="switch" id="wx-show-sw" role="switch" aria-checked="'+(show?'true':'false')+'"><span class="knob"></span></span></div>'
      +'<div class="px-5 py-4"><p class="text-sm font-medium mb-3">'+(en?'Temperature unit':'温度单位')+'</p>'
      +'<div class="seg" id="wx-unit" role="group" aria-label="'+(en?'Temperature unit':'温度单位')+'">'
      +'<button type="button" data-v="c" aria-pressed="'+(unit==='c'?'true':'false')+'">℃</button>'
      +'<button type="button" data-v="f" aria-pressed="'+(unit==='f'?'true':'false')+'">℉</button>'
      +'</div></div></div>';
    window.__openSheet({title:en?'Weather':'天气',html:html});
    var sheetRow2=rowToggle;
    sheetRow2('wx-show',function(){
      var on=get('sgx-weather-show')==='0';
      set('sgx-weather-show',on?'1':'0');
      setSwitch('wx-show-sw',on);
      paintManage();window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    document.querySelectorAll('#wx-unit button').forEach(function(b){
      b.addEventListener('click',function(){
        set('sgx-temp-unit',b.getAttribute('data-v'));
        document.querySelectorAll('#wx-unit button').forEach(function(x){
          x.setAttribute('aria-pressed',x===b?'true':'false');
        });
        paintManage();window.dispatchEvent(new Event('sgx-settings-changed'));
      });
    });
  }
  rowToggle('row-weather',openWeather);

  /* ================= 应用：我的文件 / 应用商店 / 浏览器 ================= */
  var APPS_TOTAL={{ len site.Data.apps }};
  var hiddenApps=window.__sgxHiddenApps;
  function addrbarPos(){var p=get('sgx-addrbar-pos');return p==='top'?'top':'bottom'}
  function filesView(){try{var v=JSON.parse(get('sgx-files-view')||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}}
  function paintApps(){
    var v=filesView();
    var layout=v.layout==='grid'?'grid':'list';
    var f1=$('app-files-val');
    if(f1)f1.textContent=en?(layout==='grid'?'Grid view':'List view'):(layout==='grid'?'网格视图':'列表视图');
    var h=hiddenApps(),inst=APPS_TOTAL-h.length;
    var f2=$('app-store-val');
    if(f2)f2.textContent=en?('Installed '+inst+', uninstalled '+h.length):('已安装 '+inst+' 个，未安装 '+h.length+' 个');
    var f3=$('app-browser-val');
    if(f3)f3.textContent=engineName()+' · '+(addrbarPos()==='top'?(en?'Top':'顶部'):(en?'Bottom':'底部'));
    /* 浏览器面板开着时，引擎行标签实时同步（跨标签页 storage 事件同样走这里） */
    var apb=$('apb-engine');
    if(apb){var lbl=apb.querySelector('.text-sm');if(lbl)lbl.textContent=engineName();}
  }
  /* 二次确认按钮：第一次点击变红字确认态，3 秒内再点执行 */
  function armConfirm(btn,confirmLabel,fn){
    var armed=false,timer=null,orig=btn.innerHTML;
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      if(!armed){
        armed=true;
        btn.innerHTML='<span class="font-medium" style="color:#dc2626">'+__sgxUtil.esc(confirmLabel)+'</span>';
        timer=setTimeout(function(){armed=false;btn.innerHTML=orig},3000);
      }else{
        if(timer)clearTimeout(timer);
        fn();
      }
    });
  }
  function sheetSeg(id,options,cur,onPick){
    var html='<div class="seg" id="'+id+'" role="group">'
      +options.map(function(o){
        return '<button type="button" data-v="'+o.v+'" aria-pressed="'+(o.v===cur?'true':'false')+'">'+__sgxUtil.esc(o.label)+'</button>';
      }).join('')+'</div>';
    return html;
  }
  function wireSeg(id,onPick){
    document.querySelectorAll('#'+id+' button').forEach(function(b){
      b.addEventListener('click',function(){
        var v=b.getAttribute('data-v');
        document.querySelectorAll('#'+id+' button').forEach(function(x){
          x.setAttribute('aria-pressed',x===b?'true':'false');
        });
        onPick(v);
      });
    });
  }
  function hlInSheet(itemId){
    if(!itemId)return;
    setTimeout(function(){
      var el=document.querySelector('#sheet-body #'+itemId);
      if(el){
        el.scrollIntoView({block:'center',behavior:reducedM?'auto':'smooth'});
        el.classList.add('set-hl');
        setTimeout(function(){el.classList.remove('set-hl')},1400);
      }
    },320);
  }
  var APP_LINKS={
    files:'{{ if .isEn }}/en/files/{{ else }}/files/{{ end }}',
    store:'{{ if .isEn }}/en/store/{{ else }}/store/{{ end }}',
    browser:'{{ if .isEn }}/en/browser/{{ else }}/browser/{{ end }}'
  };
  function appOpenLink(key,label){
    return '<a class="set-row no-ic" href="'+APP_LINKS[key]+'">'
      +'<span class="flex-1 font-medium text-m-primary">'+__sgxUtil.esc(label)+'</span>'+CHEVR+'</a>';
  }

  /* ---- 我的文件面板 ---- */
  function openFilesPanel(hl){
    var v=filesView();
    var layout=v.layout==='grid'?'grid':'list';
    var sort=v.sort==='name'?'name':'added';
    var home={};try{home=JSON.parse(get('sgx-files-home')||'{}')}catch(e){home={}}
    var GROUPS=[
      {id:'cats',zh:'分类行',en:'Categories'},
      {id:'sites',zh:'我的站点',en:'My sites'},
      {id:'recent',zh:'最近添加与访问',en:'Recent'},
      {id:'storage',zh:'站点存储',en:'Storage'},
      {id:'fav',zh:'收藏',en:'Favorites'}
    ];
    var html='<div class="px-1 pb-2">'
      +'<div class="px-5 py-4" id="apf-view"><p class="text-sm font-medium mb-3">'+(en?'Default view':'默认视图')+'</p>'
      +sheetSeg('apf-view-seg',[{v:'list',label:en?'List':'列表'},{v:'grid',label:en?'Grid':'网格'}],layout)+'</div>'
      +'<div class="px-5 py-4" id="apf-sort"><p class="text-sm font-medium mb-3">'+(en?'Sort order':'排序方式')+'</p>'
      +sheetSeg('apf-sort-seg',[{v:'added',label:en?'Recently added':'添加时间'},{v:'name',label:en?'Name':'名称'}],sort)+'</div>'
      +'<div class="px-5 py-4" id="apf-home"><p class="text-sm font-medium mb-1">'+(en?'Home sections':'主页显示的分组')+'</p>'
      +GROUPS.map(function(g){
        var on=home[g.id]!==false;
        return '<div class="set-row no-ic" id="apf-home-'+g.id+'" role="button" tabindex="0">'
          +'<span class="flex-1 font-medium">'+(en?g.en:g.zh)+'</span>'
          +'<span class="switch" role="switch" aria-checked="'+(on?'true':'false')+'"><span class="knob"></span></span></div>';
      }).join('')+'</div>'
      +'<div class="set-row no-ic" id="apf-clear" role="button" tabindex="0">'
      +'<span class="flex-1 font-medium">'+(en?'Clear recent visits':'清除最近访问记录')+'</span></div>'
      +appOpenLink('files',en?'Open My Files':'打开我的文件')
      +'</div>';
    window.__openSheet({title:en?'My Files':'我的文件',html:html});
    wireSeg('apf-view-seg',function(val){
      var vv=filesView();vv.layout=val;set('sgx-files-view',JSON.stringify(vv));
      paintApps();window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    wireSeg('apf-sort-seg',function(val){
      var vv=filesView();vv.sort=val;set('sgx-files-view',JSON.stringify(vv));
      window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    GROUPS.forEach(function(g){
      appSheetRow('apf-home-'+g.id,function(){
        var hh={};try{hh=JSON.parse(get('sgx-files-home')||'{}')}catch(e){hh={}}
        var on=hh[g.id]!==false;
        hh[g.id]=!on;set('sgx-files-home',JSON.stringify(hh));
        var sw=document.querySelector('#apf-home-'+g.id+' .switch');
        if(sw)sw.setAttribute('aria-checked',(!on)?'true':'false');
        window.dispatchEvent(new Event('sgx-settings-changed'));
      });
    });
    var clr=$('apf-clear');
    if(clr)armConfirm(clr,en?'Tap again to clear':'再点一次清除',function(){
      try{localStorage.removeItem('sgx-files-recent');localStorage.removeItem('sgx-files-lastvisit')}catch(e){}
      window.dispatchEvent(new Event('sgx-settings-changed'));
      if(window.__closeSheet)window.__closeSheet();
    });
    hlInSheet(hl);
  }
  rowToggle('row-app-files',function(){openFilesPanel()});

  /* ---- 应用商店面板 ---- */
  function openStorePanel(hl){
    var h=hiddenApps(),inst=APPS_TOTAL-h.length;
    var html='<div class="px-1 pb-2">'
      +'<div class="set-row no-ic"><span class="flex-1 font-medium">'
      +(en?('Installed '+inst+', uninstalled '+h.length):('已安装 '+inst+' 个，未安装 '+h.length+' 个'))
      +'</span></div>'
      +'<div class="set-row no-ic" id="aps-restore" role="button" tabindex="0">'
      +'<span class="flex-1 font-medium text-m-primary">'+(en?'Restore all apps':'恢复全部应用')+'</span></div>'
      +appOpenLink('store',en?'Open Store':'打开应用商店')
      +'</div>';
    window.__openSheet({title:en?'Store':'应用商店',html:html});
    var rs=$('aps-restore');
    if(rs)rs.addEventListener('click',function(){
      try{localStorage.removeItem('sgx-apps-hidden')}catch(e){}
      paintApps();window.dispatchEvent(new Event('sgx-settings-changed'));
      if(window.__closeSheet)window.__closeSheet();
    });
    hlInSheet(hl);
  }
  rowToggle('row-app-store',function(){openStorePanel()});

  /* ---- 浏览器面板 ---- */
  function pickEngine(){
    var cur=SE.cur();
    window.__openSheet({title:en?'Search engine':'搜索引擎',options:
      SE.ORDER.map(function(id){return {label:SE.name(id),value:id,checked:id===cur}}),
      onPick:function(v){
        SE.setCur(v); /* 存值 + 派发 sgx-settings-changed，paintApps 自动刷新 */
        openBrowserPanel('apb-engine');
      }});
  }
  function openBrowserPanel(hl){
    var pos=addrbarPos();
    var html='<div class="px-1 pb-2">'
      +'<div class="set-row no-ic" id="apb-engine" role="button" tabindex="0">'
      +'<span class="flex-1 font-medium">'+(en?'Search engine':'搜索引擎')+'</span>'
      +'<span class="text-sm text-m-on-surface-variant">'+__sgxUtil.esc(engineName())+'</span>'+CHEVR+'</div>'
      +'<div class="px-5 py-4" id="apb-pos"><p class="text-sm font-medium mb-3">'+(en?'Address bar position':'地址栏位置')+'</p>'
      +sheetSeg('apb-pos-seg',[{v:'top',label:en?'Top':'顶部'},{v:'bottom',label:en?'Bottom':'底部'}],pos)+'</div>'
      +'<div class="set-row no-ic" id="apb-clear" role="button" tabindex="0">'
      +'<span class="flex-1 font-medium">'+(en?'Clear browsing history':'清除浏览记录')+'</span></div>'
      +appOpenLink('browser',en?'Open Internet':'打开浏览器')
      +'</div>';
    window.__openSheet({title:en?'Internet':'浏览器',html:html});
    appSheetRow('apb-engine',pickEngine);
    wireSeg('apb-pos-seg',function(val){
      set('sgx-addrbar-pos',val);
      paintApps();window.dispatchEvent(new Event('sgx-settings-changed'));
    });
    var clr=$('apb-clear');
    if(clr)armConfirm(clr,en?'Tap again to clear':'再点一次清除',function(){
      try{localStorage.setItem('sgx-browser-recent','[]')}catch(e){}
      window.dispatchEvent(new Event('sgx-settings-changed'));
      if(window.__closeSheet)window.__closeSheet();
    });
    hlInSheet(hl);
  }
  rowToggle('row-app-browser',function(){openBrowserPanel()});
  paintApps();
  window.addEventListener('sgx-settings-changed',paintApps);

  /* ---- 减弱动效 ---- */
  function paintMotion(){setSwitch('sw-motion',get('sgx-reduced-motion')==='1')}
  rowToggle('row-motion',function(){
    var on=get('sgx-reduced-motion')!=='1';
    set('sgx-reduced-motion',on?'1':null);
    document.documentElement.classList.toggle('reduced-motion',on);
    paintMotion();
  });
  paintMotion();

  /* ---- 数字健康：访客时长提示 ---- */
  function paintWellTip(){setSwitch('sw-welltip',get('sgx-well-tip')!=='0')}
  rowToggle('row-welltip',function(){
    var on=get('sgx-well-tip')==='0';
    set('sgx-well-tip',on?'1':'0');
    paintWellTip();window.dispatchEvent(new Event('sgx-settings-changed'));
  });
  paintWellTip();
  /* 访客到访分布 */
  (function(){
    var totalEl=$('well-v-total'),bar=$('well-v-bar'),legend=$('well-v-legend');
    if(!totalEl||!bar)return;
    var v=(window.__wellLoad&&window.__wellLoad())||{min:0,areas:{}};
    try{v=window.__wellFlush()}catch(e){}
    var total=Math.max(0,Math.round(v.min||0));
    totalEl.textContent=total;
    var AREAS=[
      {id:'home',label:en?'Home':'首页',color:'var(--m-primary)'},
      {id:'links',label:en?'Bookmarks':'导航',color:'var(--m-accent)'},
      {id:'settings',label:en?'Settings':'设置',color:'var(--m-secondary)'},
      {id:'goodlock',label:'Good Lock',color:'var(--m-rose)'}
    ];
    if(total<=0){
      bar.innerHTML='<span style="width:100%;background:var(--m-container-highest)"></span>';
      legend.innerHTML='<span>'+(en?'No visits recorded yet today':'今天还没有到访记录')+'</span>';
      return;
    }
    bar.innerHTML=AREAS.map(function(a){
      var m=v.areas[a.id]||0,pct=Math.max(0,(m/total*100));
      return '<span style="width:'+pct.toFixed(1)+'%;background:'+a.color+'" title="'+a.label+'"></span>';
    }).join('');
    legend.innerHTML=AREAS.map(function(a){
      return '<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full" style="background:'+a.color+'"></span>'+a.label+'</span>';
    }).join('');
  })();

  /* ---- 重置 ---- */
  rowToggle('row-reset',function(){
    try{
      var ks=[];for(var i=0;i<localStorage.length;i++){ks.push(localStorage.key(i))}
      ks.forEach(function(k){if(k.indexOf('sgx-')===0||k==='theme')localStorage.removeItem(k)});
    }catch(e){}
    location.reload();
  });

  /* ---- 桌面双栏：分类切换 + hash 记忆 ---- */
  var CATS=[
    {id:'display',el:'sg-display'},
    {id:'theme',el:'sg-theme'},
    {id:'manage',el:'sg-manage'},
    {id:'apps',el:'sg-apps'},
    {id:'accessibility',el:'sg-accessibility'},
    {id:'wellbeing',el:'sg-wellbeing'},
    {id:'about',el:'sg-about'}
  ];
  /* 2.3.14.8：右栏顶部选中项名称 */
  var CATNAMES={
    display:{zh:'显示',en:'Display'},
    theme:{zh:'壁纸和主题',en:'Wallpaper & theme'},
    manage:{zh:'常规管理',en:'General management'},
    apps:{zh:'应用',en:'Apps'},
    accessibility:{zh:'辅助功能',en:'Accessibility'},
    wellbeing:{zh:'数字健康',en:'Digital wellbeing'},
    about:{zh:'关于本站',en:'About'}
  };
  var setLayout=document.querySelector('.set-layout');
  var mqWide=window.matchMedia('(min-width:640px)');
  var reducedM=document.documentElement.classList.contains('reduced-motion');
  function catFromHash(){
    var h=(location.hash||'').replace(/^#/,'');
    var alias={clock:'manage','sg-clock':'manage',general:'accessibility','sg-general':'accessibility'};
    if(alias[h])return alias[h];
    for(var i=0;i<CATS.length;i++){
      if(CATS[i].id===h||('sg-'+CATS[i].id)===h)return CATS[i].id;
    }
    return 'display';
  }
  function showCat(id,skipHash){
    document.querySelectorAll('.set-group').forEach(function(g){
      g.classList.toggle('active',g.id==='sg-'+id);
    });
    document.querySelectorAll('#set-cat-nav .set-cat').forEach(function(b){
      var on=b.getAttribute('data-cat')===id;
      b.classList.toggle('active',on);
      if(on)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current');
    });
    /* 2.3.14.8：右栏顶部显示选中项名称 */
    var rt=document.getElementById('set-right-title');
    if(rt&&CATNAMES[id])rt.textContent=en?CATNAMES[id].en:CATNAMES[id].zh;
    if(!skipHash){try{history.replaceState(null,'','#'+id)}catch(e){}}
    if(setLayout&&mqWide.matches)setLayout.classList.add('single-cat');
  }
  function applyMode(){
    if(!mqWide.matches){
      if(setLayout)setLayout.classList.remove('single-cat');
      document.querySelectorAll('.set-group').forEach(function(g){g.classList.remove('active');g.style.display=''});
      document.querySelectorAll('#set-cat-nav .set-cat').forEach(function(b){b.classList.remove('active');b.style.display=''});
      return;
    }
    showCat(catFromHash(),true);
  }
  document.querySelectorAll('#set-cat-nav .set-cat').forEach(function(b){
    b.addEventListener('click',function(){
      showCat(b.getAttribute('data-cat'));
    });
  });
  window.addEventListener('hashchange',function(){if(mqWide.matches)showCat(catFromHash(),true)});
  if(mqWide.addEventListener)mqWide.addEventListener('change',applyMode);
  else if(mqWide.addListener)mqWide.addListener(applyMode);

  applyMode();

  /* ---- 全屏搜索索引（手机三星样式搜索条用） ---- */
  var SETIDX=[
    {t:en?'Follow system':'跟随系统',d:en?'Display':'显示',cat:'display',el:'row-system'},
    {t:en?'Font size':'字体大小',d:en?'Display':'显示',cat:'display',el:'seg-font'},
    {t:en?'Desktop layout':'桌面布局',d:en?'Auto / Phone / DeX':'自动 / 手机 / DeX',cat:'display',el:'seg-layout'},
    {t:en?'Theme color':'主色',d:en?'Wallpaper & theme':'壁纸和主题',cat:'theme',el:'palette-dots'},
    {t:en?'Wallpaper & theme':'壁纸和主题',d:'',cat:'theme',el:'sg-theme'},
    {t:en?'Language':'语言',d:en?'General management':'常规管理',cat:'manage',el:'row-lang'},
    {t:en?'Date & time':'日期和时间',d:en?'General management':'常规管理',cat:'manage',el:'row-datetime'},
    {t:en?'Primary timezone':'第一时区',d:en?'Date & time':'日期和时间',cat:'manage',el:'row-datetime'},
    {t:en?'Second timezone':'第二时区',d:en?'Date & time':'日期和时间',cat:'manage',el:'row-datetime'},
    {t:en?'Time zone':'时区',d:en?'Date & time':'日期和时间',cat:'manage',el:'row-datetime'},
    {t:en?'Hour format':'小时制',d:en?'Date & time':'日期和时间',cat:'manage',el:'row-datetime'},
    {t:en?'Weather':'天气',d:en?'General management':'常规管理',cat:'manage',el:'row-weather'},
    {t:en?'Temperature unit':'温度单位',d:en?'Weather':'天气',cat:'manage',el:'row-weather'},
    {t:en?'Show weather widget':'显示天气小组件',d:en?'Weather':'天气',cat:'manage',el:'row-weather'},
    {t:en?'Search engine':'搜索引擎',d:en?'Internet':'浏览器',cat:'apps',el:'row-app-browser',p:'browser',i:'apb-engine'},
    {t:en?'Apps':'应用',d:'',cat:'apps',el:'sg-apps'},
    {t:en?'My Files':'我的文件',d:en?'Apps':'应用',cat:'apps',el:'row-app-files',p:'files'},
    {t:en?'Blog':'博客',d:en?'My Files':'我的文件',cat:'apps',el:'row-app-files',p:'files'},
    {t:en?'Library':'书库',d:en?'My Files':'我的文件',cat:'apps',el:'row-app-files',p:'files'},
    {t:en?'My sites':'我的站点',d:en?'My Files':'我的文件',cat:'apps',el:'row-app-files',p:'files'},
    {t:en?'Default view':'默认视图',d:en?'My Files':'我的文件',cat:'apps',el:'row-app-files',p:'files',i:'apf-view'},
    {t:en?'Sort order':'排序方式',d:en?'My Files':'我的文件',cat:'apps',el:'row-app-files',p:'files',i:'apf-sort'},
    {t:en?'Home sections':'主页显示的分组',d:en?'My Files':'我的文件',cat:'apps',el:'row-app-files',p:'files',i:'apf-home'},
    {t:en?'Clear recent visits':'清除最近访问记录',d:en?'My Files':'我的文件',cat:'apps',el:'row-app-files',p:'files',i:'apf-clear'},
    {t:en?'Store':'应用商店',d:en?'Apps':'应用',cat:'apps',el:'row-app-store',p:'store'},
    {t:en?'Restore all apps':'恢复全部应用',d:en?'Store':'应用商店',cat:'apps',el:'row-app-store',p:'store',i:'aps-restore'},
    {t:en?'Internet':'浏览器',d:en?'Apps':'应用',cat:'apps',el:'row-app-browser',p:'browser'},
    {t:en?'Address bar position':'地址栏位置',d:en?'Internet':'浏览器',cat:'apps',el:'row-app-browser',p:'browser',i:'apb-pos'},
    {t:en?'Clear browsing history':'清除浏览记录',d:en?'Internet':'浏览器',cat:'apps',el:'row-app-browser',p:'browser',i:'apb-clear'},
    {t:en?'Reduce motion':'减弱动效',d:en?'Accessibility':'辅助功能',cat:'accessibility',el:'row-motion'},
    {t:en?'Digital wellbeing':'数字健康',d:'',cat:'wellbeing',el:'sg-wellbeing'},
    {t:en?'15-minute reminder':'15 分钟提醒',d:en?'Digital wellbeing':'数字健康',cat:'wellbeing',el:'row-welltip'},
    {t:en?'Version':'版本',d:en?'About':'关于本站',cat:'about',el:'sg-about'},
    {t:en?'Interface':'界面',d:'Styrigx UI',cat:'about',el:'sg-about'},
    {t:en?'Reset all settings':'重置所有设置',d:en?'About':'关于本站',cat:'about',el:'row-reset'},
    {t:en?'Display':'显示',d:'',cat:'display',el:'sg-display'},
    {t:en?'General management':'常规管理',d:'',cat:'manage',el:'sg-manage'},
    {t:en?'Accessibility':'辅助功能',d:'',cat:'accessibility',el:'sg-accessibility'},
    {t:en?'About':'关于本站',d:'',cat:'about',el:'sg-about'}
  ];
  function idxByEl(elid){for(var i=0;i<SETIDX.length;i++){if(SETIDX[i].el===elid)return SETIDX[i]}return null}
  /* 胶囊搜索（2.3.12.1）：复用 2.3.11 的 SETIDX 索引，结果显示在胶囊上方浮层 */
  function itemHTML(x){
    return '<button type="button" class="setso-item" data-cat="'+x.cat+'" data-el="'+x.el+'" data-t="'+__sgxUtil.esc(x.t)+'"'
      +(x.p?' data-p="'+x.p+'"':'')+(x.i?' data-i="'+x.i+'"':'')+'>'
      +'<span class="flex-1 min-w-0"><span class="block font-medium truncate">'+__sgxUtil.esc(x.t)+'</span>'
      +(x.d?'<span class="block text-xs text-m-on-surface-variant truncate">'+__sgxUtil.esc(x.d)+'</span>':'')+'</span>'+CHEVR+'</button>';
  }
  function renderSearchHTML(q){
    q=(q||'').trim().toLowerCase();
    var html='';
    if(!q){
      var recent=[];try{recent=JSON.parse(get('sgx-set-recent')||'[]')}catch(e){}
      if(recent.length){
        html+='<p class="setso-sec">'+(en?'Recent searches':'最近搜索')+'</p>';
        html+=recent.map(function(r){
          var f=null;for(var i=0;i<SETIDX.length;i++){if(SETIDX[i].t===r){f=SETIDX[i];break}}
          return f?itemHTML(f):'';
        }).join('');
      }
      html+='<p class="setso-sec">'+(en?'Common settings':'常用设置')+'</p>';
      ['seg-font','palette-dots','row-datetime'].forEach(function(eid){
        var f=idxByEl(eid);if(f)html+=itemHTML(f);
      });
    }else{
      var hits=SETIDX.filter(function(x){return (x.t+' '+x.d).toLowerCase().indexOf(q)>=0}).slice(0,12);
      html=hits.length?hits.map(itemHTML).join(''):'<p class="px-4 py-8 text-center text-sm text-m-on-surface-variant">'+(en?'No results':'无结果')+'</p>';
    }
    return html;
  }
  window.__sgxCapSearch=function(pg,q){
    if(pg!=='settings')return '';
    return renderSearchHTML(q);
  };
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('#sgx-cap-results-settings .setso-item'):null;
    if(b)pickResult(b.getAttribute('data-cat'),b.getAttribute('data-el'),b.getAttribute('data-t'),b.getAttribute('data-p'),b.getAttribute('data-i'));
  });
  function pickResult(cat,elid,title,panel,item){
    try{
      var r=JSON.parse(get('sgx-set-recent')||'[]');
      r=r.filter(function(x){return x!==title});r.unshift(title);
      set('sgx-set-recent',JSON.stringify(r.slice(0,6)));
    }catch(e){}
    setTimeout(function(){
      if(panel==='files'){openFilesPanel(item);return}
      if(panel==='store'){openStorePanel(item);return}
      if(panel==='browser'){openBrowserPanel(item);return}
      /* 2.3.14.8：宽屏双栏下先切换到对应分类，再定位高亮 */
      if(cat&&document.documentElement.classList.contains('layout-dex'))showCat(cat);
      var el=document.getElementById(elid);
      if(!el)return;
      el.scrollIntoView({block:'center',behavior:reducedM?'auto':'smooth'});
      el.classList.add('set-hl');
      setTimeout(function(){el.classList.remove('set-hl')},1100);
    },80);
  }
})();