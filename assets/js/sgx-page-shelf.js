(function(){
  /* 书单对接书库 /api/shelf（2.3.11）：
   * 有书 → 只显示书库的书（封面+书名+作者；有 read_url 可点去书站读，没有则不可点）
   * 为空/超时/报错 → 保留现有静态书单，页面不闪、不报错 */
  {{ if eq .kind "books" }}
  var grid = document.querySelector('.grid.grid-cols-2');
  if(!grid) return;
  function renderShelf(books){
    grid.innerHTML = books.map(function(b){
      var cover = '<img src="' + __sgxUtil.esc(b.cover_url) + '" alt="' + __sgxUtil.esc(b.title) + '" loading="lazy" decoding="async" class="w-full aspect-[3/4] object-cover">';
      var inner = '<div class="shelf-cover relative overflow-hidden rounded-[1.4rem] border border-m-outline bg-m-container shadow-sm">' + cover + '</div>' +
        '<figcaption class="mt-2.5 px-0.5 min-w-0">' +
        '<p class="font-semibold text-sm truncate">' + __sgxUtil.esc(b.title) + '</p>' +
        (b.author ? '<p class="text-xs text-m-on-surface-variant truncate mt-0.5">' + __sgxUtil.esc(b.author) + '</p>' : '') +
        '</figcaption>';
      if(b.read_url){
        return '<a href="' + __sgxUtil.esc(b.read_url) + '" target="_blank" rel="noopener" class="shelf-card group min-w-0 block">' + inner + '</a>';
      }
      return '<figure class="shelf-card group min-w-0">' + inner + '</figure>';
    }).join('');
  }
  try{
    var ctrl = new AbortController();
    var timer = setTimeout(function(){ ctrl.abort(); }, 8000);
    fetch('https://book.styrigx.com/api/shelf', {signal: ctrl.signal})
      .then(function(r){ clearTimeout(timer); if(!r.ok) throw 0; return r.json(); })
      .then(function(j){
        var books = (j && j.books) || [];
        if(books.length) renderShelf(books);
      })
      .catch(function(){ /* 保持静态书单 */ });
  }catch(e){}
  {{ end }}
  /* 触屏点封面 → bottom sheet 看批注；桌面端悬停已由 CSS 处理 */
  var en=document.documentElement.lang==='en';
  var coarse=window.matchMedia('(hover: none)').matches;
  if(coarse&&window.__openSheet){
    document.querySelectorAll('.shelf-card').forEach(function(card){
      var cover=card.querySelector('.shelf-cover');
      function open(){
        var t=card.dataset.title,c=card.dataset.comment,u=card.dataset.url;
        var html='<p class="text-sm leading-relaxed text-m-on-surface px-1">'+String(c||'').replace(/</g,'&lt;')+'</p>';
        if(u&&u!=='#')html+='<a href="'+u.replace(/"/g,'&quot;')+'" target="_blank" rel="noopener" class="mt-4 inline-flex items-center gap-1.5 rounded-full bg-m-primary px-5 py-2.5 text-sm font-semibold text-m-on-primary">'+(en?'Open link':'打开链接')+'</a>';
        window.__openSheet({title:t,html:html});
      }
      cover.addEventListener('click',open);
      cover.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}});
    });
  }
  /* 歌单页：在此收听 → 卡片内展开嵌入（同时只展开一个） */
  document.querySelectorAll('.shelf-card').forEach(function(card){
    var btn=card.querySelector('.shelf-listen'),box=card.querySelector('.shelf-embed');
    if(!btn||!box)return;
    btn.addEventListener('click',function(){
      var isOpen=!box.classList.contains('hidden');
      /* 先收起所有 */
      document.querySelectorAll('.shelf-embed').forEach(function(b){b.classList.add('hidden');b.innerHTML=''});
      document.querySelectorAll('.shelf-listen').forEach(function(b){b.setAttribute('aria-expanded','false')});
      if(isOpen)return;
      /* 首页试听在播就先暂停 */
      if(window.__npPause)window.__npPause();
      var sp=card.dataset.spotify,yt=card.dataset.youtube;
      var html='';
      if(sp){
        html='<iframe src="https://open.spotify.com/embed/track/'+encodeURIComponent(sp)+'" height="152" style="border-radius:12px" width="100%" frameborder="0" allowfullscreen loading="lazy" decoding="async" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="Spotify"></iframe>';
        if(yt)html+='<a href="https://www.youtube.com/watch?v='+encodeURIComponent(yt)+'" target="_blank" rel="noopener" class="mt-2 inline-block text-xs text-m-primary hover:underline">'+(en?'YouTube full version':'YouTube 完整版')+'</a>';
      }else if(yt){
        html='<div style="position:relative;padding-top:56.25%;border-radius:12px;overflow:hidden"><iframe src="https://www.youtube-nocookie.com/embed/'+encodeURIComponent(yt)+'" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" allowfullscreen loading="lazy" decoding="async" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="YouTube"></iframe></div>';
      }
      if(html){box.innerHTML=html;box.classList.remove('hidden');btn.setAttribute('aria-expanded','true')}
    });
  });
})();