/**
 * @fileoverview 书单/歌单页（shelf）：书库对接、触屏批注、歌单试听展开。
 * 文案来自页面内 sgx-i18n-shelf JSON（中英双语），JS 与语言无关。
 */
import { on } from '../lib/events.js';
import { esc } from '../lib/util.js';
import { loadI18n } from '../lib/i18n.js';
import { openSheet } from '../shell/sheet.js';
import { SGX } from '../lib/sgx.js';

(function () {
  const T = loadI18n('sgx-i18n-shelf');
  /* shelf.html 主容器输出 data-shelf="books|music" */
  const kindEl = document.querySelector('[data-shelf]');
  const kind = (kindEl && kindEl.getAttribute('data-shelf')) || '';

  /* 书单对接书库 /api/shelf：
   * 有书 → 只显示书库的书（封面+书名+作者；有 read_url 可点去书站读，没有则不可点）
   * 为空/超时/报错 → 保留现有静态书单，页面不闪、不报错 */
  if (kind === 'books') {
    const grid = document.querySelector('.grid.grid-cols-2');
    if (grid) {
      /** @param {Array<any>} books */
      const renderShelf = function (books) {
        grid.innerHTML = books
          .map(function (b) {
            const cover =
              '<img src="' + esc(b.cover_url) + '" alt="' + esc(b.title) + '" loading="lazy" decoding="async" class="w-full aspect-[3/4] object-cover">';
            const inner =
              '<div class="shelf-cover relative overflow-hidden rounded-[1.4rem] border border-m-outline bg-m-container shadow-sm">' + cover + '</div>' +
              '<figcaption class="mt-2.5 px-0.5 min-w-0">' +
              '<p class="font-semibold text-sm truncate">' + esc(b.title) + '</p>' +
              (b.author ? '<p class="text-xs text-m-on-surface-variant truncate mt-0.5">' + esc(b.author) + '</p>' : '') +
              '</figcaption>';
            if (b.read_url) {
              return (
                '<a href="' + esc(b.read_url) + '" target="_blank" rel="noopener" class="shelf-card group min-w-0 block">' + inner + '</a>'
              );
            }
            return '<figure class="shelf-card group min-w-0">' + inner + '</figure>';
          })
          .join('');
      };
      try {
        const ctrl = new AbortController();
        const timer = window.setTimeout(function () {
          ctrl.abort();
        }, 8000);
        fetch('https://book.styrigx.com/api/shelf', { signal: ctrl.signal })
          .then(function (r) {
            clearTimeout(timer);
            if (!r.ok) throw 0;
            return r.json();
          })
          .then(function (j) {
            const books = (j && j.books) || [];
            if (books.length) renderShelf(books);
          })
          .catch(function () {
            /* 保持静态书单 */
          });
      } catch (e) {}
    }
  }

  /* 触屏点封面 → bottom sheet 看批注；桌面端悬停已由 CSS 处理 */
  const coarse = window.matchMedia('(hover: none)').matches;
  if (coarse) {
    document.querySelectorAll('.shelf-card').forEach(function (card) {
      const cover = card.querySelector('.shelf-cover');
      if (!cover) return;
      function open() {
        const t = card.getAttribute('data-title'),
          c = card.getAttribute('data-comment'),
          u = card.getAttribute('data-url');
        let html =
          '<p class="text-sm leading-relaxed text-m-on-surface px-1">' + String(c || '').replace(/</g, '&lt;') + '</p>';
        if (u && u !== '#')
          html +=
            '<a href="' + u.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener" class="mt-4 inline-flex items-center gap-1.5 rounded-full bg-m-primary px-5 py-2.5 text-sm font-semibold text-m-on-primary">' +
            T.t('openLink') + '</a>';
        openSheet({ title: t || '', html: html });
      }
      on(cover, 'click', open);
      on(cover, 'keydown', function (/** @type {KeyboardEvent} */ e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  /* 歌单页：在此收听 → 卡片内展开嵌入（同时只展开一个） */
  document.querySelectorAll('.shelf-card').forEach(function (card) {
    const btn = card.querySelector('.shelf-listen'),
      box = card.querySelector('.shelf-embed');
    if (!btn || !box) return;
    on(btn, 'click', function () {
      const isOpen = !box.classList.contains('hidden');
      /* 先收起所有 */
      document.querySelectorAll('.shelf-embed').forEach(function (b) {
        b.classList.add('hidden');
        b.innerHTML = '';
      });
      document.querySelectorAll('.shelf-listen').forEach(function (b) {
        b.setAttribute('aria-expanded', 'false');
      });
      if (isOpen) return;
      /* 首页试听在播就先暂停 */
      if (SGX.npPause) SGX.npPause();
      const sp = card.getAttribute('data-spotify'),
        yt = card.getAttribute('data-youtube');
      let html = '';
      if (sp) {
        html =
          '<iframe src="https://open.spotify.com/embed/track/' + encodeURIComponent(sp) +
          '" height="152" style="border-radius:12px" width="100%" frameborder="0" allowfullscreen loading="lazy" decoding="async" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="Spotify"></iframe>';
        if (yt)
          html +=
            '<a href="https://www.youtube.com/watch?v=' + encodeURIComponent(yt) + '" target="_blank" rel="noopener" class="mt-2 inline-block text-xs text-m-primary hover:underline">' +
            T.t('ytFull') + '</a>';
      } else if (yt) {
        html =
          '<div style="position:relative;padding-top:56.25%;border-radius:12px;overflow:hidden"><iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(yt) +
          '" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" allowfullscreen loading="lazy" decoding="async" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" title="YouTube"></iframe></div>';
      }
      if (html) {
        box.innerHTML = html;
        box.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
})();
