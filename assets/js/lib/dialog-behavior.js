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
 * 返回手势（cancel 事件）处理：键盘开着先收键盘，键盘已收起才关闭。
 * @param {Event} e cancel 事件
 * @param {HTMLElement} dlg dialog 元素
 * @param {function(string)} closeFn 关闭函数，传原因 'back'
 * @returns {boolean} 是否已处理（true = 已 preventDefault，不走默认关闭）
 */
export function onDialogCancel(e, dlg, closeFn) {
  const ae = document.activeElement;
  const kbOpen = !!(ae && ae.tagName && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'));
  if (kbOpen) {
    e.preventDefault();
    blurFocusedInput(dlg);
    return true;
  }
  e.preventDefault();
  closeFn('back');
  return true;
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
 * - 去重：pointerup 和 click 可能都触发，用 fired 标志只提交一次；提交后重置需调用方在下一轮重新绑定或手动重置。
 * @param {HTMLElement} btn 按钮元素
 * @param {function(Event)} handler 提交处理函数
 * @returns {function()} 重置函数，调用后允许再次提交（用于表单重置/弹层重开）
 */
export function bindSubmitButton(btn, handler) {
  if (!btn || typeof handler !== 'function') return function () {};
  let downOnBtn = false;
  let fired = false;
  function fire(e) {
    if (fired) return;
    fired = true;
    handler(e);
  }
  btn.addEventListener('pointerdown', function () { downOnBtn = true; });
  btn.addEventListener('pointerleave', function () { downOnBtn = false; });
  btn.addEventListener('pointerup', function (e) {
    if (!downOnBtn) return;
    downOnBtn = false;
    fire(e);
  });
  btn.addEventListener('click', function (e) {
    /* click 兜底：键盘 Enter/空格触发；pointerup 已提交时去重 */
    fire(e);
  });
  return function resetSubmitButton() {
    fired = false;
    downOnBtn = false;
  };
}
export function bindEyeButton(btn, input, onToggle) {
  if (!btn || !input) return;
  btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
  btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    const show = input.type !== 'text';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    if (typeof onToggle === 'function') onToggle(show);
    /* 保住焦点（眼睛按钮 preventDefault 已拦住失焦，这里再补一次） */
    try { input.focus(); } catch (e2) {}
  });
}
