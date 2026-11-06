/**
 * 模态弹层（导航抽屉 / 目录底部弹层）开合，照搬主站 head-buttons.js initDrawer 的状态机：
 * dlg.dataset.state：closed → opening → open → closing → closed。
 * - 开：showModal()，两帧后加 is-open 触发滑入，DRAWER_MS 后 state=open；减弱动效直接到位。
 * - 关：去掉 is-open 滑出，DRAWER_MS 后 close()；还没滑出来 / 减弱动效时立刻关。
 * - 每次开 / 关换一代 gen，上一代没跑完的 rAF / 计时器一律作废（主站 CI 偶发卡死的修复）。
 * - 点遮罩（<dialog> 本身、面板以外）关闭；Esc（原生 cancel）带动画关闭；按钮再点一次关闭。
 *
 * 与主站不同：不在历史里压哨兵（系统返回关抽屉），只靠 遮罩 / Esc / 按钮 / 点项 关闭。
 */
const DRAWER_MS = 220;

function reducedMotion() {
  return (
    document.documentElement.classList.contains('reduced-motion') ||
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

export interface SheetHandle {
  open: () => void;
  /** instant=true：不等滑出动画，立刻关（例如关掉后马上要滚动页面） */
  close: (instant?: boolean) => void;
  isOpen: () => boolean;
}

export function initSheet(dlg: HTMLDialogElement, btn: HTMLElement): SheetHandle {
  const panel = dlg.querySelector<HTMLElement>('[data-sgx-sheet-panel]');
  let gen = 0;
  let rafs: number[] = [];
  let timer: number | null = null;
  const noop: SheetHandle = { open() {}, close() {}, isOpen: () => false };
  if (typeof dlg.showModal !== 'function') return noop;

  const setState = (st: string) => dlg.setAttribute('data-state', st);
  const cancelPending = () => {
    for (const r of rafs) cancelAnimationFrame(r);
    rafs = [];
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const settleClosed = () => {
    cancelPending();
    dlg.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    setState('closed');
    if (dlg.open) dlg.close();
  };
  setState('closed');

  function open() {
    if (dlg.open) return;
    cancelPending();
    const my = ++gen;
    dlg.classList.remove('is-open');
    try {
      dlg.showModal();
    } catch {
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    const shown = () => {
      if (my !== gen) return;
      dlg.classList.add('is-open');
      if (reducedMotion()) {
        setState('open');
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (my === gen) setState('open');
      }, DRAWER_MS);
    };
    setState('opening');
    if (reducedMotion()) shown();
    else rafs.push(requestAnimationFrame(() => rafs.push(requestAnimationFrame(shown))));
  }

  function close(instant = false) {
    cancelPending();
    const my = ++gen;
    btn.setAttribute('aria-expanded', 'false');
    const slid = dlg.classList.contains('is-open');
    dlg.classList.remove('is-open');
    if (instant || !dlg.open || !slid || reducedMotion()) {
      settleClosed();
      return;
    }
    setState('closing');
    timer = window.setTimeout(() => {
      timer = null;
      if (my === gen) settleClosed();
    }, DRAWER_MS);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dlg.open && dlg.getAttribute('data-state') !== 'closing') close();
    else open();
  });
  dlg.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (!t) return;
    if (panel && panel.contains(t)) return;
    close();
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  /* 被我们以外的途径关掉（连按 Esc 时浏览器可能强关）：同步状态 */
  dlg.addEventListener('close', () => {
    if (dlg.getAttribute('data-state') === 'closed') return;
    gen++;
    settleClosed();
  });
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted && dlg.open) {
      gen++;
      settleClosed();
    }
  });

  return { open, close, isOpen: () => dlg.open };
}
