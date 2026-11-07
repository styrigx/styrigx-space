/**
 * 列表页（/ 和 /zh/）的三个页签：首页 · 文章 · 专题。
 * - 页面面板（[data-sgx-panes]）：左右滑动面板、首页正文的分区入口（链接 #posts / #topics）、页内链接都能切换。
 *   P4-3 PR-4b 起顶栏没有分段滑块：顶栏页名胶囊显示当前分区名（首页 = 站名），分区入口只在首页分区显示。
 * - 地址 hash 反映当前页签，刷新 / 返回都停在原页签：首页 = 无 hash，#posts，#topics，
 *   专题筛选 #topics/tag/<slug>、#topics/category/<slug>、#topics/series/<slug>（系列：滚到并高亮系列卡）。
 *   只用 history.replaceState（保留已有的 history.state），切页签不新增历史记录。
 * - 每个页签记住自己的滚动位置；减弱动效（系统设置或主站 rm=1 → html.reduced-motion）时不做过渡动画。
 */
import { TABS, parseHash, routeHash } from './app-tabs-route.js';

/** 话题筛选结果标题：data-tpl-one / data-tpl-other 两种模板（字符串表），按页面语言的复数规则选，填 {label} {n} */
export function topicResultsText(el: HTMLElement, label: string, n: number): string {
  let cat = 'other';
  try {
    cat = new Intl.PluralRules(document.documentElement.lang || 'en').select(n);
  } catch (e) {
    cat = n === 1 ? 'one' : 'other';
  }
  const tpl = (cat === 'one' ? el.dataset.tplOne : el.dataset.tplOther) || el.dataset.tplOther || '{label} · {n}';
  return tpl.split('{label}').join(label).split('{n}').join(String(n));
}

export type Tab = (typeof TABS)[number];
export type FilterKind = 'tag' | 'category' | 'series';
export interface Route {
  tab: Tab;
  filter?: { kind: FilterKind; slug: string };
}

const MOVE_MS = 300;

function reducedMotion() {
  return (
    document.documentElement.classList.contains('reduced-motion') ||
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

export function initAppTabs() {
  const panes = document.querySelector<HTMLElement>('[data-sgx-panes]');
  if (!panes || panes.dataset.ready === 'true') return;
  panes.dataset.ready = 'true';

  const track = panes.querySelector<HTMLElement>('[data-sgx-track]')!;
  /* P4-3 PR-4b：顶栏不再有分段滑块——页名胶囊显示当前分区名（data-sgx-titles，第 0 个 = 站名「博客」），
     分区入口（[data-sgx-entries]，首页正文的目录）只在首页分区显示 */
  const title = document.querySelector<HTMLElement>('.sgx-tb-title[data-sgx-titles]');
  const entries = document.querySelector<HTMLElement>('[data-sgx-entries]');
  const syncTitle = (i: number) => {
    if (title) {
      try {
        const names = JSON.parse(title.dataset.sgxTitles || '[]') as string[];
        if (names[i]) title.textContent = names[i];
      } catch {
        /* 坏数据就保持站名 */
      }
    }
    if (entries) entries.hidden = i !== 0;
  };
  const paneEls = TABS.map((id) => panes.querySelector<HTMLElement>(`[data-pane="${id}"]`)!);
  const scrolls: number[] = TABS.map(() => 0);
  let index = 0;
  let filter: Route['filter'];
  let moveTimer: number | null = null;
  let suppressClick = false;

  const setPos = (pos: number) => {
    track.style.setProperty('--pane-pos', pos.toFixed(4));
  };

  const moving = (on: boolean) => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = null;
    if (on) panes.classList.add('is-moving');
    else panes.classList.remove('is-moving');
  };

  function writeHash() {
    const h = routeHash({ tab: TABS[index], filter: index === 2 ? filter : undefined });
    const url = location.pathname + location.search + h;
    if (url !== location.pathname + location.search + location.hash) {
      history.replaceState(history.state, '', url);
    }
  }

  function setTab(
    next: number,
    opts: { initial?: boolean; keepHash?: boolean } = {},
  ) {
    next = Math.min(TABS.length - 1, Math.max(0, next));
    const prev = index;
    if (!opts.initial) scrolls[prev] = window.scrollY;
    index = next;
    syncTitle(next);
    paneEls.forEach((p, i) => {
      const on = i === next;
      p.classList.toggle('is-active', on);
      if (on) p.removeAttribute('inert');
      else p.setAttribute('inert', '');
    });
    panes.dataset.tab = TABS[next];
    if (!opts.initial && prev !== next && !reducedMotion()) {
      moving(true);
      moveTimer = window.setTimeout(() => moving(false), MOVE_MS);
    } else {
      moving(false);
    }
    panes.classList.remove('is-dragging');
    setPos(next);
    if (!opts.keepHash) writeHash();
    if (!opts.initial && prev !== next) window.scrollTo({ top: scrolls[next], behavior: 'auto' });
  }

  /* ----- 专题筛选 ----- */
  const topics = paneEls[2];
  const results = topics.querySelector<HTMLElement>('[data-topic-results]');
  const resultsTitle = topics.querySelector<HTMLElement>('[data-topic-results-title]');

  function applyFilter(f: Route['filter'], opts: { reveal?: boolean } = {}) {
    filter = f;
    for (const card of topics.querySelectorAll<HTMLElement>('[data-series-card]')) {
      card.classList.toggle(
        'is-target',
        !!f && f.kind === 'series' && card.dataset.seriesCard === f.slug,
      );
    }
    for (const chip of topics.querySelectorAll<HTMLElement>('[data-topic-filter]')) {
      chip.setAttribute(
        'aria-pressed',
        f && chip.dataset.topicFilter === `${f.kind}:${f.slug}` ? 'true' : 'false',
      );
    }
    if (!results) return;
    if (!f || f.kind === 'series') {
      results.hidden = true;
      if (f && opts.reveal !== false) {
        const card = topics.querySelector<HTMLElement>(
          `[data-series-card="${CSS.escape(f.slug)}"]`,
        );
        card?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
      return;
    }
    const attr = f.kind === 'tag' ? 'tags' : 'cats';
    let n = 0;
    for (const li of results.querySelectorAll<HTMLElement>('[data-topic-post]')) {
      const hit = (li.dataset[attr] || '').split(' ').includes(f.slug);
      li.hidden = !hit;
      if (hit) n++;
    }
    const chip = topics.querySelector<HTMLElement>(
      `[data-topic-filter="${CSS.escape(`${f.kind}:${f.slug}`)}"]`,
    );
    const label = chip?.dataset.label || f.slug;
    if (resultsTitle) {
      /* 文案在 i18n/<语言>.yaml topicResults（模板放进 data-tpl-one / data-tpl-other），复数按页面语言的 Intl.PluralRules 选；不再按语言二选一 */
      resultsTitle.textContent = topicResultsText(resultsTitle, label, n);
    }
    results.hidden = false;
    if (opts.reveal !== false) {
      results.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
  }

  function go(route: Route, opts: { initial?: boolean; reveal?: boolean } = {}) {
    const i = TABS.indexOf(route.tab);
    if (route.tab === 'topics' || !opts.initial)
      applyFilter(route.tab === 'topics' ? route.filter : undefined, {
        reveal: !opts.initial && opts.reveal !== false,
      });
    setTab(i, { initial: opts.initial });
    /* 刷新 / 返回直接带筛选：等布局稳定再滚过去 */
    if (opts.initial && route.filter) requestAnimationFrame(() => applyFilter(route.filter));
  }

  topics.addEventListener('click', (e) => {
    const t = e.target as Element;
    const chip = t.closest?.<HTMLElement>('[data-topic-filter]');
    if (chip) {
      const [kind, slug] = (chip.dataset.topicFilter || '').split(':') as [FilterKind, string];
      const same = filter && filter.kind === kind && filter.slug === slug;
      applyFilter(same ? undefined : { kind, slug }, { reveal: !same });
      writeHash();
      return;
    }
    if (t.closest?.('[data-topic-clear]')) {
      applyFilter(undefined);
      writeHash();
    }
  });

  /* 页内链接 #posts / #topics/... 和 [data-sgx-goto]：自己切，不交给路由器 */
  document.addEventListener(
    'click',
    (e) => {
      if (!document.body.contains(panes) || suppressClick) return;
      const t = e.target as Element;
      const btn = t.closest?.<HTMLElement>('[data-sgx-goto]');
      const a = t.closest?.<HTMLAnchorElement>('a[href^="#"]');
      const hash = btn ? `#${btn.dataset.sgxGoto}` : a ? a.getAttribute('href') || '' : '';
      if (!hash) return;
      const route = parseHash(hash);
      if (!route) return;
      e.preventDefault();
      go(route);
    },
    /* 捕获阶段：赶在其他点击处理之前 */
    true,
  );

  const onHash = () => {
    if (!document.body.contains(panes)) return;
    const route = parseHash(location.hash);
    if (route) go(route);
  };
  window.addEventListener('hashchange', onHash);

  /* ----- 横向滑动切换 ----- */
  let sx = 0;
  let sy = 0;
  let st = 0;
  let pid = -1;
  let lock: '' | 'x' | 'y' = '';
  let dx = 0;

  panes.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    sx = e.clientX;
    sy = e.clientY;
    st = performance.now();
    pid = e.pointerId;
    lock = '';
    dx = 0;
  });
  panes.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const mx = e.clientX - sx;
    const my = e.clientY - sy;
    if (!lock) {
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.2) {
        lock = 'x';
        try {
          panes.setPointerCapture(pid);
        } catch {}
        moving(true);
        panes.classList.add('is-dragging');
      } else if (Math.abs(my) > 10) {
        lock = 'y';
      }
    }
    if (lock !== 'x') return;
    e.preventDefault();
    const w = panes.clientWidth || 1;
    dx = mx;
    const atEdge = (index === 0 && mx > 0) || (index === TABS.length - 1 && mx < 0);
    const frac = (atEdge ? mx * 0.3 : mx) / w;
    setPos(index - frac);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    pid = -1;
    if (lock !== 'x') {
      lock = '';
      return;
    }
    lock = '';
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    const w = panes.clientWidth || 1;
    const v = dx / Math.max(1, performance.now() - st);
    let next = index;
    if (dx < -w * 0.2 || v < -0.4) next = index + 1;
    else if (dx > w * 0.2 || v > 0.4) next = index - 1;
    next = Math.min(TABS.length - 1, Math.max(0, next));
    if (next === index) {
      panes.classList.remove('is-dragging');
      setPos(index);
      moveTimer = window.setTimeout(() => moving(false), MOVE_MS);
    } else {
      setTab(next);
    }
  };
  panes.addEventListener('pointerup', end);
  panes.addEventListener('pointercancel', end);
  /* 鼠标按在卡片链接 / 图片上横拖时，浏览器会开始原生拖拽（拖链接）并发 pointercancel，滑动就被打断、
     松手前就切了页签。面板里的链接和图片不需要被拖走，直接禁掉原生拖拽（触屏不受影响）。 */
  panes.addEventListener('dragstart', (e) => e.preventDefault());
  /* 拖动后松手不触发链接点击 */
  panes.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
      }
    },
    true,
  );

  go(parseHash(location.hash) || { tab: 'home' }, { initial: true });
  panes.dataset.state = 'ready';
}
