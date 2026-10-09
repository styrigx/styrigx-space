/* favicon 取不到时用首字母圆形占位 */
window.__favFallback=function(img,name){
  try{
    var ch=String(name||'?').trim().charAt(0)||'?';
    var s=document.createElement('span');
    s.className=img.className;
    s.setAttribute('aria-hidden','true');
    s.style.cssText='display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:var(--m-on-surface-variant);background:var(--m-container);';
    s.textContent=ch;
    img.replaceWith(s);
  }catch(e){img.style.display='none'}
};
(function(){
  'use strict';
  var EN = {{ if .isEn }}true{{ else }}false{{ end }};
  function t(zh, en){ return EN ? en : zh; }
  function lsGet(k, d){ try{ var v = localStorage.getItem(k); return v == null ? d : v; }catch(e){ return d; } }
  function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }

  /* ============ 搜索引擎（2.4.0 F：定义走共享模块 sgx-engines.js，与设置页共用） ============ */
  var SE = window.__sgxEngines;
  var LS_RECENT = 'sgx-browser-recent', LS_POS = 'sgx-addrbar-pos';

  function curEngine(){ return SE.cur(); }

  var input     = document.getElementById('brw-input'),
      suggest   = document.getElementById('brw-suggest'),
      engineBtn = document.getElementById('brw-engine-btn'),
      engineIc  = document.getElementById('brw-engine-ic'),
      micBtn    = document.getElementById('brw-mic'),
      menuBtn   = document.getElementById('brw-menu-btn'),
      overlay   = document.getElementById('brw-overlay'),
      addrbar   = document.getElementById('brw-addrbar');
  if(!input || !suggest || !overlay) return;

  /* ============ 2.3.12.1 弹出层开/关：磨砂蒙层，点蒙层空白处或返回键淡出关闭 ============ */
  var ovOpen=false;
  function openOverlay(opts){
    if(ovOpen)return;ovOpen=true;
    try{history.pushState({brwOv:1},'')}catch(e){}
    overlay.classList.add('open');
    renderSuggest();
    if(!opts||opts.focus!==false){setTimeout(function(){try{input.focus({preventScroll:true})}catch(e){}},180)}
    stickKb();
  }
  function closeOverlay(fromPop){
    if(!ovOpen)return;ovOpen=false;
    overlay.classList.remove('open');
    overlay.classList.remove('has-text');
    if(engMenuOpen&&engMenu){try{engMenu.hidePopover()}catch(e){}}
    try{input.blur()}catch(e){}
    unstickKb();
    if(!fromPop){try{history.back()}catch(e){}}
  }
  if(addrbar)addrbar.addEventListener('click',function(){openOverlay()});
  /* 2.4.0 F：内容区是全高滚动容器；点蒙层边缘或内容下方空白（padding 区）同样关闭 */
  var ovTop=document.querySelector('#brw-overlay .brw-ov-top');
  overlay.addEventListener('click',function(e){
    if(e.target===overlay){closeOverlay(false);return}
    if(ovTop&&e.target===ovTop){
      var bottom=0,ch=ovTop.children;
      for(var i=0;i<ch.length;i++){
        if(ch[i].offsetParent!==null){var b=ch[i].getBoundingClientRect().bottom;if(b>bottom)bottom=b}
      }
      if(e.clientY>bottom+4)closeOverlay(false);
    }
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&ovOpen)closeOverlay(false)});
  window.addEventListener('popstate',function(){if(ovOpen)closeOverlay(true)});

  /* ============ 键盘贴合：地址栏贴键盘，无跳动（2.3.14.6） ============
     有 VirtualKeyboard API（Chrome）：overlaysContent 让键盘悬浮不顶页面，
     barwrap bottom 直接跟 env(keyboard-inset-height)，不加 bottom transition。
     无 VK API：visualViewport resize/scroll → rAF 更新 --sgx-kb，不加 transition。 */
  var vv=window.visualViewport;
  var useVK=false;
  try{
    if(navigator.virtualKeyboard&&('overlaysContent' in navigator.virtualKeyboard)){
      navigator.virtualKeyboard.overlaysContent=true;useVK=true;
    }
  }catch(e){}
  function stickKb(){
    if(useVK){
      document.documentElement.classList.add('sgx-vk');
      var onGeo=function(e){
        var h=0;try{h=(e.target&&e.target.boundingRect&&e.target.boundingRect.height)||0}catch(_){}
        h=Math.max(0,h);
        document.documentElement.style.setProperty('--sgx-kb',Math.round(h)+'px');
      };
      try{navigator.virtualKeyboard.addEventListener('geometrychange',onGeo)}catch(e){}
      overlay._vkGeo=onGeo;
      return;
    }
    if(!vv)return;
    overlay.classList.add('sgx-kb-sync');
    var raf=0;
    function upd(){
      raf=0;
      var h=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
      document.documentElement.style.setProperty('--sgx-kb',h+'px');
    }
    function sched(){if(!raf)raf=requestAnimationFrame(upd)}
    vv.addEventListener('resize',sched);vv.addEventListener('scroll',sched);
    overlay._vvSched=sched;upd();
  }
  function unstickKb(){
    document.documentElement.classList.remove('sgx-vk');
    overlay.classList.remove('sgx-kb-sync');
    if(overlay._vkGeo){try{navigator.virtualKeyboard.removeEventListener('geometrychange',overlay._vkGeo)}catch(e){}overlay._vkGeo=null}
    if(vv&&overlay._vvSched){vv.removeEventListener('resize',overlay._vvSched);vv.removeEventListener('scroll',overlay._vvSched);overlay._vvSched=null}
    document.documentElement.style.setProperty('--sgx-kb','0px');
  }

  /* ============ 地址栏位置 ============ */
  function applyDex(){
    var dex = document.documentElement.classList.contains('layout-dex');
    document.body.classList.toggle('addrbar-dex', dex);
  }
  function applyPos(){
    var pos = lsGet(LS_POS, 'bottom'); if(pos !== 'top') pos = 'bottom';
    document.body.classList.toggle('addrbar-top', pos === 'top');
    document.body.classList.toggle('addrbar-bottom', pos !== 'top');
    applyDex();
  }
  window.__dexLayoutChanged = function(){ applyDex(); };
  applyPos();
  /* 2.3.8：设置页改动后双向同步（搜索引擎、地址栏位置）；引擎变化时刷新建议 */
  window.addEventListener('sgx-settings-changed', function(){ applyPos(); paintEngine(); renderSuggest(); });

  /* ============ 引擎切换（2.4.0 F：地址栏「logo + ▾」，锚定弹出菜单） ============
     Popover API + CSS anchor positioning（position-try 自动翻转）；不支持 anchor
     positioning 时按按钮位置 JS 定位；无 Popover API 的极旧浏览器回退到底部菜单。 */
  var engMenu = document.getElementById('brw-eng-menu'),
      engList = engMenu ? engMenu.querySelector('.brw-eng-list') : null;
  var engMenuOpen = false, engLight = false;
  var anchorOK = false, popoverOK = !!(engMenu && engMenu.showPopover);
  try{
    anchorOK = !!(window.CSS && (CSS.supports('position-anchor', '--brw-eng-btn')
      || CSS.supports('anchor-name', '--brw-eng-btn')));
  }catch(e){ anchorOK = false; }

  function paintEngine(){
    var k = curEngine();
    engineIc.innerHTML = SE.iconUse(k, 22);
    engineBtn.setAttribute('aria-label', t('切换搜索引擎（当前：' + SE.name(k) + '）', 'Switch search engine (current: ' + SE.name(k) + ')'));
  }
  function buildEngMenu(){
    var cur = curEngine(), en = (document.documentElement.lang === 'en'), html = '';
    SE.ORDER.forEach(function(id){
      var checked = (id === cur);
      var def = (id === 'google') ? ' <span class="brw-eng-def">' + (en ? '(Default)' : '(默认)') + '</span>' : '';
      html += '<button type="button" class="brw-eng-item" role="menuitemradio" aria-checked="' + checked + '" data-eng="' + id + '">'
        + '<span class="brw-eng-logo">' + SE.iconUse(id, 24) + '</span>'
        + '<span class="brw-eng-name">' + __sgxUtil.esc(SE.name(id)) + def + '</span>'
        + '<svg class="brw-eng-check" width="18" height="18" aria-hidden="true"><use href="#sgx-ic-check"></use></svg>'
        + '</button>';
    });
    engList.innerHTML = html;
  }
  function placeEngMenu(){
    /* 无 anchor positioning：按按钮位置手动定位，空间不足自动上翻 */
    var r = engineBtn.getBoundingClientRect();
    var mw = engMenu.offsetWidth, mh = engMenu.offsetHeight;
    var x = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    var below = (r.bottom + 8 + mh) <= (window.innerHeight - 8);
    engMenu.style.left = x + 'px';
    engMenu.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - 8 - mh)) + 'px';
    engMenu.classList.toggle('flip', !below);
  }
  function pickEngine(id){
    if(!SE.ENGINES[id]) return;
    SE.setCur(id); /* 存值 + 派发 sgx-settings-changed，两边实时同步 */
    paintEngine();
    renderSuggest(); /* 有输入内容时立即刷新建议 */
    if(engMenuOpen && engMenu){ try{ engMenu.hidePopover(); }catch(e){} }
    try{ input.focus({preventScroll:true}); }catch(e){} /* 焦点还给输入框，键盘不收起 */
  }
  function openEngSheet(){
    /* 极旧浏览器回退：原来的底部菜单（定义走共享模块） */
    if(!window.__openSheet) return;
    var cur = curEngine();
    window.__openSheet({
      title: t('搜索引擎', 'Search engine'),
      options: SE.ORDER.map(function(id){
        return { label: SE.name(id), value: id, checked: id === cur };
      }),
      onPick: function(v){ pickEngine(v); }
    });
  }
  function openEngMenu(fromKeyboard){
    if(!popoverOK){ openEngSheet(); return; }
    buildEngMenu();
    engMenu.classList.toggle('no-anchor', !anchorOK);
    engMenu.style.left = ''; engMenu.style.top = '';
    engMenu.classList.remove('flip');
    engLight = false;
    try{ engMenu.showPopover(); }catch(e){ return; }
    /* 键盘打开（Enter/Space）：焦点进菜单，支持方向键 + 回车；触屏/鼠标不抢焦点，键盘保持弹起 */
    if(fromKeyboard){
      var cur = engList.querySelector('[aria-checked="true"]');
      if(cur){ try{ cur.focus({preventScroll:true}); }catch(e){} }
    }
  }
  /* 触屏/鼠标点按钮不抢输入框焦点，键盘保持弹起 */
  engineBtn.addEventListener('pointerdown', function(e){ e.preventDefault(); });
  engineBtn.addEventListener('click', function(e){
    if(engMenuOpen && engMenu){ try{ engMenu.hidePopover(); }catch(e2){} return; }
    openEngMenu(e.detail === 0); /* detail===0 即键盘激活 */
  });
  if(engMenu){
    engList.addEventListener('click', function(e){
      var it = e.target.closest ? e.target.closest('.brw-eng-item') : null;
      if(it) pickEngine(it.getAttribute('data-eng'));
    });
    engList.addEventListener('keydown', function(e){
      var items = engList.querySelectorAll('.brw-eng-item');
      if(!items.length) return;
      var idx = -1;
      for(var i = 0; i < items.length; i++){ if(items[i] === document.activeElement){ idx = i; break; } }
      if(e.key === 'ArrowDown'){ e.preventDefault(); items[(idx + 1 + items.length) % items.length].focus(); }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
      else if(e.key === 'Home'){ e.preventDefault(); items[0].focus(); }
      else if(e.key === 'End'){ e.preventDefault(); items[items.length - 1].focus(); }
    });
    engMenu.addEventListener('toggle', function(e){
      engMenuOpen = (e.newState === 'open');
      engineBtn.setAttribute('aria-expanded', engMenuOpen ? 'true' : 'false');
      if(engMenuOpen){
        if(!anchorOK){ placeEngMenu(); }
        else{
          /* anchor 定位 + 自动翻转：翻上去时缩放动画原点改到底部 */
          var mr = engMenu.getBoundingClientRect(), br = engineBtn.getBoundingClientRect();
          engMenu.classList.toggle('flip', mr.top < br.top - 4);
        }
      }else{
        /* 点外部/Esc 关闭：焦点回到输入框（点外部的轻关闭走原生行为，不抢） */
        if(!engLight && ovOpen && document.activeElement !== input){
          try{ input.focus({preventScroll:true}); }catch(e2){}
        }
        engLight = false;
      }
    });
    /* 点外部的轻关闭不抢焦点；点菜单内部不算轻关闭 */
    document.addEventListener('pointerdown', function(){ if(engMenuOpen) engLight = true; }, true);
    engList.addEventListener('pointerdown', function(){ engLight = false; });
    /* 无 anchor 时键盘/视口变化重定位 */
    if(window.visualViewport){
      window.visualViewport.addEventListener('resize', function(){
        if(engMenuOpen && !anchorOK) placeEngMenu();
      });
    }
  }
  paintEngine();

  /* ============ 菜单：地址栏位置 / 清除最近 ============ */
  menuBtn.addEventListener('click', function(){
    if(!window.__openSheet) return;
    var pos = lsGet(LS_POS, 'bottom'); if(pos !== 'top') pos = 'bottom';
    window.__openSheet({
      title: t('菜单', 'Menu'),
      options: [
        { label: t('地址栏位置：顶部', 'Address bar: Top'),       value: 'top',           checked: pos === 'top' },
        { label: t('地址栏位置：底部', 'Address bar: Bottom'),    value: 'bottom',        checked: pos === 'bottom' },
        { label: t('清除最近搜索', 'Clear recent searches'),      value: '__clear_recent' }
      ],
      onPick: function(v){
        if(v === '__clear_recent'){ lsSet(LS_RECENT, '[]'); renderSuggest(); return; }
        if(v === 'top' || v === 'bottom'){ lsSet(LS_POS, v); applyPos(); }
      }
    });
  });

  /* ============ 语音输入（2.3.14.6）：走共享语音弹窗；识别文字填入并展示站内建议 ============
     只检测 SpeechRecognition 接口是否存在，不按浏览器 UA 判断；不支持则按钮不渲染 */
  (function(){
    var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(micBtn&&SR){
      micBtn.style.display='';
      micBtn.addEventListener('click',function(e){
        e.stopPropagation();
        window.__sgxVoiceSheet({onFinal:function(t){
          input.value=t;renderSuggest();showSuggest();
          try{input.focus({preventScroll:true})}catch(e2){}
        }});
      });
    }
  })();

  /* ============ 底部地址栏胶囊麦克风（2.3.14.6）：点麦克风先打开弹出层，再走共享语音弹窗 ============ */
  /* 只检测 SpeechRecognition 接口是否存在，不按浏览器 UA 判断；不支持则不渲染，无空位、无报错 */
  (function(){
    var pillMic = addrbar ? addrbar.querySelector('[data-mic]') : null;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!pillMic || !SR) return;
    pillMic.style.display = '';
    pillMic.addEventListener('click', function(e){
      e.stopPropagation();
      openOverlay({focus:false});
      window.__sgxVoiceSheet({onFinal:function(t){
        input.value = t; renderSuggest(); showSuggest();
        try{ input.focus({preventScroll:true}); }catch(e2){}
      }});
    });
  })();

  /* ============ 站内搜索索引：/files-index.json 为主，内联 #search-index 兜底 ============ */
  var TYPE_META = {
    link:  { label: t('书签','Links'), icon: 'globe' },
    book:  { label: t('书单','Books'), icon: 'book' },
    music: { label: t('歌单','Music'), icon: 'music' },
    post:  { label: t('博客','Blog'),  icon: 'pen' },
    app:   { label: t('应用','Apps'),  icon: 'compass' }
  };
  var C_CATS = ['link','book','music','post','app'].map(function(k){
    return { type: k, label: TYPE_META[k].label, icon: TYPE_META[k].icon };
  });

  // 旧内联索引 {t,d,u,c} → 新形状 {t,d,u,type}
  function oldCatToType(c){
    c = c || '';
    if(c.indexOf(t('书签','Links')) === 0) return 'link';
    if(c === t('书单','Books')) return 'book';
    if(c === t('歌单','Music')) return 'music';
    if(c === t('博客','Blog')) return 'post';
    return 'app';
  }
  function normInline(raw){
    return (raw || []).map(function(x){
      return { t: x.t || '', d: x.d || '', u: x.u || '', type: oldCatToType(x.c) };
    });
  }

  var INDEX = [];
  function loadInline(){
    try{ INDEX = normInline(JSON.parse(document.getElementById('search-index').textContent).items); }
    catch(e){ INDEX = []; }
  }
  loadInline();

  // 异步换上 /files-index.json（按当前语言过滤）；失败则保留内联兜底
  // 2.3.7：过滤掉已卸载的应用（sgx-apps-hidden）
  function isAppHidden(item){
    if(!item||item.type!=='app')return false;
    try{
      var h=JSON.parse(localStorage.getItem('sgx-apps-hidden')||'[]');
      var id=String(item.id||'').replace(/-en$/,'').replace(/^app-/,'');
      return h.indexOf(id)!==-1;
    }catch(e){return false}
  }
  (function(){
    var wantLang = document.documentElement.lang === 'en' ? 'en' : 'zh';
    fetch('/files-index.json').then(function(r){
      if(!r.ok) throw new Error('bad status ' + r.status);
      return r.json();
    }).then(function(j){
      var items = ((j && j.items) || []).filter(function(x){
        return x && TYPE_META[x.type] && (x.lang || 'zh') === wantLang && !isAppHidden(x);
      }).map(function(x){
        return { t: x.title || '', d: x.subtitle || '', u: x.url || '', type: x.type, id: x.id || '' };
      });
      if(items.length) INDEX = items;
    }).catch(function(){ /* keep inline fallback */ });
    /* 应用卸载/安装后即时重过滤 */
    window.addEventListener('sgx-settings-changed',function(){
      INDEX=INDEX.filter(function(x){return !isAppHidden(x)});
      if(typeof renderSuggest==='function')renderSuggest();
    });
  })();

  function svgIc(inner){
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' + inner + '</svg>';
  }
  var ICONS = {
    globe:    svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m-8.7 9h17.4"/>'),
    book:     svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"/>'),
    music:    svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    pen:      svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/>'),
    sparkles: svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/>'),
    gear:     svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.431.99l1.004.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>'),
    compass:  svgIc('<circle cx="12" cy="12" r="9"/><path stroke-linecap="round" stroke-linejoin="round" d="M15.2 8.8l-2.7 5.7-5.7 2.7 2.7-5.7 5.7-2.7z"/>'),
    clock:    svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>'),
    search:   svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>'),
    x:        svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>'),
    trash:    svgIc('<path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>')
  };

  /* ============ 最近搜索 ============ */
  function getRecent(){
    try{ var a = JSON.parse(lsGet(LS_RECENT, '[]')); return Array.isArray(a) ? a : []; }
    catch(e){ return []; }
  }
  function pushRecent(s){
    s = (s || '').trim(); if(!s) return;
    var a = getRecent().filter(function(x){ return x !== s; });
    a.unshift(s); a = a.slice(0, 8);
    lsSet(LS_RECENT, JSON.stringify(a));
  }
  function delRecent(s){
    lsSet(LS_RECENT, JSON.stringify(getRecent().filter(function(x){ return x !== s; })));
    renderSuggest();
  }

  /* ============ 建议列表 ============ */
  var selIdx = -1, curRows = [];

  function rowHTML(i, ic, title, sub, tag, extra){
    return '<div class="brw-sg-row flex items-center gap-3 px-4 py-2.5 cursor-pointer' + (extra ? ' ' + extra : '') + '" role="option" data-i="' + i + '">'
      + '<span class="brw-sg-ic shrink-0 text-m-on-surface-variant">' + ic + '</span>'
      + '<span class="brw-sg-tx flex-1 min-w-0"><span class="brw-sg-ti block text-sm font-medium truncate">' + __sgxUtil.esc(title) + '</span>'
      + (sub ? '<span class="brw-sg-sub block text-xs text-m-on-surface-variant truncate">' + __sgxUtil.esc(sub) + '</span>' : '')
      + '</span>'
      + (tag ? '<span class="brw-sg-tag shrink-0 text-[11px] text-m-on-primary-container bg-m-primary-container rounded-full px-2 py-0.5">' + __sgxUtil.esc(tag) + '</span>' : '')
      + '</div>';
  }

  function renderSuggest(){
    var q = input.value.trim();
    selIdx = -1; curRows = [];
    overlay.classList.toggle('has-text', q.length > 0);
    if(!q){ suggest.innerHTML = ''; renderHist(); return; }
    var ql = q.toLowerCase(), html = '';
    C_CATS.forEach(function(cat){
      var hits = INDEX.filter(function(x){
        return x.type === cat.type && ((x.t + ' ' + (x.d || '')).toLowerCase().indexOf(ql) !== -1);
      }).slice(0, 3);
      if(!hits.length) return;
      html += '<div class="brw-sg-group px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-m-on-surface-variant">' + __sgxUtil.esc(cat.label) + '</div>';
      hits.forEach(function(x){
        var i = curRows.length;
        curRows.push({ kind:'site', title: x.t, url: x.u });
        html += rowHTML(i, ICONS[cat.icon], x.t, x.d, cat.label);
      });
    });
    var ek = curEngine(), i = curRows.length;
    curRows.push({ kind:'engine', title: q });
    html += rowHTML(i, ICONS.search,
      t('用 ' + SE.name(ek) + ' 搜索', 'Search with ' + SE.name(ek)) + ' \u201C' + q + '\u201D',
      '', '', 'brw-sg-engine');
    /* 问 AI：跳到 /ai/?q= */
    var aiIdx = curRows.length;
    curRows.push({ kind:'ai', title: q });
    html += rowHTML(aiIdx, ICONS.sparkles,
      t('问 AI：', 'Ask AI: ') + ' \u201C' + q + '\u201D',
      '', 'AI');
    suggest.innerHTML = html;
  }

  function renderRecent(){
    var a = getRecent(), html = '';
    html += '<div class="brw-sg-group px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-m-on-surface-variant">' + __sgxUtil.esc(t('最近搜索', 'Recent searches')) + '</div>';
    if(!a.length){
      html += '<div class="brw-sg-empty px-4 py-6 text-center text-sm text-m-on-surface-variant">' + __sgxUtil.esc(t('暂无最近搜索', 'No recent searches')) + '</div>';
    }else{
      a.forEach(function(s){
        var i = curRows.length;
        curRows.push({ kind:'recent', title: s });
        html += '<div class="brw-sg-row flex items-center gap-3 px-4 py-2.5 cursor-pointer" role="option" data-i="' + i + '">'
          + '<span class="brw-sg-ic shrink-0 text-m-on-surface-variant">' + ICONS.clock + '</span>'
          + '<span class="brw-sg-tx flex-1 min-w-0"><span class="brw-sg-ti block text-sm truncate">' + __sgxUtil.esc(s) + '</span></span>'
          + '<span class="brw-sg-del shrink-0 p-1 text-m-on-surface-variant" data-del="' + __sgxUtil.esc(s) + '" role="button" aria-label="' + __sgxUtil.esc(t('删除', 'Delete')) + '">' + ICONS.x + '</span>'
          + '</div>';
      });
      html += '<div class="brw-sg-clear flex items-center justify-center gap-2 px-4 py-3 text-sm text-m-on-surface-variant cursor-pointer" data-clear="1">'
        + '<span class="brw-sg-ic">' + ICONS.trash + '</span><span>' + __sgxUtil.esc(t('全部清除', 'Clear all')) + '</span></div>';
    }
    suggest.innerHTML = html;
  }

  function showSuggest(){ /* 弹出层内建议列表常驻，无需显隐 */ }
  function hideSuggest(){ selIdx = -1; }
  function paintSel(){
    var rows = suggest.querySelectorAll('.brw-sg-row');
    for(var k = 0; k < rows.length; k++){
      rows[k].classList.toggle('is-sel', parseInt(rows[k].getAttribute('data-i'), 10) === selIdx);
    }
    var sel = suggest.querySelector('.brw-sg-row.is-sel');
    if(sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
  function moveSel(d){
    if(!curRows.length) return;
    selIdx = (selIdx + d + curRows.length) % curRows.length;
    paintSel();
  }

  function openUrl(u){
    hideSuggest();
    if(!u) return;
    if(/^https?:\/\//i.test(u)){ window.open(u, '_blank', 'noopener'); }
    else{ location.href = u; }
  }

  var URL_RE = /^[^\s]+\.[^\s]{2,}$/;
  var HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
  function doSearch(q){
    q = (q || '').trim(); if(!q) return;
    pushRecent(q);
    pushHist(q);
    hideSuggest();
    if(URL_RE.test(q) && !HAS_CJK.test(q)){
      var url = /^https?:\/\//i.test(q) ? q : 'https://' + q;
      window.open(url, '_blank', 'noopener');
      return;
    }
    var ek = curEngine();
    window.open(SE.url(ek, q), '_blank', 'noopener');
  }

  function activateRow(i){
    var r = curRows[i]; if(!r) return;
    if(r.kind === 'engine'){ doSearch(r.title); return; }
    if(r.kind === 'ai'){
      pushRecent(r.title); hideSuggest();
      location.href = (EN ? '/en/ai/' : '/ai/') + '?q=' + encodeURIComponent(r.title);
      return;
    }
    if(r.kind === 'recent'){ input.value = r.title; doSearch(r.title); return; }
    pushRecent(r.title);
    openUrl(r.url);
  }

  suggest.addEventListener('click', function(ev){
    var del = ev.target.closest ? ev.target.closest('[data-del]') : null;
    if(del){ ev.stopPropagation(); delRecent(del.getAttribute('data-del')); return; }
    var clr = ev.target.closest ? ev.target.closest('[data-clear]') : null;
    if(clr){ lsSet(LS_RECENT, '[]'); renderSuggest(); return; }
    var row = ev.target.closest ? ev.target.closest('.brw-sg-row') : null;
    if(!row) return;
    activateRow(parseInt(row.getAttribute('data-i'), 10));
  });

  input.addEventListener('input', function(){ renderSuggest(); showSuggest(); });
  input.addEventListener('focus', function(){ renderSuggest(); showSuggest(); });
  input.addEventListener('keydown', function(ev){
    if(ev.key === 'ArrowDown' || ev.key === 'ArrowUp'){
      ev.preventDefault();
      moveSel(ev.key === 'ArrowDown' ? 1 : -1);
    }else if(ev.key === 'Enter'){
      ev.preventDefault();
      if(selIdx >= 0 && curRows[selIdx]){ activateRow(selIdx); }
      else{ doSearch(input.value); }
    }else if(ev.key === 'Escape'){
      closeOverlay(false);
    }
  });

  /* ============ 2.3.14.4：弹层内最近搜索卡片 ============ */
  var LS_HIST = 'sgx-browser-history', LS_HIST_HIDE = 'sgx-browser-history-hidden';
  var histCard = document.getElementById('brw-hist-card'),
      histTags = document.getElementById('brw-hist-tags'),
      histShow = document.getElementById('brw-hist-show');
  function getHist(){
    try{ var a = JSON.parse(lsGet(LS_HIST, '[]')); return Array.isArray(a) ? a.slice(0, 12) : []; }
    catch(e){ return []; }
  }
  function setHist(a){ lsSet(LS_HIST, JSON.stringify(a)); }
  function pushHist(s){
    s = (s || '').trim(); if(!s) return;
    var a = getHist().filter(function(x){ return x !== s; });
    a.unshift(s); setHist(a.slice(0, 12));
  }
  function renderHist(){
    if(!histCard) return;
    var a = getHist(), hidden = lsGet(LS_HIST_HIDE, '') === '1';
    histCard.hidden = true; histShow.hidden = true;
    if(!a.length) return;
    if(hidden){ histShow.hidden = false; return; }
    histCard.hidden = false;
    histTags.innerHTML = a.map(function(s){
      return '<span class="brw-hist-tag"><span class="brw-hist-tx">' + __sgxUtil.esc(s) + '</span>'
        + '<span class="brw-hist-x" data-hx="' + __sgxUtil.esc(s) + '" role="button" aria-label="' + __sgxUtil.esc(t('删除', 'Delete')) + '">' + ICONS.x + '</span></span>';
    }).join('');
  }
  if(histTags){
    histTags.addEventListener('click', function(ev){
      var x = ev.target.closest ? ev.target.closest('[data-hx]') : null;
      if(x){
        ev.stopPropagation();
        setHist(getHist().filter(function(s){ return s !== x.getAttribute('data-hx'); }));
        renderHist(); return;
      }
      var tag = ev.target.closest ? ev.target.closest('.brw-hist-tag') : null;
      if(tag){
        var v = tag.querySelector('.brw-hist-tx').textContent;
        doSearch(v);
      }
    });
    document.getElementById('brw-hist-clear').addEventListener('click', function(){ setHist([]); renderHist(); });
    document.getElementById('brw-hist-hide').addEventListener('click', function(){ lsSet(LS_HIST_HIDE, '1'); renderHist(); });
    histShow.addEventListener('click', function(){ lsSet(LS_HIST_HIDE, ''); renderHist(); });
  }

  /* ============ 书签分类筛选 ============ */
  var catBtns = document.querySelectorAll('[data-brw-cat]');
  function filterCats(key){
    for(var k = 0; k < catBtns.length; k++){
      catBtns[k].classList.toggle('is-active', catBtns[k].getAttribute('data-brw-cat') === key);
    }
    var groups = document.querySelectorAll('[data-brw-catgroup]');
    for(var g = 0; g < groups.length; g++){
      groups[g].style.display = (key === 'all' || groups[g].getAttribute('data-brw-catgroup') === key) ? '' : 'none';
    }
  }
  for(var b = 0; b < catBtns.length; b++){
    (function(btn){
      btn.addEventListener('click', function(){ filterCats(btn.getAttribute('data-brw-cat')); });
    })(catBtns[b]);
  }

  /* 弹出层内建议列表由 CSS 限高（.brw-ov-top .brw-suggest），无需 JS 限高 */

  /* ============ ?q= 预填 / #focus 聚焦 ============ */
  function initFromUrl(){
    var q = null;
    try{ q = new URLSearchParams(location.search).get('q'); }catch(e){}
    if(q){ input.value = q; openOverlay(); renderSuggest(); }
    if(location.hash === '#focus'){ openOverlay(); }
  }
  window.addEventListener('hashchange', function(){
    if(location.hash === '#focus'){ openOverlay(); }
  });
  initFromUrl();
})();