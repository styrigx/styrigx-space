/**
 * 博客首页列表 + 目录页（2026-11 对齐 PR-C，设计稿 tb4.html pg=blog / pg=tree）。
 * 首页（[data-blog-list]）：分类 chips / #标签链接筛选（?cat= / ?tag=）+ less 风格分页（?page=，每页 data-page-size 篇）；
 *   状态写在地址查询串里（pushState，返回 / 刷新都停在原处）；空格键在分页条进入视口时翻下一页。不跑脚本时整份列表照常显示。
 *   旧地址：#posts → 首页；#topics → 目录页；#topics/tag|category/<slug> → ?tag= / ?cat=；#topics/series/<slug> → 目录页 #series-<slug>。
 * 目录页（[data-tree]）：分类 │ 年份 两个视图切换（aria-pressed，记在 sessionStorage）。
 * 纯函数（parseListQuery、legacyHashTarget、pagerItems、listUrl）由 tests/blog/blog-list.test.mjs 直接测。
 */

/** @typedef {{ key: 'tag' | 'cat' | null, slug: string, page: number }} ListState */

/**
 * 地址查询串 → 列表状态。tag 优先于 cat；page 从 1 起，非法值当 1。
 * @param {string} search
 * @returns {ListState}
 */
export function parseListQuery(search) {
  const q = new URLSearchParams(search || '');
  const tag = (q.get('tag') || '').trim();
  const cat = (q.get('cat') || '').trim();
  const n = parseInt(q.get('page') || '1', 10);
  const page = Number.isFinite(n) && n > 0 ? n : 1;
  if (tag) return { key: 'tag', slug: tag, page };
  if (cat) return { key: 'cat', slug: cat, page };
  return { key: null, slug: '', page };
}

/**
 * 列表状态 → 首页地址（base = 首页路径）。
 * @param {string} base
 * @param {ListState} st
 */
export function listUrl(base, st) {
  const q = new URLSearchParams();
  if (st.key && st.slug) q.set(st.key, st.slug);
  if (st.page > 1) q.set('page', String(st.page));
  const s = q.toString();
  return base + (s ? '?' + s : '');
}

/**
 * 专题面板时代的 hash → 新地址；认不出（文章锚点等）返回 null。
 * @param {string} hash
 * @param {string} base 首页路径
 * @param {string} tree 目录页路径
 * @returns {string | null}
 */
export function legacyHashTarget(hash, base, tree) {
  let h = (hash || '').replace(/^#/, '');
  try {
    h = decodeURIComponent(h);
  } catch {
    return null;
  }
  if (h === 'posts' || h === 'home') return base;
  const [tab, kind, ...rest] = h.split('/');
  if (tab !== 'topics') return null;
  const slug = rest.join('/');
  if (kind === 'tag' && slug) return listUrl(base, { key: 'tag', slug, page: 1 });
  if (kind === 'category' && slug) return listUrl(base, { key: 'cat', slug, page: 1 });
  if (kind === 'series' && slug) return tree + '#series-' + encodeURIComponent(slug);
  return tree;
}

/**
 * 分页条右侧页码：总页数 ≤ 5 全列；否则 1 · 当前前后 · … · 末页（设计稿「1 · 2 · 3 … 6 →」）。
 * @param {number} cur
 * @param {number} total
 * @returns {(number | '…')[]}
 */
export function pagerItems(cur, total) {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
  /** @type {Set<number>} */
  const keep = new Set([1, total, cur - 1, cur, cur + 1]);
  if (cur <= 3) [2, 3].forEach((n) => keep.add(n));
  if (cur >= total - 2) [total - 2, total - 1].forEach((n) => keep.add(n));
  const nums = [...keep].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  /** @type {(number | '…')[]} */
  const out = [];
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

/** 首页列表 */
export function initBlogList() {
  const root = /** @type {HTMLElement | null} */ (document.querySelector('[data-blog-list]'));
  if (!root || root.dataset.ready === 'true') return;
  root.dataset.ready = 'true';
  const base = location.pathname;
  const tree = root.dataset.tree || base + 'tree/';
  const legacy = legacyHashTarget(location.hash, base, tree);
  if (legacy) {
    location.replace(legacy);
    return;
  }
  const size = Math.max(1, parseInt(root.dataset.pageSize || '6', 10) || 6);
  /** @type {Record<string, string>} */
  let names = {};
  try {
    names = JSON.parse(root.dataset.names || '{}');
  } catch {
    names = {};
  }
  const rows = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-post]')]);
  const lists = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-year-list]')]);
  const chips = /** @type {HTMLAnchorElement[]} */ ([...root.querySelectorAll('.blog-chips [data-chip]')]);
  const note = /** @type {HTMLElement | null} */ (root.querySelector('[data-blog-filter-note]'));
  const noteText = /** @type {HTMLElement | null} */ (root.querySelector('[data-filter-text]'));
  const pager = /** @type {HTMLElement | null} */ (root.querySelector('[data-blog-pager]'));
  const less = /** @type {HTMLElement | null} */ (root.querySelector('[data-pg-less]'));
  const nums = /** @type {HTMLElement | null} */ (root.querySelector('[data-pg-nums]'));
  const chipKey = root.dataset.catField === 'categories' ? 'cat' : 'tag';
  /** @type {ListState} */
  let st = parseListQuery(location.search);
  let pages = 1;

  const matches = (/** @type {HTMLElement} */ r) => {
    if (!st.key) return true;
    const list = (st.key === 'tag' ? r.dataset.tags : r.dataset.cats) || '';
    return list.split(' ').includes(st.slug);
  };

  function render() {
    const hit = rows.filter(matches);
    pages = Math.max(1, Math.ceil(hit.length / size));
    if (st.page > pages) st.page = pages;
    const from = (st.page - 1) * size;
    const shown = new Set(hit.slice(from, from + size));
    rows.forEach((r) => (r.hidden = !shown.has(r)));
    lists.forEach((l) => {
      const any = [...l.querySelectorAll('[data-post]')].some((r) => !(/** @type {HTMLElement} */ (r).hidden));
      l.hidden = !any;
      const h = /** @type {HTMLElement | null} */ (l.previousElementSibling);
      if (h && h.matches('[data-year]')) h.hidden = !any;
    });
    let chipHit = false;
    chips.forEach((c) => {
      const on = st.key ? st.key === chipKey && c.dataset.chip === st.slug : c.dataset.chip === '';
      if (on) chipHit = true;
      if (on) c.setAttribute('aria-current', 'true');
      else c.removeAttribute('aria-current');
    });
    if (note && noteText) {
      note.hidden = !st.key || chipHit;
      if (!note.hidden) {
        const label = (st.key === 'tag' ? '#' : '') + (names[st.key + ':' + st.slug] || st.slug);
        noteText.textContent = (noteText.dataset.tpl || '{label} · {n}').split('{label}').join(label).split('{n}').join(String(hit.length));
      }
    }
    if (pager && less && nums) {
      pager.hidden = false;
      less.textContent = `-- less (${st.page}/${pages}) --`;
      nums.textContent = '';
      pagerItems(st.page, pages).forEach((it, i) => {
        if (i) nums.append(document.createTextNode(' · '));
        if (it === '…') {
          nums.append(document.createTextNode('…'));
          return;
        }
        const a = document.createElement('a');
        a.href = listUrl(base, { ...st, page: it });
        a.textContent = String(it);
        a.dataset.page = String(it);
        if (it === st.page) a.setAttribute('aria-current', 'page');
        nums.append(a);
      });
      if (st.page < pages) {
        const a = document.createElement('a');
        a.href = listUrl(base, { ...st, page: st.page + 1 });
        a.dataset.page = String(st.page + 1);
        a.className = 'sgx-pg-next';
        a.textContent = '→';
        a.setAttribute('aria-label', 'next');
        nums.append(document.createTextNode(' '), a);
      }
    }
  }

  /** @param {ListState} next @param {boolean} scroll */
  function go(next, scroll) {
    st = next;
    history.pushState(history.state, '', listUrl(base, st));
    render();
    if (scroll) {
      const top = root.querySelector('.blog-chips');
      if (top) top.scrollIntoView({ block: 'start', behavior: document.documentElement.classList.contains('reduced-motion') ? 'auto' : 'smooth' });
    }
  }

  root.addEventListener('click', (e) => {
    const ev = /** @type {MouseEvent} */ (e);
    if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
    const t = /** @type {Element} */ (e.target);
    const a = /** @type {HTMLAnchorElement | null} */ (t.closest && t.closest('a'));
    if (!a || !root.contains(a)) return;
    if (a.dataset.page) {
      e.preventDefault();
      go({ ...st, page: parseInt(a.dataset.page, 10) }, true);
      return;
    }
    const u = new URL(a.href, location.href);
    if (u.pathname !== base || u.hash) return;
    e.preventDefault();
    go({ ...parseListQuery(u.search), page: 1 }, false);
  });

  /* 同页改 hash（旧链接点进来时页面已经在首页）：照样转址 */
  window.addEventListener('hashchange', () => {
    const t = legacyHashTarget(location.hash, base, tree);
    if (t) location.replace(t);
  });

  window.addEventListener('popstate', () => {
    st = parseListQuery(location.search);
    render();
  });

  /* 空格：分页条在视口里、焦点不在输入框 / 按钮上时翻下一页（less 的空格），否则照常滚动 */
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !pager || st.page >= pages) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (t && t.closest && t.closest('input, textarea, select, button, [contenteditable], dialog')) return;
    const r = pager.getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) return;
    e.preventDefault();
    go({ ...st, page: st.page + 1 }, true);
  });

  render();
}

const TREE_KEY = 'sgx-blog-tree-view';

/** 目录页：分类 │ 年份 */
export function initTree() {
  const root = /** @type {HTMLElement | null} */ (document.querySelector('[data-tree]'));
  if (!root || root.dataset.ready === 'true') return;
  root.dataset.ready = 'true';
  const btns = /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[data-tree-view]')]);
  const panes = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-tree-pane]')]);
  const set = (/** @type {string} */ v) => {
    btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.treeView === v)));
    panes.forEach((p) => (p.hidden = p.dataset.treePane !== v));
    try {
      sessionStorage.setItem(TREE_KEY, v);
    } catch {
      /* 无痕模式等 */
    }
  };
  btns.forEach((b) => b.addEventListener('click', () => set(b.dataset.treeView || 'cat')));
  let v = 'cat';
  try {
    v = sessionStorage.getItem(TREE_KEY) || 'cat';
  } catch {
    v = 'cat';
  }
  /* 系列锚点（#series-<slug>）在分类视图里 */
  if (/^#series-/.test(location.hash)) v = 'cat';
  if (v !== 'cat' && btns.some((b) => b.dataset.treeView === v)) set(v);
}
