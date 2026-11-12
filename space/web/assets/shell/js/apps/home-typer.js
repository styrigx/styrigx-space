/**
 * @fileoverview 主页 hero 的 $ 行标语打字轮播（Gray 2026-11-09：只轮播「A Personal Digital Space」这一句英文，中英页面相同）。
 * 参考 my-portfolio-jz1h.vercel.app：逐字打出 → 停顿 → 逐字删掉 → 短暂空白 → 再打，循环；光标是旁边已有的 .home-cur（CSS 闪烁）。
 *
 * - 首帧 / 无 JS：模板直接画整句（layouts/index.html [data-home-typer]）。挂上后从「整句 · 停顿」开始，不会先闪空。
 * - 减弱动效（<html class="reduced-motion"> 或系统 prefers-reduced-motion）：不动，保持整句；中途打开减弱动效也立刻停在整句。
 * - 标签页隐藏时暂停（不排下一步），回来接着走。
 * - 读屏：动的这份 aria-hidden，旁边 sr-only 一份完整文字（模板里），所以这里只改 textContent。
 * typerStep 是纯函数，单测看它（tests/space/ui/home/home-typer.test.mjs）。
 */
import { reducedMotion } from '../core/util.js';

/** 节奏（毫秒）：打字、删除、整句停顿、删空后的空白 */
export const TYPER_MS = Object.freeze({ type: 90, del: 45, hold: 2200, gap: 450 });

/**
 * @typedef {{i: number, phase: 'type'|'hold'|'del'|'gap'}} TyperState
 * i = 当前显示前几个字符；phase = 下一步要做什么
 */

/**
 * 走一步（纯函数）：返回下一个状态和到下一步的等待时间。
 * type：多显示一个字，满了转 hold；hold：停够了转 del；del：少一个字，空了转 gap；gap：转 type。
 * @param {TyperState} s
 * @param {number} len 整句字符数（Array.from 计）
 * @param {{type:number, del:number, hold:number, gap:number}} [ms]
 * @returns {{state: TyperState, wait: number}}
 */
export function typerStep(s, len, ms) {
  const t = ms || TYPER_MS;
  const n = Math.max(0, len | 0);
  const i = Math.min(Math.max(0, s.i | 0), n);
  if (n === 0) return { state: { i: 0, phase: 'hold' }, wait: t.hold };
  switch (s.phase) {
    case 'type': {
      const j = Math.min(n, i + 1);
      return j >= n ? { state: { i: n, phase: 'hold' }, wait: t.hold } : { state: { i: j, phase: 'type' }, wait: t.type };
    }
    case 'hold':
      return { state: { i: n, phase: 'del' }, wait: t.del };
    case 'del': {
      const j = Math.max(0, i - 1);
      return j <= 0 ? { state: { i: 0, phase: 'gap' }, wait: t.gap } : { state: { i: j, phase: 'del' }, wait: t.del };
    }
    default:
      return { state: { i: 0, phase: 'type' }, wait: t.type };
  }
}

/**
 * 挂到 [data-home-typer] 上（主页 hero 只有一个）。没有元素 / 没有文字返回 null。
 * @param {Element|null} el
 * @returns {{stop: () => void}|null}
 */
export function mountTyper(el) {
  if (!el) return null;
  const text = el.getAttribute('data-home-typer') || el.textContent || '';
  const chars = Array.from(text);
  if (!chars.length) return null;
  const full = function () { if (el.textContent !== text) el.textContent = text; };
  full();
  /** @type {TyperState} */
  let st = { i: chars.length, phase: 'hold' };
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  let stopped = false;
  const clear = function () { if (timer) { clearTimeout(timer); timer = null; } };
  const hidden = function () { return typeof document.visibilityState === 'string' && document.visibilityState === 'hidden'; };
  /** @param {number} wait */
  const schedule = function (wait) {
    clear();
    if (stopped || hidden()) return;
    timer = setTimeout(tick, wait);
  };
  const tick = function () {
    timer = null;
    if (stopped) return;
    if (reducedMotion()) { st = { i: chars.length, phase: 'hold' }; full(); return; }
    const r = typerStep(st, chars.length);
    st = r.state;
    el.textContent = chars.slice(0, st.i).join('');
    schedule(r.wait);
  };
  const onVis = function () {
    if (hidden()) clear();
    else if (!timer && !stopped && !reducedMotion()) schedule(st.phase === 'hold' ? TYPER_MS.hold : TYPER_MS.type);
  };
  document.addEventListener('visibilitychange', onVis);
  if (!reducedMotion()) schedule(TYPER_MS.hold);
  return {
    stop() { stopped = true; clear(); document.removeEventListener('visibilitychange', onVis); full(); },
  };
}
