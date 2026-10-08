(function(){
  var page='{{ .page }}', usePanel={{ if .panel }}true{{ else }}false{{ end }};
  var isEn={{ if .isEn }}true{{ else }}false{{ end }};
  var cap=document.getElementById('sgx-cap-'+page),
      input=document.getElementById('sgx-cap-input-'+page),
      panel=usePanel?document.getElementById('sgx-cap-results-'+page):null;
  if(!cap||!input)return;
  var opened=false, vv=window.visualViewport, reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var kbMaxSeen=0;
  /* VirtualKeyboard API（Chrome）：键盘悬浮不顶页面，胶囊 bottom 直接跟 env(keyboard-inset-height) 走，无 transition */
  var useVK=false;
  try{
    if(navigator.virtualKeyboard&&('overlaysContent' in navigator.virtualKeyboard)){
      navigator.virtualKeyboard.overlaysContent=true;useVK=true;
    }
  }catch(e){}
  /* 按键盘高度更新：宽度按 键盘高度/最终高度 同步插值；--sgx-kb 供结果浮层用 */
  function kbUpdate(h){
    h=Math.max(0,h||0);
    if(h>kbMaxSeen)kbMaxSeen=h;
    var p=kbMaxSeen<1?1:Math.min(1,h/kbMaxSeen);
    var vw=window.innerWidth||0;
    var baseW=Math.min(vw*0.64,300);
    var fullW=document.documentElement.classList.contains('layout-dex')?Math.min(480,Math.max(0,vw-32)):Math.max(0,vw-32);
    cap.style.width=Math.round(baseW+(fullW-baseW)*p)+'px';
    document.documentElement.style.setProperty('--sgx-kb',Math.round(h)+'px');
  }
  function open(){
    if(opened)return; opened=true;
    cap.classList.add('open');
    if(panel)panel.hidden=false;
    if(useVK){
      document.documentElement.classList.add('sgx-vk');
      var onGeo=function(e){var h=0;try{h=(e.target&&e.target.boundingRect&&e.target.boundingRect.height)||0}catch(_){}kbUpdate(h)};
      try{navigator.virtualKeyboard.addEventListener('geometrychange',onGeo)}catch(e){}
      cap._vkGeo=onGeo;
      kbUpdate(0);
    }else{
      /* 无 VK API：visualViewport resize/scroll → rAF → transform 定位到 vv 底边，无 transition */
      cap.classList.add('sgx-kb-sync');
      var raf=0;
      /* 2.3.14.10：应用页无 Dock，胶囊静止位置 bottom:12px（主页 88px，但胶囊只在应用页使用）；
         目标：键盘顶部上方 12px → translateY = (静止bottom - 12) - kbH */
      var capRest=document.body.classList.contains('subpage')?12:88;
      var upd=function(){
        raf=0;
        var h=vv?Math.max(0,window.innerHeight-vv.height-vv.offsetTop):0;
        kbUpdate(h);
        cap.style.transform='translateX(-50%) translateY('+Math.round(capRest-12-h)+'px)';
      };
      var sched=function(){if(!raf)raf=requestAnimationFrame(upd)};
      if(vv){vv.addEventListener('resize',sched);vv.addEventListener('scroll',sched)}
      cap._vvSched=sched;
      upd();
    }
    doSearch();
  }
  function close(){
    if(!opened)return; opened=false;
    cap.classList.remove('open');cap.classList.remove('sgx-kb-sync');
    document.documentElement.classList.remove('sgx-vk');
    cap.style.width='';cap.style.transform='';
    if(cap._vkGeo){try{navigator.virtualKeyboard.removeEventListener('geometrychange',cap._vkGeo)}catch(e){}cap._vkGeo=null}
    if(vv&&cap._vvSched){vv.removeEventListener('resize',cap._vvSched);vv.removeEventListener('scroll',cap._vvSched);cap._vvSched=null}
    if(panel){panel.hidden=true;panel.innerHTML=''}
    document.documentElement.style.setProperty('--sgx-kb','0px');
  }
  function doSearch(){
    if(typeof window.__sgxCapSearch!=='function')return;
    var html=window.__sgxCapSearch(page,input.value.trim())||'';
    if(panel){
      panel.innerHTML=html;
      panel.hidden=!html;
      if(html){panel.classList.remove('sgx-fade');void panel.offsetWidth;if(!reduced)panel.classList.add('sgx-fade')}
    }
  }
  var deb=null;
  /* 2.3.14.6：触屏点输入框时手动聚焦并禁止浏览器自动滚动页面（页面全程不动） */
  input.addEventListener('touchstart',function(e){
    if(document.activeElement!==input){
      try{e.preventDefault()}catch(_){}
      try{input.focus({preventScroll:true})}catch(err){try{input.focus()}catch(_){}}
    }
  },{passive:false});
  input.addEventListener('focus',function(){open()});
  input.addEventListener('input',function(){if(!opened)open();clearTimeout(deb);deb=setTimeout(doSearch,150)});
  input.addEventListener('keydown',function(e){
    if(e.key==='Escape'){input.blur();close()}
    else if(e.key==='Enter'){doSearch();if(page==='store'){input.blur();close()}}
  });
  /* 失焦后收起（延迟一点，让结果里的点击先触发） */
  input.addEventListener('blur',function(){
    setTimeout(function(){
      if(panel&&panel.contains(document.activeElement))return;
      close();
    },180);
  });
  if(panel){
    panel.addEventListener('click',function(e){
      var t=e.target.closest('a,button');
      if(t)setTimeout(close,80);
    });
  }
  /* 语音输入（2.3.14.6）：走共享语音弹窗；只检测 SpeechRecognition 接口是否存在，不按 UA 判断；
     不支持则麦克风不渲染（无空位、无报错） */
  var mic=cap.querySelector('[data-mic]');
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(mic&&SR){
    mic.style.display='';
    mic.addEventListener('click',function(e){
      e.stopPropagation();
      window.__sgxVoiceSheet({onFinal:function(t){if(!opened)open();input.value=t;doSearch()}});
    });
  }
  /* 页面底部留白：胶囊不压内容，最后一项能完整滚出 */
  document.body.classList.add('sgx-cap-pad');
})();