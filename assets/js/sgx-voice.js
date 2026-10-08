(function(){
  if(window.__sgxVoiceSheet)return;
  window.__sgxVoiceSheet=function(opts){
    opts=opts||{};
    var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR||window.__sgxVsOpen)return false;
    window.__sgxVsOpen=true;
    var isEn=document.documentElement.lang==='en';
    var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var T={
      speak:isEn?'Speak now':'立即说出',
      langName:isEn?'English (US)':'中文（中国）',
      retry:isEn?"Didn't catch that, tap the mic to retry":'没听清，点麦克风重试',
      noperm:isEn?'Microphone permission needed':'需要麦克风权限',
      aria:isEn?'Voice input':'语音输入'
    };
    /* 收起键盘 */
    try{if(document.activeElement&&document.activeElement.blur)document.activeElement.blur()}catch(e){}
    var ov=document.createElement('div');
    ov.className='sgx-vs-ov';
    ov.innerHTML=
      '<div class="sgx-vs-card" role="dialog" aria-modal="true" aria-label="'+T.aria+'">'+
        '<div class="sgx-vs-tx"><div class="sgx-vs-l1"></div><div class="sgx-vs-l2"></div></div>'+
        '<button type="button" class="sgx-vs-btn" aria-label="'+T.aria+'">'+
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15zm6-3.5a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 11.5h-2z"/></svg>'+
        '</button>'+
      '</div>';
    var card=ov.firstChild,
        l1=card.querySelector('.sgx-vs-l1'),
        l2=card.querySelector('.sgx-vs-l2'),
        btn=card.querySelector('.sgx-vs-btn');
    l1.textContent=T.speak;l2.textContent=T.langName;
    document.body.appendChild(ov);
    var rec=null,finalTxt='',finished=false,timer=null;
    function setListening(on){btn.classList.toggle('listening',on)}
    function teardown(){
      if(timer){clearTimeout(timer);timer=null}
      document.removeEventListener('keydown',onKey,true);
      window.__sgxVsOpen=false;
      if(ov.parentNode)ov.parentNode.removeChild(ov);
    }
    function hide(){ov.classList.remove('show');setTimeout(teardown,reduced?0:280)}
    function cancel(){
      if(finished&&!btn.classList.contains('listening')){hide();return}
      finished=true;setListening(false);
      try{if(rec)rec.abort()}catch(e){}
      hide();
    }
    function onKey(e){if(e.key==='Escape'){e.stopPropagation();cancel()}}
    function start(){
      finished=false;finalTxt='';
      l1.textContent=T.speak;l2.textContent=T.langName;setListening(true);
      try{
        rec=new SR();
        rec.lang=isEn?'en-US':'zh-CN';
        rec.interimResults=true;rec.maxAlternatives=1;
        rec.onresult=function(ev){
          var f='',im='';
          try{
            for(var i=0;i<ev.results.length;i++){
              var tr=ev.results[i][0].transcript||'';
              if(ev.results[i].isFinal)f+=tr;else im+=tr;
            }
          }catch(e){}
          if(f)finalTxt=f;
          var disp=(im||f).trim();
          if(disp.length>24)disp='…'+disp.slice(-24);
          if(disp)l1.textContent=disp;
        };
        rec.onerror=function(ev){
          if(finished)return;
          var c=(ev&&ev.error)||'';
          if(c==='not-allowed'||c==='service-not-allowed'){
            finished=true;setListening(false);l1.textContent=T.noperm;
            timer=setTimeout(function(){hide()},2000);
          }
        };
        rec.onend=function(){
          if(finished)return;finished=true;setListening(false);
          var t=finalTxt.trim();
          if(t){hide();try{if(opts.onFinal)opts.onFinal(t)}catch(e){}}
          else{l1.textContent=T.retry}
        };
        rec.start();
        timer=setTimeout(function(){try{if(rec)rec.stop()}catch(e){}},8000);
      }catch(e){setListening(false);l1.textContent=T.retry}
    }
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      if(btn.classList.contains('listening')){try{if(rec)rec.stop()}catch(e){}}
      else{if(timer){clearTimeout(timer);timer=null}start()}
    });
    ov.addEventListener('click',function(e){if(e.target===ov)cancel()});
    document.addEventListener('keydown',onKey,true);
    requestAnimationFrame(function(){requestAnimationFrame(function(){ov.classList.add('show')})});
    start();
    return true;
  };
})();