/**
 * @fileoverview 全站 toast（替代旧 window.__sgxToast）。
 */
import { on } from './events.js';

/** @type {HTMLElement|null} */
let el = null;
/** @type {number|null} */
let timer = null;

/**
 * 显示一条 toast。
 * @param {string} msg
 */
export function toast(msg) {
  if (!msg) return;
  if (!el) {
    el = document.createElement('div');
    el.className = 'sgx-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(function () {
    if (el) el.classList.remove('show');
  }, 3000);
}
