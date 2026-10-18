/**
 * @fileoverview 全局滚动/尺寸调度器（替代旧 window.__sgxScroll）。
 * 全站只挂一个 passive scroll + 一个 resize，同一 rAF 内读一次再分发；
 * 模块回调只做写（transform/opacity/class）。
 * @fileoverview 可见性感知定时器（替代旧 window.__sgxVisibleInterval）。
 */
import { on } from './events.js';

/**
 * @typedef {Object} Scheduler
 * @property {(cb: (y: number, w: number, h: number) => void) => void} onScroll
 * @property {(cb: (w: number, h: number, y: number) => void) => void} onResize
 * @property {() => void} kick 手动触发一次分发
 */

/** @type {Scheduler|null} */
let inst = null;

/**
 * 获取全局调度器单例（懒创建）。
 * @returns {Scheduler}
 */
export function getScheduler() {
  if (inst) return inst;
  /** @type {Array<(y: number, w: number, h: number) => void>} */
  const scrollCbs = [];
  /** @type {Array<(w: number, h: number, y: number) => void>} */
  const resizeCbs = [];
  let ticking = false;
  let lastY = -1,
    lastW = 0,
    lastH = 0;
  function dispatch() {
    ticking = false;
    const y = window.scrollY || 0,
      w = window.innerWidth,
      h = window.innerHeight;
    const sc = y !== lastY,
      rs = w !== lastW || h !== lastH;
    if (sc) {
      lastY = y;
      for (let i = 0; i < scrollCbs.length; i++) scrollCbs[i](y, w, h);
    }
    if (rs) {
      lastW = w;
      lastH = h;
      for (let j = 0; j < resizeCbs.length; j++) resizeCbs[j](w, h, y);
    }
  }
  function kick() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(dispatch);
  }
  on(window, 'scroll', kick, { passive: true });
  on(window, 'resize', kick);
  inst = {
    onScroll(cb) {
      scrollCbs.push(cb);
    },
    onResize(cb) {
      resizeCbs.push(cb);
    },
    kick,
  };
  return inst;
}

/**
 * 可见性感知定时器：页面不可见时暂停，可见时立即刷新一次再继续。
 * @param {() => void} fn
 * @param {number} ms
 * @returns {() => void} 停止函数
 */
export function visibleInterval(fn, ms) {
  /** @type {number|null} */
  let iv = null;
  function stop() {
    if (iv) {
      clearInterval(iv);
      iv = null;
    }
  }
  function start() {
    stop();
    try {
      fn();
    } catch (e) {}
    iv = window.setInterval(fn, ms);
  }
  const dispose = on(document, 'visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });
  start();
  return function () {
    dispose();
    stop();
  };
}
