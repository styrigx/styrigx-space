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

/**
 * 轻触觉反馈（批次 A 验收修复 P2）：支持 navigator.vibrate 时点击瞬间振约 10ms；
 * 不支持就跳过，不报错。
 */
export function tapFeedback() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10);
    }
  } catch (e) {}
}

/**
 * 行 busy 态（批次 A 验收修复 P2）：约定 class .sgx-row-busy + 行禁用（防重复点击）。
 * @param {HTMLElement} row 行元素
 * @param {boolean} busy 是否 busy
 */
export function setRowBusy(row, busy) {
  if (!row) return;
  try {
    if (busy) {
      row.classList.add('sgx-row-busy');
      row.disabled = true;
    } else {
      row.classList.remove('sgx-row-busy');
      row.disabled = false;
    }
  } catch (e) {}
}

/** 清除行 busy 态（setRowBusy(row, false) 的别名）。 */
export function clearRowBusy(row) {
  setRowBusy(row, false);
}

/**
 * 行选中态（批次 A 验收修复 P2）：约定 class .sgx-row-selected，背景保持高亮。
 * @param {HTMLElement} row 行元素
 * @param {boolean} selected 是否选中
 */
export function setRowSelected(row, selected) {
  if (!row) return;
  try {
    if (selected) row.classList.add('sgx-row-selected');
    else row.classList.remove('sgx-row-selected');
  } catch (e) {}
}

/**
 * One UI 通用确认弹层（批次 B：R1「再点一次」统一替换、#8 立即锁定、#10 删最后一把）。
 * 动态创建 <dialog class="sgx-center-dlg">，居中弹框，模态阻塞；遮罩点击不关闭；
 * 返回手势按 A2 处理（无输入框，键盘永不开 → 直接当取消）。
 * 排队防重入：已有弹层打开时，后续调用按顺序排队，不叠加。
 * @param {{title:string, desc?:string, cancelLabel?:string, confirmLabel?:string}} opts
 * @returns {Promise<boolean>} true = 点了确认，false = 取消/关闭
 */
let confirmQueue = Promise.resolve();
export function showConfirmDialog(opts) {
  const task = confirmQueue.then(function () { return openCenterDialog(opts, true); });
  /* 链不断：即使本次抛错，后续调用仍能执行 */
  confirmQueue = task.catch(function () {});
  return task;
}

/**
 * One UI 通用单按钮提示弹层（批次 B：#13 到期、#16 第一把，与确认弹层共用 helper）。
 * 与 showConfirmDialog 同队列、同样式，只有一个按钮。
 * @param {{title:string, desc?:string, buttonLabel?:string}} opts
 * @returns {Promise<void>}
 */
export function showAlertDialog(opts) {
  const task = confirmQueue.then(function () { return openCenterDialog(opts, false); });
  confirmQueue = task.catch(function () {});
  return task;
}

/**
 * 居中弹层实现（confirm/alert 共用）。
 * @param {{title:string, desc?:string, cancelLabel?:string, confirmLabel?:string, buttonLabel?:string}} opts
 * @param {boolean} isConfirm true = 确认弹层（取消 + 确认），false = 单按钮提示
 * @returns {Promise<boolean|void>}
 */
function openCenterDialog(opts, isConfirm) {
  return new Promise(function (resolve) {
    const o = opts || {};
    const dlg = document.createElement('dialog');
    dlg.className = 'sgx-center-dlg';
    dlg.setAttribute('aria-label', o.title || '');
    const card = document.createElement('div');
    card.className = 'sgx-center-card';
    const title = document.createElement('h2');
    title.className = 'sgx-verify-title';
    title.textContent = o.title || '';
    card.appendChild(title);
    if (o.desc) {
      const desc = document.createElement('p');
      desc.className = 'sgx-verify-desc';
      desc.textContent = o.desc;
      card.appendChild(desc);
    }
    const actions = document.createElement('div');
    actions.className = 'sgx-verify-actions';
    let settled = false;
    function done(result) {
      if (settled) return;
      settled = true;
      try { dlg.close(); } catch (e) {}
      try { dlg.remove(); } catch (e) {}
      resolve(result);
    }
    if (isConfirm) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'sgx-verify-ghost';
      cancelBtn.textContent = o.cancelLabel || '取消';
      cancelBtn.addEventListener('click', function () { done(false); });
      actions.appendChild(cancelBtn);
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'sgx-verify-skip';
      okBtn.textContent = o.confirmLabel || '确认';
      okBtn.addEventListener('click', function () { done(true); });
      actions.appendChild(okBtn);
    } else {
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'sgx-verify-skip';
      okBtn.textContent = o.buttonLabel || '知道了';
      okBtn.addEventListener('click', function () { done(undefined); });
      actions.appendChild(okBtn);
    }
    card.appendChild(actions);
    dlg.appendChild(card);
    /* 遮罩点击不关闭（A1）；返回手势当取消（A2，无输入框） */
    dlg.addEventListener('click', function (e) { onDialogBackdrop(e, dlg); });
    dlg.addEventListener('cancel', function (e) {
      onDialogCancel(e, dlg, function () { done(isConfirm ? false : undefined); });
    });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { done(isConfirm ? false : undefined); }
  });
}
