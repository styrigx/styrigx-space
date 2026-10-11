/**
 * @fileoverview favicon 加载失败时的首字母圆形占位。
 * 通过 document 捕获阶段的 error 事件统一处理（img 需带 data-favname 属性），
 * 不再依赖内联 onerror 全局函数。
 */
import { on } from '../lib/events.js';

/**
 * 把加载失败的 img 替换为首字母占位。
 * @param {HTMLImageElement} img
 * @param {string} name
 */
export function favFallback(img, name) {
  try {
    const ch = String(name || '?').trim().charAt(0) || '?';
    const s = document.createElement('span');
    s.className = img.className;
    s.setAttribute('aria-hidden', 'true');
    /* ai 页（旧 __aiFavFallback）：无底色、18px；其余（旧 __favFallback）：底色、15px */
    if (img.classList.contains('ai-plat-ic')) {
      s.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:var(--m-on-surface-variant);';
    } else {
      s.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:var(--m-on-surface-variant);background:var(--m-container);';
    }
    s.textContent = ch;
    img.replaceWith(s);
  } catch (e) {
    img.style.display = 'none';
  }
}

/**
 * 绑定 favicon 失败兜底（幂等，整页调一次）。
 * @param {ParentNode} [root]
 * @returns {() => void} disposer
 */
export function bindFavFallback(root) {
  const dispose = on(
    root || document,
    'error',
    function (e) {
      const t = /** @type {Element|null} */ (e.target);
      if (t && t.tagName === 'IMG' && t.hasAttribute('data-favname')) {
        favFallback(/** @type {HTMLImageElement} */ (t), t.getAttribute('data-favname') || '');
      }
    },
    true
  );
  /* 2.8.0：补上绑定前已失败的图片。img 的 error 事件不冒泡，模块脚本
     晚于图片请求执行时，早失败的图片会错过监听、永远显示破图占位。
     此处同步替换已处于 broken 状态的（complete 且 naturalWidth 为 0）；
     仍在加载中的继续由上面的 error 监听兜底。 */
  try {
    const scope = root || document;
    const imgs = scope.querySelectorAll ? scope.querySelectorAll('img[data-favname]') : [];
    imgs.forEach(function (img) {
      if (img.complete && img.naturalWidth === 0) {
        favFallback(img, img.getAttribute('data-favname') || '');
      }
    });
  } catch (e) {}
  return dispose;
}
