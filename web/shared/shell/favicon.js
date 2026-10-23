/**
 * @fileoverview 标签页图标跟主题色（2026-10-21）。
 *
 * 静态图标：/favicon.ico（16 / 32 / 48）+ /favicon.svg（默认色板 dustyblue 浅色主色方块 + 白色 S；2026-10-23 PR-G 起，原来是 lake 湖蓝）。
 * 换了调色板（data-palette）、自定义主题色（<style id="sgx-accent-roles">）或深浅色时，
 * 把 <link rel="icon" type="image/svg+xml"> 换成同一个 SVG 的 data: 地址：方块底 = 当前 --sgx-primary，S = --sgx-on-primary。
 * 和静态图标同色（默认 dustyblue 亮色）就换回 /favicon.svg。取不到 SVG / 颜色就什么都不做（静态图标照常生效）。
 */
const SRC = '/favicon.svg';
const BG = '#7e6000';
const FG = '#fff';
const HEX = /^#[0-9a-f]{6}$/;

/** 'rgb(1, 2, 3)' / '#abcdef' → '#rrggbb'；认不出返回 '' @param {string} v */
export function toHex(v) {
  const s = String(v || '').trim().toLowerCase();
  if (HEX.test(s)) return s;
  const m = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return '';
  return '#' + [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, +n)).toString(16).padStart(2, '0')).join('');
}

/** 静态 SVG 换色 → data: 地址；静态文件里没有默认色就返回 '' @param {string} svg @param {string} bg @param {string} fg */
export function recolor(svg, bg, fg) {
  if (!svg.includes('fill="' + BG + '"') || !svg.includes('fill="' + FG + '"')) return '';
  const out = svg.replace('fill="' + BG + '"', 'fill="' + bg + '"').replace('fill="' + FG + '"', 'fill="' + fg + '"');
  return 'data:image/svg+xml,' + encodeURIComponent(out);
}

let svgText = null;
let last = '';

function current() {
  const cs = getComputedStyle(document.documentElement);
  return { bg: toHex(cs.getPropertyValue('--sgx-primary')), fg: toHex(cs.getPropertyValue('--sgx-on-primary')) || FG };
}

async function apply() {
  const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
  if (!link) return;
  const { bg, fg } = current();
  const key = bg + fg;
  if (!bg || key === last) return;
  last = key;
  if (bg === BG) {
    if (link.getAttribute('href') !== SRC) link.setAttribute('href', SRC);
    return;
  }
  try {
    if (svgText === null) {
      const res = await fetch(SRC, { credentials: 'same-origin' });
      svgText = res.ok ? await res.text() : '';
    }
    const url = svgText && recolor(svgText, bg, fg);
    if (url && last === key) link.setAttribute('href', url);
  } catch (e) {
    svgText = '';
  }
}

export function initFavicon() {
  if (typeof MutationObserver === 'undefined') return;
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  };
  /* <html> 的 class（dark）/ data-palette / style（--sgx-seed），以及 <head> 里自定义色角色 <style> 的增删改 */
  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-palette', 'style', 'data-dark'] });
  mo.observe(document.head, { childList: true, subtree: true, characterData: true });
  window.addEventListener('sgx-settings-changed', schedule);
  schedule();
}
