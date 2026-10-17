/**
 * @fileoverview 我的文件页：主页分组渲染、列表/网格模式（文章 / 书籍）、搜索、⋮ 菜单。
 * B2-5：删除我的站点、收藏、最近添加与访问；书籍列表来自 /api/books（书库 D1 只读）。
 * 文案来自页面内 files-i18n JSON（沿用旧格式）。
 */
import { on } from '../lib/events.js';
import { registerPage } from '../shell/inpagenav.js';
import { esc } from '../lib/util.js';
import { getJSON, setJSON } from '../lib/storage.js';
import { openSheet } from '../shell/sheet.js';
import { setCapSearchProvider } from '../shell/capsule.js';

(function () {
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let I = {};
  try {
    I = JSON.parse(document.getElementById('files-i18n').textContent || '{}');
  } catch (e) {}
  const S = I.str || {},
    TYPES = I.types || [],
    BOOK_HOST = I.bookHost || '';
  /** 5.1：书库在当前标签页打开，不加 target=_blank（host 来自 sites.yaml 的 id: book，不硬编码） */
  /** @param {string} url */
  function isBookUrl(url) {
    if (!url || !BOOK_HOST) return false;
    try {
      return new URL(url, location.origin).host === BOOK_HOST;
    } catch (e) {
      return false;
    }
  }
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
    book: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.04A8.97 8.97 0 006 3.75c-1.05 0-2.06.18-3 .51v14.25A8.99 8.99 0 016 18c2.3 0 4.41.87 6 2.29m0-14.25a8.97 8.97 0 016-2.29c1.05 0 2.06.18 3 .51v14.25A8.99 8.99 0 0018 18a8.97 8.97 0 00-6 2.29m0-14.25v14.25"/></svg>',
    pen: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.86 4.49l1.69-1.69a1.88 1.88 0 112.65 2.65L10.58 16.07a4.5 4.5 0 01-1.9 1.13L6 18l.8-2.69a4.5 4.5 0 011.13-1.9z"/></svg>',
  };

  /* ---------- 模式与偏好 ---------- */
  const params = new URLSearchParams(location.search);
  const qtype = params.get('type');
  const VALID = ['post', 'book'];
  const listMode = VALID.indexOf(qtype || '') >= 0;

  const view = get('sgx-files-view', null) || {};
  if (view.sort !== 'name') view.sort = 'added';
  if (view.layout !== 'grid') view.layout = 'list';
  function saveView() {
    set('sgx-files-view', view);
  }

  const GROUPS = ['cats', 'storage'];
  const homeVis = get('sgx-files-home', null) || {};
  GROUPS.forEach(function (g) {
    if (homeVis[g] === undefined) homeVis[g] = true;
  });

  /** @type {Array<any>} */
  let DATA = [];
  /** @type {Array<any>} */
  let POSTS = [];
  /** @type {Array<any>} */
  let BOOKS = [];
  function mergeData() {
    DATA = POSTS.concat(BOOKS);
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

  /* ---------- 主页渲染 ---------- */
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
  function applyHomeVis() {
    document.querySelectorAll('[data-home-group]').forEach(function (g) {
      /** @type {HTMLElement} */ (g).style.display = homeVis[g.getAttribute('data-home-group') || ''] === false ? 'none' : '';
    });
  }

  /* ---------- 列表模式 ---------- */
  /** @param {any} it */
  function rowHTML(it) {
    const t = typeById[it.type] || {};
    /* B2-5：书籍封面按书的比例（3:4） */
    const sz = it.type === 'book' ? 'w-9 h-12 rounded-md' : 'w-12 h-12 rounded-xl';
    const th = it.cover
      ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy" decoding="async" width="48" height="48" class="' + sz + ' object-cover shrink-0 bg-m-container">'
      : '<span class="' + sz + ' ' + (t.bar || 'bg-m-container-highest') + ' text-white flex items-center justify-center shrink-0">' + (ICONS[t.icon] || ICONS.folder) + '</span>';
    const ext = /^https?:/.test(it.url || '') && !isBookUrl(it.url);
    return (
      '<a href="' + esc(it.url || '#') + '" ' + (ext ? 'target="_blank" rel="noopener"' : '') +
      ' class="flex items-center gap-3.5 px-4 py-3 active:bg-m-container transition-colors">' + th +
      '<span class="flex-1 min-w-0"><span class="block truncate text-[15px] font-medium">' + esc(it.title || '') + '</span>' +
      (it.subtitle ? '<span class="block truncate text-xs text-m-on-surface-variant mt-0.5">' + esc(it.subtitle) + '</span>' : '') +
      '</span></a>'
    );
  }
  /** @param {any} it */
  function gridCardHTML(it) {
    const t = typeById[it.type] || {};
    const ar = it.type === 'book' ? 'aspect-[3/4]' : 'aspect-[4/3]';
    const media = it.cover
      ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy" decoding="async" class="w-full ' + ar + ' object-cover bg-m-container">'
      : '<span class="w-full ' + ar + ' ' + (t.bar || 'bg-m-container-highest') + ' text-white flex items-center justify-center">' + (ICONS[t.icon] || ICONS.folder) + '</span>';
    const ext = /^https?:/.test(it.url || '') && !isBookUrl(it.url);
    return (
      '<a href="' + esc(it.url || '#') + '" ' + (ext ? 'target="_blank" rel="noopener"' : '') +
      ' class="block rounded-3xl overflow-hidden bg-m-container-lowest border border-m-outline active:scale-[0.98] transition-transform">' + media +
      '<span class="block p-3"><span class="block truncate text-sm font-medium">' + esc(it.title || '') + '</span>' +
      (it.subtitle ? '<span class="block truncate text-xs text-m-on-surface-variant mt-0.5">' + esc(it.subtitle) + '</span>' : '') +
      '</span></a>'
    );
  }
  function listItems() {
    return DATA.filter(function (it) {
      return it.type === qtype;
    });
  }
  function renderList() {
    const t = typeById[qtype || ''];
    const title = (t && t.label) || qtype || '';
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
  }

  /* ---------- ⋮ 菜单 ---------- */
  const GROUP_LABELS = { cats: S.gCats, storage: S.gStorage };
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
  function openView() {
    openSheet({
      title: S.defView || '',
      options: [
        { label: S.list || '', value: 'list', checked: view.layout === 'list' },
        { label: S.grid || '', value: 'grid', checked: view.layout === 'grid' },
      ],
      onPick: function (v) {
        view.layout = v === 'grid' ? 'grid' : 'list';
        saveView();
        if (listMode) renderList();
      },
    });
  }
  /* B2-4：「设置 › 应用 › 我的文件」迁入这里；B2-5 最近访问删除，菜单只剩编辑主页、排序方式、默认视图 */
  function openMore() {
    openSheet({
      title: '',
      options: [
        { label: S.editHome || '', value: 'home' },
        { label: S.sortBy || '', sub: view.sort === 'name' ? S.byName || '' : S.addedAt || '', value: 'sort' },
        { label: S.defView || '', sub: view.layout === 'grid' ? S.grid || '' : S.list || '', value: 'view' },
      ],
      onPick: function (v) {
        if (v === 'home') openHomeEdit();
        else if (v === 'sort') openSort();
        else if (v === 'view') openView();
      },
    });
  }
  const moreBtn = $('files-more');
  if (moreBtn) on(moreBtn, 'click', openMore);

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

  /* ---------- ⋯ 按钮吸顶：D5 起走公共模块 shell/head-buttons.js（与原公式逐行一致） ---------- */
  /* （原 updateMoreStick / moreStuckRight 已移入公共模块；菜单绑定保留） */

  /* ---------- 初始化 ---------- */
  function refresh() {
    mergeData();
    if (listMode) renderList();
    else renderStorage();
  }
  applyHomeVis();
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
      POSTS = (Array.isArray(arr) ? arr : []).filter(function (it) {
        return it && (!it.lang || it.lang === lang) && it.type === 'post';
      });
      refresh();
    })
    .catch(refresh);
  /* B2-5：书籍 = 书库全部书（/api/books，主人看全部，访客只看公开书）；点击在当前标签页打开阅读器 */
  fetch('/api/books', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw 0;
      return r.json();
    })
    .then(function (j) {
      BOOKS = ((j && j.books) || []).map(function (/** @type {any} */ b) {
        return {
          id: 'book-' + b.id,
          type: 'book',
          title: b.title || '',
          subtitle: b.author || '',
          url: b.read_url || '',
          cover: b.cover_url || '',
          addedAt: b.added_at ? new Date(b.added_at).toISOString() : '',
        };
      });
      refresh();
    })
    .catch(refresh);
})();

/* 2.9.0 页内导航：注册 mount/unmount */
function filesMount() {
  // 页面初始化逻辑已在 IIFE 中执行，这里预留给页内切换时的重新挂载
}
function filesUnmount() {
  // 清理定时器、事件监听和 observer
  // 注意：IIFE 中的监听器在页内切换时需要手动清理，这里是占位实现
}
registerPage('files', { mount: filesMount, unmount: filesUnmount });
