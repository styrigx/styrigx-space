/**
 * @fileoverview 我的文件页：主页分组渲染、列表/网格模式、搜索、收藏、⋮ 菜单。
 * 文案来自页面内 files-i18n JSON（沿用旧格式）。
 */
import { on } from './events.js';
import { esc } from './util.js';
import { getJSON, setJSON } from './storage.js';
import { getScheduler } from './scheduler.js';
import { openSheet } from './sheet.js';
import { setCapSearchProvider } from './capsule.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let I = {};
  try {
    I = JSON.parse(document.getElementById('files-i18n').textContent || '{}');
  } catch (e) {}
  const S = I.str || {},
    TYPES = I.types || [],
    DEFAULTS = I.defaults || [];
  /** @type {Record<string, any>} */
  const typeById = {};
  TYPES.forEach(function (/** @type {any} */ t) {
    typeById[t.id] = t;
  });

  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }
  /** @param {string} k @param {any} d */
  function get(k, d) {
    const v = getJSON(k, undefined);
    return v === undefined ? d : v;
  }
  /** @param {string} k @param {any} v */
  function set(k, v) {
    setJSON(k, v);
  }
  function reduced() {
    return document.documentElement.classList.contains('reduced-motion');
  }

  const ICONS = {
    search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 21l-5.2-5.2M15.5 10.5a5 5 0 11-10 0 5 5 0 0110 0z"/></svg>',
    chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-m-on-surface-variant shrink-0"><path d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>',
    folder: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
    pen: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.86 4.49l1.69-1.69a1.88 1.88 0 112.65 2.65L10.58 16.07a4.5 4.5 0 01-1.9 1.13L6 18l.8-2.69a4.5 4.5 0 011.13-1.9z"/></svg>',
    book: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.04A9 9 0 006 3.75c-1.05 0-2.06.18-3 .51v14.25A9 9 0 016 18c2.3 0 4.41.87 6 2.29m0-14.25a9 9 0 016-2.29c1.05 0 2.06.18 3 .51v14.25A9 9 0 0018 18a9 9 0 00-6 2.29m0-14.25v14.25"/></svg>',
    music: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  };

  /* ---------- 模式与偏好 ---------- */
  const params = new URLSearchParams(location.search);
  const qtype = params.get('type');
  const VALID = ['post', 'book', 'music', 'site', 'fav'];
  const listMode = VALID.indexOf(qtype || '') >= 0;

  const view = get('sgx-files-view', null) || {};
  if (view.sort !== 'name') view.sort = 'added';
  if (view.layout !== 'grid') view.layout = 'list';
  function saveView() {
    set('sgx-files-view', view);
  }

  const GROUPS = ['cats', 'sites', 'recent', 'storage', 'fav'];
  const homeVis = get('sgx-files-home', null) || {};
  GROUPS.forEach(function (g) {
    if (homeVis[g] === undefined) homeVis[g] = true;
  });

  /* 收藏默认 4 项：首次写入 sgx-files-fav */
  try {
    if (localStorage.getItem('sgx-files-fav') === null) set('sgx-files-fav', DEFAULTS);
  } catch (e) {}

  /** @type {Array<any>} */
  let DATA = [];

  /* ---------- toast ---------- */
  /** @type {number|null} */
  let toastTimer = null;
  /** @param {string} msg */
  function toast(msg) {
    let t = $('files-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'files-toast';
      t.className = 'files-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      const tt = $('files-toast');
      if (tt) tt.classList.remove('show');
    }, 2000);
  }

  /* ---------- 最近访问（只记站内） ---------- */
  /** @param {string} u */
  function sameOrigin(u) {
    try {
      return new URL(u, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }
  function getRecent() {
    return get('sgx-files-recent', []);
  }
  /** @param {any} item */
  function recordVisit(item) {
    if (!item || !item.url || !sameOrigin(item.url)) return;
    const r = getRecent().filter(function (/** @type {any} */ x) {
      return x.url !== item.url;
    });
    r.unshift({ id: item.id || item.url, title: item.title || '', url: item.url });
    set('sgx-files-recent', r.slice(0, 4));
  }
  on(document, 'click', function (/** @type {MouseEvent} */ e) {
    const t = /** @type {Element|null} */ (e.target);
    const a = t && t.closest ? t.closest('[data-visit]') : null;
    if (!a) return;
    let it = null;
    try {
      it = JSON.parse(a.getAttribute('data-visit') || 'null');
    } catch (err) {}
    recordVisit(it);
  });

  /* ---------- 收藏 ---------- */
  function getFavs() {
    return get('sgx-files-fav', []);
  }
  /** @param {any} item */
  function toggleFav(item) {
    if (!item || !item.id) return;
    const favs = getFavs();
    let i = -1;
    for (let k = 0; k < favs.length; k++) {
      if (favs[k].id === item.id) {
        i = k;
        break;
      }
    }
    if (i >= 0) {
      favs.splice(i, 1);
      toast(S.removedFav || '');
    } else {
      favs.unshift({ id: item.id, title: item.title || '', url: item.url || '' });
      toast(S.addedFav || '');
    }
    set('sgx-files-fav', favs);
    renderFav();
    if (listMode && qtype === 'fav') renderList();
  }
  /** @param {any} it */
  function favAttrs(it) {
    const j = esc(JSON.stringify({ id: it.id, title: it.title, url: it.url }));
    return "data-visit='" + j + "' data-fav-item='" + j + "'";
  }

  /* 长按：添加到收藏 / 移除 */
  /** @param {Element|null} scope */
  function bindLongPress(scope) {
    if (!scope) return;
    scope.querySelectorAll('[data-fav-item]').forEach(function (el) {
      const ell = /** @type {any} */ (el);
      if (ell._flp) return;
      ell._flp = true;
      /** @type {number|null} */
      let timer = null;
      let fired = false;
      function start() {
        fired = false;
        timer = window.setTimeout(function () {
          fired = true;
          let it = null;
          try {
            it = JSON.parse(el.getAttribute('data-fav-item') || 'null');
          } catch (e) {}
          toggleFav(it);
        }, 550);
      }
      function cancel() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
      on(el, 'touchstart', start, { passive: true });
      on(el, 'touchend', function () {
        cancel();
      });
      on(el, 'touchmove', cancel, { passive: true });
      on(el, 'mousedown', start);
      on(el, 'mouseup', cancel);
      on(el, 'mouseleave', cancel);
      on(
        el,
        'click',
        function (e) {
          if (fired) {
            e.preventDefault();
            e.stopPropagation();
            fired = false;
          }
        },
        { capture: true }
      );
      on(el, 'contextmenu', function (e) {
        e.preventDefault();
      });
    });
  }

  /* ---------- 排序 ---------- */
  /** @param {any} a @param {any} b */
  function byAdded(a, b) {
    return (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0);
  }
  /** @param {Array<any>} items */
  function sortItems(items) {
    const arr = items.slice();
    if (view.sort === 'name') arr.sort(function (a, b) {
      return String(a.title || '').localeCompare(String(b.title || ''), en ? 'en' : 'zh');
    });
    else arr.sort(byAdded);
    return arr;
  }

  /* ---------- 缩略图 ---------- */
  /** @param {any} it @param {string} cls */
  function thumbHTML(it, cls) {
    const t = typeById[it.type] || {};
    const inner = it.cover
      ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy" decoding="async" class="w-full h-full object-cover">'
      : '<span class="w-full h-full ' + (t.bar || 'bg-m-container-highest') + ' flex items-center justify-center text-white">' + (ICONS[t.icon] || '') + '</span>';
    return (
      '<span class="' + cls + ' relative block overflow-hidden rounded-2xl bg-m-container shrink-0">' + inner +
      '<span class="absolute inset-x-0 bottom-0 px-1.5 pt-4 pb-1 text-[10px] leading-tight text-white truncate" style="background:linear-gradient(to top,rgba(0,0,0,.65),transparent)">' +
      esc(it.title || '') + '</span></span>'
    );
  }

  /* ---------- 主页渲染 ---------- */
  function renderRecent() {
    const now = Date.now(),
      cutoff = now - 30 * 24 * 3600 * 1000;
    const items = DATA.filter(function (it) {
      const t = Date.parse(it.addedAt || '');
      return t && t >= cutoff;
    }).sort(byAdded);
    const titleEl = $('files-recent-title');
    if (titleEl) titleEl.textContent = (S.recentAddedPre || '') + items.length + (S.recentAddedSuf || '');
    /* 上次打开后有新内容 → 橙色小圆点 */
    const lastVisit = get('sgx-files-lastvisit', 0);
    const hasNew = items.some(function (it) {
      return (Date.parse(it.addedAt || '') || 0) > lastVisit;
    });
    const dot = $('files-newdot');
    if (dot) dot.classList.toggle('hidden', !hasNew);
    set('sgx-files-lastvisit', now);
    const box = $('files-recent-thumbs');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '<p class="py-6 px-2 text-sm text-m-on-surface-variant">' + (S.empty || '') + '</p>';
      return;
    }
    box.innerHTML = items
      .slice(0, 4)
      .map(function (it) {
        const ext = /^https?:/.test(it.url || '');
        return (
          '<a href="' + esc(it.url || '#') + '" ' + (ext ? 'target="_blank" rel="noopener"' : '') + ' ' + favAttrs(it) +
          ' class="block active:scale-95 transition-transform" aria-label="' + esc(it.title || '') + '">' +
          thumbHTML(it, 'w-20 h-20') + '</a>'
        );
      })
      .join('');
    bindLongPress(box);
  }
  function renderRecentVisits() {
    const box = $('files-recent-visits');
    if (!box) return;
    const r = getRecent();
    if (!r.length) {
      box.innerHTML = '<p class="text-sm text-m-on-surface-variant">' + esc(S.noVisits || '') + '</p>';
      return;
    }
    box.innerHTML = r
      .map(function (/** @type {any} */ x) {
        return (
          '<a href="' + esc(x.url) + '" data-visit=\'' + esc(JSON.stringify(x)) +
          '\' class="max-w-full truncate rounded-full bg-m-container px-3.5 py-2 text-sm active:scale-95 transition-transform">' +
          esc(x.title || x.url) + '</a>'
        );
      })
      .join('');
  }
  function renderStorage() {
    /** @type {Record<string, number>} */
    const counts = {};
    TYPES.forEach(function (/** @type {any} */ t) {
      counts[t.id] = 0;
    });
    DATA.forEach(function (it) {
      if (counts[it.type] !== undefined) counts[it.type]++;
    });
    const total = DATA.length;
    const totalEl = $('files-storage-total');
    if (totalEl) totalEl.textContent = (S.storageTotalPre || '') + total + (S.storageTotalSuf || '');
    const bar = $('files-segbar');
    if (bar) {
      if (!total) {
        bar.innerHTML = '<span class="w-full h-full bg-m-container-highest"></span>';
      } else {
        bar.innerHTML = TYPES.map(function (/** @type {any} */ t) {
          const n = counts[t.id] || 0;
          if (!n) return '';
          return (
            '<span class="' + t.bar + ' h-full" style="width:' + ((n / total) * 100).toFixed(1) + '%" title="' +
            esc(t.label) + ' ' + n + '"></span>'
          );
        }).join('');
      }
    }
    const detail = $('files-storage-detail');
    if (detail)
      detail.innerHTML = TYPES.map(function (/** @type {any} */ t) {
        const n = counts[t.id] || 0;
        return (
          '<a href="' + esc(I.filesBase || '/files/') + '?type=' + t.id + '" class="flex items-center gap-3 py-2">' +
          '<span class="w-9 h-9 rounded-full bg-m-container flex items-center justify-center ' + (t.fg || 'text-m-on-surface-variant') + '">' +
          (ICONS[t.icon] || '') + '</span>' +
          '<span class="flex-1 text-sm">' + esc(t.label) + '</span>' +
          '<span class="text-sm font-semibold tabular-nums">' + n + '</span></a>'
        );
      }).join('');
  }
  /** @param {any} it */
  function favRowHTML(it) {
    return (
      '<li><div class="flex items-center gap-4 px-1">' +
      '<span class="w-6 h-6 text-m-on-surface-variant shrink-0 inline-flex items-center justify-center">' + ICONS.folder + '</span>' +
      '<a href="' + esc(it.url || '#') + '" ' + favAttrs(it) + ' class="row-line flex-1 min-w-0 flex items-center justify-between gap-3 py-3.5">' +
      '<span class="truncate text-[15px]">' + esc(it.title || '') + '</span>' + ICONS.chev + '</a></div></li>'
    );
  }
  function renderFav() {
    const box = $('files-fav-list');
    if (!box) return;
    box.innerHTML = getFavs().map(favRowHTML).join('');
    bindLongPress(box);
  }

  function applyHomeVis() {
    document.querySelectorAll('[data-home-group]').forEach(function (g) {
      /** @type {HTMLElement} */ (g).style.display = homeVis[g.getAttribute('data-home-group') || ''] === false ? 'none' : '';
    });
  }

  /* ---------- 列表模式 ---------- */
  /** @param {any} it */
  function rowHTML(it) {
    const t = typeById[it.type] || {};
    const th = it.cover
      ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy" decoding="async" width="48" height="48" class="w-12 h-12 rounded-xl object-cover shrink-0 bg-m-container">'
      : '<span class="w-12 h-12 rounded-xl ' + (t.bar || 'bg-m-container-highest') + ' text-white flex items-center justify-center shrink-0">' + (ICONS[t.icon] || ICONS.folder) + '</span>';
    const ext = /^https?:/.test(it.url || '');
    return (
      '<a href="' + esc(it.url || '#') + '" ' + (ext ? 'target="_blank" rel="noopener"' : '') + ' ' + favAttrs(it) +
      ' class="flex items-center gap-3.5 px-4 py-3 active:bg-m-container transition-colors">' + th +
      '<span class="flex-1 min-w-0"><span class="block truncate text-[15px] font-medium">' + esc(it.title || '') + '</span>' +
      (it.subtitle ? '<span class="block truncate text-xs text-m-on-surface-variant mt-0.5">' + esc(it.subtitle) + '</span>' : '') +
      '</span></a>'
    );
  }
  /** @param {any} it */
  function gridCardHTML(it) {
    const t = typeById[it.type] || {};
    const media = it.cover
      ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy" decoding="async" class="w-full aspect-[4/3] object-cover bg-m-container">'
      : '<span class="w-full aspect-[4/3] ' + (t.bar || 'bg-m-container-highest') + ' text-white flex items-center justify-center">' + (ICONS[t.icon] || ICONS.folder) + '</span>';
    const ext = /^https?:/.test(it.url || '');
    return (
      '<a href="' + esc(it.url || '#') + '" ' + (ext ? 'target="_blank" rel="noopener"' : '') + ' ' + favAttrs(it) +
      ' class="block rounded-3xl overflow-hidden bg-m-container-lowest border border-m-outline active:scale-[0.98] transition-transform">' + media +
      '<span class="block p-3"><span class="block truncate text-sm font-medium">' + esc(it.title || '') + '</span>' +
      (it.subtitle ? '<span class="block truncate text-xs text-m-on-surface-variant mt-0.5">' + esc(it.subtitle) + '</span>' : '') +
      '</span></a>'
    );
  }
  function listItems() {
    if (qtype === 'fav')
      return getFavs().map(function (/** @type {any} */ f) {
        return { id: f.id, title: f.title, subtitle: f.url, url: f.url, cover: '', type: 'fav' };
      });
    return DATA.filter(function (it) {
      return it.type === qtype;
    });
  }
  function renderList() {
    const t = typeById[qtype || ''];
    const title = qtype === 'fav' ? S.fav || '' : (t && t.label) || qtype;
    const items = sortItems(listItems());
    const h1 = document.querySelector('.subpage-title');
    if (h1) h1.textContent = title;
    document.title = title + ' | Styrigx';
    const countEl = $('files-count');
    if (countEl) countEl.textContent = (S.countPre || '') + items.length + (S.countSuf || '');
    const sb = $('files-sort-btn');
    if (sb) sb.textContent = view.sort === 'name' ? S.byName || '' : S.addedAt || '';
    document.querySelectorAll('.files-seg button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-l') === view.layout);
    });
    const box = $('files-items');
    if (!box) return;
    if (!items.length) {
      box.className = '';
      box.innerHTML = '<p class="py-16 text-center text-sm text-m-on-surface-variant">' + esc(S.empty || '') + '</p>';
      return;
    }
    if (view.layout === 'grid') {
      box.className = 'grid grid-cols-2 sm:grid-cols-3 gap-4';
      box.innerHTML = items.map(gridCardHTML).join('');
    } else {
      box.className = 'files-listrows widget bg-m-container-lowest border border-m-outline overflow-hidden';
      box.innerHTML = items.map(rowHTML).join('');
    }
    bindLongPress(box);
  }

  /* ---------- ⋮ 菜单 ---------- */
  const GROUP_LABELS = { cats: S.gCats, recent: S.gRecent, storage: S.gStorage, fav: S.gFav };
  function openSort() {
    openSheet({
      title: S.sortBy || '',
      options: [
        { label: S.addedAt || '', value: 'added', checked: view.sort === 'added' },
        { label: S.byName || '', value: 'name', checked: view.sort === 'name' },
      ],
      onPick: function (v) {
        view.sort = v;
        saveView();
        if (listMode) renderList();
      },
    });
  }
  function openHomeEdit() {
    const rows = GROUPS.map(function (g) {
      const on_ = homeVis[g] !== false;
      return (
        '<button type="button" class="sheet-opt" data-hg="' + g + '">' +
        '<span class="flex-1 min-w-0 text-left"><span class="block font-medium">' + esc(GROUP_LABELS[g] || g) + '</span></span>' +
        '<span class="switch" role="switch" aria-checked="' + on_ + '" aria-label="' + esc(GROUP_LABELS[g] || g) + '"><span class="knob"></span></span></button>'
      );
    }).join('');
    openSheet({ title: S.editHome || '', html: '<div class="pb-2">' + rows + '</div>' });
    const sb = $('sheet-body');
    if (sb && !/** @type {any} */ (sb)._hgBound) {
      /** @type {any} */ (sb)._hgBound = true;
      on(sb, 'click', function (/** @type {MouseEvent} */ e) {
        const t = /** @type {Element|null} */ (e.target);
        const b = t && t.closest ? t.closest('[data-hg]') : null;
        if (!b) return;
        const g = b.getAttribute('data-hg') || '';
        homeVis[g] = !(homeVis[g] !== false);
        set('sgx-files-home', homeVis);
        const sw = b.querySelector('.switch');
        if (sw) sw.setAttribute('aria-checked', homeVis[g] ? 'true' : 'false');
        applyHomeVis();
      });
    }
  }
  function openMore() {
    openSheet({
      title: '',
      options: [
        { label: S.editHome || '', value: 'home' },
        { label: S.sortBy || '', sub: view.sort === 'name' ? S.byName || '' : S.addedAt || '', value: 'sort' },
        { label: S.settings || '', value: 'settings' },
      ],
      onPick: function (v) {
        if (v === 'home') openHomeEdit();
        else if (v === 'sort') openSort();
        else if (v === 'settings') location.href = I.setUrl || '/settings/';
      },
    });
  }
  const moreBtn = $('files-more');
  if (moreBtn) on(moreBtn, 'click', openMore);

  /* ---------- 最近访问 sheet ---------- */
  const rvh = $('files-rv-head');
  if (rvh)
    on(rvh, 'click', function () {
      const r = getRecent();
      const html = r.length
        ? '<div class="pb-2">' +
          r
            .map(function (/** @type {any} */ x) {
              return (
                '<a href="' + esc(x.url) + '" data-visit=\'' + esc(JSON.stringify(x)) +
                '\' class="sheet-opt"><span class="flex-1 min-w-0 text-left"><span class="block font-medium truncate">' +
                esc(x.title || x.url) + '</span></span></a>'
              );
            })
            .join('') +
          '</div>'
        : '<p class="px-5 pb-6 text-sm text-m-on-surface-variant">' + esc(S.noVisits || '') + '</p>';
      openSheet({ title: S.recentVisits || '', html: html });
    });

  /* ---------- 站点存储：点击展开 ---------- */
  const sh = $('files-storage-head');
  if (sh)
    on(sh, 'click', function () {
      const d = $('files-storage-detail');
      if (!d) return;
      const open = d.classList.toggle('hidden');
      sh.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

  /* ---------- 列表工具栏 ---------- */
  const sortBtn = $('files-sort-btn');
  if (sortBtn) on(sortBtn, 'click', openSort);
  document.querySelectorAll('.files-seg button').forEach(function (b) {
    on(b, 'click', function () {
      view.layout = b.getAttribute('data-l');
      saveView();
      renderList();
    });
  });

  /* ---------- 搜索 ---------- */
  /**
   * @param {string} pg
   * @param {string} q
   */
  function capSearch(pg, q) {
    if (pg !== 'files') return '';
    const kw = (q || '').trim().toLowerCase();
    if (!kw || !DATA.length) return '';
    const hits = DATA.filter(function (it) {
      return (it.title || '').toLowerCase().indexOf(kw) >= 0 || (it.subtitle || '').toLowerCase().indexOf(kw) >= 0;
    });
    if (!hits.length)
      return '<p class="py-8 text-center text-sm text-m-on-surface-variant">' + esc(S.noResults || '') + '</p>';
    return TYPES.map(function (/** @type {any} */ t) {
      const items = hits.filter(function (it) {
        return it.type === t.id;
      });
      if (!items.length) return '';
      return (
        '<p class="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-widest text-m-on-surface-variant">' + esc(t.label) + '</p>' +
        items.slice(0, 6).map(rowHTML).join('')
      );
    }).join('');
  }
  setCapSearchProvider(capSearch);

  /* ---------- ⋯ 单按钮滚动停靠 ---------- */
  const Sched = getScheduler();
  const moreActions = document.querySelector('.subpage-actions');
  let moreSafeTop = 0;
  try {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)';
    document.body.appendChild(probe);
    moreSafeTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
  } catch (e) {}
  function moreStuckRight() {
    const land =
      window.matchMedia && window.matchMedia('(orientation:landscape) and (max-width:979.5px)').matches;
    const w = land ? 640 : 1100;
    return Math.max(16, (window.innerWidth - w) / 2 + (land ? 0 : 16));
  }
  /** @param {number} [y] */
  function updateMoreStick(y) {
    if (y === undefined) y = window.scrollY || 0;
    if (!moreBtn || !moreActions) return;
    const r = moreActions.getBoundingClientRect();
    const docTop = r.top + y;
    const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 64;
    const stuckTop = navH + 8 + moreSafeTop;
    const stick = y > 0 && y >= docTop - stuckTop;
    if (stick) {
      moreBtn.classList.add('stuck');
      /** @type {HTMLElement} */ (moreBtn).style.right = moreStuckRight() + 'px';
    } else {
      moreBtn.classList.remove('stuck');
      /** @type {HTMLElement} */ (moreBtn).style.right = '';
    }
  }
  Sched.onScroll(updateMoreStick);
  Sched.onResize(function () {
    updateMoreStick(window.scrollY || 0);
  });
  updateMoreStick(window.scrollY || 0);

  /* ---------- 初始化 ---------- */
  applyHomeVis();
  renderFav();
  renderRecentVisits();
  if (listMode) {
    const fh = $('files-home');
    if (fh) fh.classList.add('hidden');
    const fl = $('files-list');
    if (fl) fl.classList.remove('hidden');
    renderList();
  }
  fetch('/files-index.json')
    .then(function (r) {
      if (!r.ok) throw 0;
      return r.json();
    })
    .then(function (j) {
      const lang = en ? 'en' : 'zh';
      const arr = (j && j.items) || j;
      DATA = (Array.isArray(arr) ? arr : []).filter(function (it) {
        return it && (!it.lang || it.lang === lang) && (it.type === 'post' || it.type === 'book' || it.type === 'music' || it.type === 'site');
      });
      if (listMode) renderList();
      else {
        renderRecent();
        renderStorage();
      }
    })
    .catch(function () {
      if (listMode) renderList();
    });
  updateMoreStick();
})();
