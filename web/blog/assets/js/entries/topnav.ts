// 顶栏：九宫格抽屉开关（含文章目录）+ 文章页阅读进度细线 + 右圆分享按钮。
// 整页跳转，末尾的 initTopbar() 直接初始化。
import { initSheet } from '../blog/sgx-sheet';
import { mountTocSpy } from '../blog/toc-spy';
import { mountShare } from '../sgx/shell/share.js';

/** 文章阅读进度：#article-start（正文）从顶栏下沿开始读，到正文底部离开视口底部为 100%；画在长条底边。 */
let ticking = false;
function updateProgress() {
  ticking = false;
  const bar = document.querySelector<HTMLElement>('[data-sgx-progress]');
  const body =
    document.querySelector<HTMLElement>('#article-start') || document.querySelector('main');
  if (!bar || !body) return;
  const r = body.getBoundingClientRect();
  const start = window.scrollY + r.top - 80;
  const end = window.scrollY + r.bottom - window.innerHeight;
  const span = Math.max(1, end - start);
  const p = Math.min(1, Math.max(0, (window.scrollY - start) / span));
  bar.style.setProperty('--p', p.toFixed(4));
  bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
}
function onScroll() {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(updateProgress);
  }
}

function initTopbar() {
  const r = document.querySelector<HTMLElement>('[data-sgx-topbar-root]');
  if (!r || r.dataset.sgxReady === 'true') return;
  r.dataset.sgxReady = 'true';

  const drawerBtn = r.querySelector<HTMLElement>('[data-sgx-apps]');
  const drawer = r.querySelector<HTMLDialogElement>('#sgx-drawer');
  if (drawerBtn && drawer) {
    const sheet = initSheet(drawer, drawerBtn);
    /* 捕获阶段处理，先于目录 spy 挂在链接上的点击：先收起抽屉（关掉模态后页面才能滚），再滚到标题 */
    drawer.addEventListener(
      'click',
      (e) => {
        const me = e as MouseEvent;
        if (me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
        const t = e.target as Element;
        const toc = t.closest?.<HTMLAnchorElement>('a[data-toc-link]');
        if (toc) {
          e.preventDefault();
          e.stopPropagation();
          sheet.close(true);
          const id = decodeURIComponent((toc.getAttribute('href') || '').replace(/^#/, ''));
          const el = id ? document.getElementById(id) : null;
          if (el) {
            const reduce =
              document.documentElement.classList.contains('reduced-motion') ||
              window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
            history.replaceState(history.state, '', `#${encodeURIComponent(id)}`);
          }
          return;
        }
        /* 抽屉项：当前项（博客）只关闭；其他项、头部头像（主站账号页）先收起再跳转；
           底栏搜索框原地打开搜索层（entries/search-host.ts），不跳主站——必须在这次点击里同步调用，安卓才弹键盘 */
        const a = t.closest?.<HTMLAnchorElement>('a.sgx-drawer-item, a.sgx-drawer-me, a.sgx-drawer-search');
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        const srch = (window as unknown as { SgxSearch?: { open: (o: object) => void } }).SgxSearch;
        if (a.classList.contains('sgx-drawer-search') && srch) {
          /* 抽屉不压历史哨兵：同步关掉，搜索层自己 push 一条 */
          srch.open({ from: a, ghost: drawer, handoff: () => { sheet.close(true); return false; } });
          return;
        }
        sheet.close();
        if (a.getAttribute('aria-current') !== 'page') location.assign(a.href);
      },
      true,
    );
    /* 目录分支全部展开（抽屉里一眼看全）；当前节高亮交给 toc-spy */
    for (const li of drawer.querySelectorAll<HTMLElement>('[data-toc-expanded]'))
      li.dataset.tocExpanded = 'true';
    for (const b of drawer.querySelectorAll<HTMLElement>('[data-toc-toggle]'))
      b.setAttribute('aria-expanded', 'true');
    if (drawer.querySelector('[data-toc-root]')) mountTocSpy();
  }

  /* 右圆分享按钮（共享外壳 share.js：管理员 = 带临时会话的短链，访客 = 当前页地址） */
  mountShare({ button: r.querySelector('[data-sgx-share]') });

  updateProgress();
}

const w = window as unknown as { __sgxTopbarGlobal?: boolean };
if (!w.__sgxTopbarGlobal) {
  w.__sgxTopbarGlobal = true;
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('pageshow', onScroll);
}
initTopbar();
