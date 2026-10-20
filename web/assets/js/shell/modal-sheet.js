/**
 * @fileoverview 顶栏弹出层的开合状态机（导航抽屉 #sgx-drawer；快捷面板已改为内嵌展开，不再用它）。
 *
 * dlg.dataset.state：closed → opening → open → closing → closed。
 * 开合只靠我们自己的计时器推进（不等 transitionend：减弱动效 / 后台标签页 / 过渡被打断时它可能永远不来），
 * 每次开 / 关都换一代 gen，上一代没跑完的 rAF / 计时器一律作废——
 * 以前「刚点开（is-open 还在等两帧 rAF）就按 Esc」时，迟到的 rAF 会把 is-open 加回去，
 * 关闭计时器看到 is-open 就不关 <dialog>，弹出层卡在打开状态（CI 偶发）。
 *
 * 打开时 push 一条同 URL 的历史哨兵，系统返回只关弹出层不离开页面；
 * Esc（原生 cancel）、点遮罩由调用方接到 close()；close(after) 先退掉哨兵、等它出栈后再执行 after
 * （跳转 / 再弹别的层），免得目标页的返回多一步。
 */
import { reducedMotion } from '../lib/util.js';

/**
 * @typedef {Object} ModalSheet
 * @property {() => void} open
 * @property {(after?: () => void) => void} close 关闭（带滑出动画并退掉哨兵）；after 在哨兵出栈后执行
 * @property {() => boolean} isOpen
 */

/**
 * @param {HTMLDialogElement} dlg 铺满视口的 <dialog>（::backdrop 是遮罩）
 * @param {HTMLElement} btn 打开它的顶栏按钮（同步 aria-expanded）
 * @param {{ ms: number, stateKey: string, onOpen?: () => void }} opts
 *   ms：滑入 / 滑出时长（与 CSS transition 一致）；stateKey：历史哨兵 state 里的键名；onOpen：showModal 之后调用（重绘内容）
 * @returns {ModalSheet}
 */
export function modalSheet(dlg, btn, opts) {
  const MS = opts.ms;
  /* 历史里是否有本层的哨兵；关闭时退掉它 */
  let pushed = false;
  /* 正在等哨兵出栈的 popstate：null = 不在等；否则出栈后执行它（noop = 只关闭） */
  /** @type {null | (() => void)} */
  let awaiting = null;
  /* 开合代数：每次 open / hide 加一，旧代的回调看到代数变了就什么都不做 */
  let gen = 0;
  /** @type {number[]} */ let rafs = [];
  /** @type {number|null} */ let timer = null;
  const noop = function () {};

  /** @param {string} st */
  function setState(st) {
    dlg.setAttribute('data-state', st);
  }
  function cancelPending() {
    for (let i = 0; i < rafs.length; i++) cancelAnimationFrame(rafs[i]);
    rafs = [];
    if (timer) clearTimeout(timer);
    timer = null;
  }
  /** 收尾成「已关」：同步 class / aria / 状态；<dialog> 还开着就关掉 */
  function settleClosed() {
    cancelPending();
    dlg.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    setState('closed');
    if (dlg.open) dlg.close();
  }
  setState('closed');

  function open() {
    if (dlg.open) return;
    cancelPending();
    const my = ++gen;
    dlg.classList.remove('is-open');
    try {
      dlg.showModal();
    } catch (e) {
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    if (opts.onOpen) {
      try {
        opts.onOpen();
      } catch (e) {}
    }
    const shown = function () {
      if (my !== gen) return;
      dlg.classList.add('is-open');
      if (reducedMotion()) {
        setState('open');
        return;
      }
      timer = window.setTimeout(function () {
        timer = null;
        if (my === gen) setState('open');
      }, MS);
    };
    setState('opening');
    /* 下一帧再加 is-open，让滑入过渡生效；减弱动效直接到位 */
    if (reducedMotion()) shown();
    else rafs.push(requestAnimationFrame(function () { rafs.push(requestAnimationFrame(shown)); }));
    try {
      /** @type {Record<string, number>} */
      const st = {};
      st[opts.stateKey] = 1;
      history.pushState(st, '', location.href);
      pushed = true;
    } catch (e) {
      pushed = false;
    }
  }
  /** 只收界面（滑出后关 <dialog>），不动历史 */
  function hide() {
    cancelPending();
    const my = ++gen;
    btn.setAttribute('aria-expanded', 'false');
    /* 还没真正滑出来（opening 且 is-open 没加上）或减弱动效：没有可等的滑出，直接关 */
    const slid = dlg.classList.contains('is-open');
    dlg.classList.remove('is-open');
    if (!dlg.open || !slid || reducedMotion()) {
      settleClosed();
      return;
    }
    setState('closing');
    timer = window.setTimeout(function () {
      timer = null;
      if (my === gen) settleClosed();
    }, MS);
  }
  /** @param {() => void} [after] */
  function close(after) {
    if (!dlg.open) {
      if (after) after();
      return;
    }
    hide();
    if (pushed) {
      pushed = false;
      awaiting = after || noop;
      history.back();
    } else if (after) {
      after();
    }
  }

  /* Esc（原生 cancel）：自己关，带滑出动画并退掉哨兵 */
  dlg.addEventListener('cancel', function (e) {
    e.preventDefault();
    close();
  });
  /* <dialog> 被我们以外的途径关掉（浏览器连按 Esc 时可能无视 preventDefault 强关）：同步状态并退掉哨兵 */
  dlg.addEventListener('close', function () {
    if (dlg.getAttribute('data-state') === 'closed') return;
    gen++;
    settleClosed();
    if (pushed) {
      pushed = false;
      awaiting = noop;
      history.back();
    }
  });
  /* 系统返回：哨兵出栈 → 只关本层，停在本页 */
  window.addEventListener('popstate', function () {
    if (awaiting) {
      const fn = awaiting;
      awaiting = null;
      fn();
      return;
    }
    if (dlg.open) {
      pushed = false;
      hide();
    }
  });
  /* bfcache 恢复：一律收起 */
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && dlg.open) {
      pushed = false;
      awaiting = null;
      gen++;
      settleClosed();
    }
  });

  return {
    open,
    close,
    isOpen: function () {
      return dlg.open;
    },
  };
}
