/**
 * 弹层统一行为（批次 A 收尾 A1–A6）：遮罩不关闭、返回手势先收键盘、× 关闭、眼睛不失焦。
 *
 * A1：点遮罩或弹层内输入框以外的空白处 → 只让输入框失焦、收起键盘，弹层保留。
 * A2：系统返回手势（cancel 事件）→ 键盘开着时先收起键盘，弹层保留；
 *     键盘已收起时再次返回才关闭弹层（当作取消）。
 * A3：每个弹层右上角 × 按钮（aria-label「关闭」/「Close」），点了才关闭。保留底部「取消」。
 * A4：点眼睛只切换显示/隐藏，不关闭弹层，不让输入框失焦
 *     （pointerdown/mousedown preventDefault 保住焦点）。
 * A5：「验证」「保存」按钮用 pointerup，不依赖 click 落点在遮罩上。
 * A6：关闭弹层时记一条诊断（原因：close-btn / back / cancel-btn / success）。
 */

/** 让当前聚焦的输入框失焦（收起键盘）。 */
export function blurFocusedInput(dlg) {
  const ae = document.activeElement;
  if (ae && ae.tagName && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
    ae.blur();
  }
  if (dlg) {
    const inputs = dlg.querySelectorAll('input, textarea');
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i] === document.activeElement) inputs[i].blur();
    }
  }
}

/**
 * 遮罩点击处理：点遮罩只失焦，不关闭。调用方在 dialog 的 click 监听里调用。
 * @param {MouseEvent} e
 * @param {HTMLElement} dlg dialog 元素
 * @returns {boolean} 是否处理了遮罩点击（true = 点的是遮罩，已处理）
 */
export function onDialogBackdrop(e, dlg) {
  if (e.target === dlg) {
    blurFocusedInput(dlg);
    return true;
  }
  return false;
}

/**
 * 返回手势（cancel 事件）处理：键盘开着时先收起键盘，弹层保留；
 * 键盘已收起时再次返回才关闭弹层（当作取消）。
 *
 * 「键盘开着」的判断：输入框聚焦 + 可视视口被压缩（软键盘顶起）+ 粗指针设备。
 * 只用 activeElement 判断会误判：桌面端弹层自动聚焦输入框时并没有软键盘，
 * 以及移动端键盘收起后焦点仍在输入框里——这两种情况按 Escape/返回都应直接关闭。
 * @param {Event} e cancel 事件
 * @param {HTMLElement} dlg dialog 元素
 * @param {function(string)} closeFn 关闭函数，传原因 'back'
 * @returns {boolean} 是否已处理（true = 已 preventDefault，不走默认关闭）
 */
export function onDialogCancel(e, dlg, closeFn) {
  if (isSoftKeyboardOpen()) {
    e.preventDefault();
    blurFocusedInput(dlg);
    return true;
  }
  e.preventDefault();
  closeFn('back');
  return true;
}

/** 软键盘是否开着：输入框聚焦 + visualViewport 被压缩 + 粗指针。 */
function isSoftKeyboardOpen() {
  const ae = document.activeElement;
  const inputFocused = !!(ae && ae.tagName && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'));
  if (!inputFocused) return false;
  try {
    if (typeof window === 'undefined' || !window.visualViewport) return false;
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: coarse)').matches) return false;
    /* 软键盘通常占 200–400px；100px 阈值排除地址栏伸缩等小幅变化 */
    return (window.innerHeight - window.visualViewport.height) > 100;
  } catch (err) {
    return false;
  }
}

/** 关闭弹层时记一条诊断（原因：close-btn / back / cancel-btn / success）。 */
export function recordDialogClose(who, reason) {
  try {
    if (typeof window.recordJump === 'function') {
      window.recordJump('dialog-close:' + who + ':' + reason, 'dialog-behavior.js:recordDialogClose');
    }
  } catch (e) {}
}

/**
 * 绑定提交按钮（验证/保存）：pointerup（要求 pointerdown 也在该按钮）+ click 兜底，去重只提交一次。
 * - pointerup：键盘收起布局移动时 click 可能落遮罩上，pointerup 不依赖 click 落点。
 * - click 兜底：键盘 Enter/空格触发按钮时只有 click，没有 pointerup。
 * - 去重只针对同一次手势：pointerup 提交后忽略紧跟着的那一次 click（500ms 内），
 *   之后自动允许再次提交，不靠调用方手动 reset。提交中的重复点击由调用方
 *   现有的 busy/disabled 逻辑挡。
 * @param {HTMLElement} btn 按钮元素
 * @param {function(Event)} handler 提交处理函数
 * @returns {function()} 重置函数（兼容旧调用，清空去重时间戳）
 */
export function bindSubmitButton(btn, handler) {
  if (!btn || typeof handler !== 'function') return function () {};
  let downOnBtn = false;
  let lastPointerupFireAt = 0;
  btn.addEventListener('pointerdown', function () { downOnBtn = true; });
  btn.addEventListener('pointerleave', function () { downOnBtn = false; });
  btn.addEventListener('pointerup', function (e) {
    if (!downOnBtn) return;
    downOnBtn = false;
    lastPointerupFireAt = Date.now();
    handler(e);
  });
  btn.addEventListener('click', function (e) {
    /* click 兜底：键盘 Enter/空格触发；pointerup 刚提交的同手势 click 去重（500ms 内） */
    if (Date.now() - lastPointerupFireAt < 500) return;
    handler(e);
  });
  return function resetSubmitButton() {
    lastPointerupFireAt = 0;
    downOnBtn = false;
  };
}
/**
 * 眼睛按钮（批次 A 验收修复 P2：睁眼/闭眼分离，统一在 bindEyeButton 实现）。
 * - 密文态渲染 eye-off（带斜线），明文态渲染 eye；图标与 icon.html 的 eye/eye-off 同款路径。
 * - 切换同步 aria-label（显示密码/隐藏密码）与 aria-pressed；.off 透明机制废弃。
 * - 文案由调用方传入 opts { showLabel, hideLabel }，或读按钮 data-eye-show/data-eye-hide，
 *   再兜底用按钮现有的 aria-label。
 * - 切换不丢焦点（pointerdown/mousedown preventDefault + input.focus()），不收键盘、不关弹层。
 * @param {HTMLElement} btn 眼睛按钮
 * @param {HTMLInputElement} input 密码输入框
 * @param {function(boolean)|{showLabel?:string, hideLabel?:string, onToggle?:function(boolean)}} [opts]
 *   旧调用传 function(show) 仍兼容（仅作附加回调）；新调用传 { showLabel, hideLabel }。
 * @returns {function()} 复位函数：把按钮 + 输入框同步回密文态（重开弹层时调用）
 */
export const EYE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
export const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><line x1="4" y1="4" x2="20" y2="20"/></svg>';
export function bindEyeButton(btn, input, opts) {
  if (!btn || !input) return function () {};
  let showLabel = '';
  let hideLabel = '';
  let onToggle = null;
  if (typeof opts === 'function') {
    onToggle = opts;
  } else if (opts && typeof opts === 'object') {
    showLabel = opts.showLabel || '';
    hideLabel = opts.hideLabel || '';
    onToggle = opts.onToggle || null;
  }
  if (!showLabel) {
    try { showLabel = btn.getAttribute('data-eye-show') || btn.getAttribute('aria-label') || ''; } catch (e) {}
  }
  if (!hideLabel) {
    try { hideLabel = btn.getAttribute('data-eye-hide') || ''; } catch (e) {}
  }
  function sync(show) {
    try { input.type = show ? 'text' : 'password'; } catch (e) {}
    try { btn.innerHTML = show ? EYE_SVG : EYE_OFF_SVG; } catch (e) {}
    try { btn.setAttribute('aria-pressed', show ? 'true' : 'false'); } catch (e) {}
    if (show && hideLabel) {
      try { btn.setAttribute('aria-label', hideLabel); } catch (e) {}
    } else if (!show && showLabel) {
      try { btn.setAttribute('aria-label', showLabel); } catch (e) {}
    }
  }
  /* 初始化即密文态：eye-off + aria-pressed=false + 显示密码 */
  sync(false);
  btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    const show = input.type !== 'text';
    sync(show);
    if (typeof onToggle === 'function') onToggle(show);
    /* 保住焦点（眼睛按钮 preventDefault 已拦住失焦，这里再补一次） */
    try { input.focus(); } catch (e2) {}
  });
  return function resetEyeButton() {
    sync(false);
  };
}
