/**
 * @fileoverview 终端窗口里的全屏阅读页（S9，Gray 2026-11-11：man 像 less 一样整屏看，看完回原来的命令行，不接进滚动区）。
 *
 * 盖住终端正文（滚动区 + 输入行）和按键提示行，只留标题栏：上面是正文（可滚动），最下一行是 less 式的反色状态栏
 * 「SUB(1) · 42%　q 退出」+ 一个「‹ 返回」按钮。退出：q、esc、‹ 返回（触屏）。滚动：↑↓ / j k 一行，空格 / PageDown / f、b / PageUp 一屏，g / Home、G / End。
 * 退出后正文原样露出来（滚动区不动），焦点还给输入行（由调用方 onClose 做）。
 * 不认识命令：宿主给行（[类, 文字, 链接?] 段）和一个把段画成元素的函数。
 */

/**
 * @param {{ root: HTMLElement, hide: HTMLElement[], seg: (s: [string, string, string?]) => Node, str: { quit: string, back: string, backAria: string, label: string },
 *   onClose: () => void }} o hide = 打开时要盖住（藏起来）的元素；str.quit = 状态栏右边那句（q 或 esc 退出）
 */
export function createPager(o) {
  const doc = o.root.ownerDocument || document;
  const box = doc.createElement('div');
  box.className = 'sgx-term-man';
  box.setAttribute('data-term-man', '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', o.str.label);
  box.hidden = true;
  const body = doc.createElement('div');
  body.className = 'sgx-term-man-body';
  body.setAttribute('data-term-man-body', '');
  body.tabIndex = 0;
  const bar = doc.createElement('div');
  bar.className = 'sgx-term-man-bar';
  const st = doc.createElement('span');
  st.className = 'sgx-term-man-st';
  st.setAttribute('data-term-man-st', '');
  st.setAttribute('translate', 'no');
  const hint = doc.createElement('span');
  hint.className = 'sgx-term-man-q';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = o.str.quit;
  const back = doc.createElement('button');
  back.type = 'button';
  back.className = 'sgx-term-man-back';
  back.setAttribute('data-term-man-back', '');
  back.setAttribute('aria-label', o.str.backAria);
  back.textContent = o.str.back;
  bar.appendChild(st);
  bar.appendChild(hint);
  bar.appendChild(back);
  box.appendChild(body);
  box.appendChild(bar);
  const last = o.hide[o.hide.length - 1];
  if (last && last.parentNode) last.parentNode.insertBefore(box, last.nextSibling);
  else o.root.appendChild(box);

  let open = false;
  let title = '';
  /** 每个被盖住的元素原来的 hidden */
  let was = /** @type {boolean[]} */ ([]);

  function paintSt() {
    const max = body.scrollHeight - body.clientHeight;
    const pct = max > 0 ? Math.round((body.scrollTop / max) * 100) : 100;
    st.textContent = title + ' · ' + (pct >= 100 ? '(END)' : pct + '%');
  }
  body.addEventListener('scroll', paintSt, { passive: true });

  /** @param {number} dy */
  function by(dy) { body.scrollTop += dy; paintSt(); }
  function lineH() {
    try { return parseFloat(getComputedStyle(body).lineHeight) || 24; } catch (e) { return 24; }
  }

  /**
   * 打开：画行、盖住正文
   * @param {string} name 状态栏的页名（SUB(1)） @param {Array<{ seg: Array<[string, string, string?]>, cls?: string }>} lines
   */
  function show(name, lines) {
    title = name;
    body.textContent = '';
    lines.forEach(function (ln) {
      const div = doc.createElement('div');
      /* 正文行前面的四个空格换成缩进（折行时第二行也对齐，不回到最左） */
      const seg = ln.seg.slice();
      const ind = seg.length && /^ {4}/.test(seg[0][1]);
      if (ind) seg[0] = /** @type {[string, string, string?]} */ ([seg[0][0], seg[0][1].slice(4)].concat(seg[0].slice(2)));
      div.className = 'sgx-term-ln' + (ln.cls ? ' sgx-term-' + ln.cls : '') + (ind ? ' sgx-term-man-in' : '');
      seg.forEach(function (s) { if (s[1] || s[0]) div.appendChild(o.seg(s)); });
      if (!div.textContent) div.appendChild(doc.createTextNode('\u00a0'));
      body.appendChild(div);
    });
    was = o.hide.map(function (el) { return el.hidden; });
    o.hide.forEach(function (el) { el.hidden = true; });
    box.hidden = false;
    open = true;
    o.root.setAttribute('data-term-man-open', '');
    body.scrollTop = 0;
    paintSt();
    /* 焦点进正文（div，不弹键盘）：键盘滚动、读屏都从这里开始 */
    try { body.focus({ preventScroll: true }); } catch (e) {}
  }
  /** 退出（q / esc / ‹ 返回 / 外面要关窗口） */
  function close() {
    if (!open) return;
    open = false;
    box.hidden = true;
    body.textContent = '';
    o.root.removeAttribute('data-term-man-open');
    o.hide.forEach(function (el, i) { el.hidden = !!was[i]; });
    o.onClose();
  }

  back.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); close(); });
  /* 按键：开着时在 document 的捕获阶段接（焦点可能在阅读页正文、也可能掉到了 body——输入框跟正文一起藏起来了） */
  doc.addEventListener('keydown', function (e) {
    if (!open || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const page = Math.max(lineH(), body.clientHeight - lineH());
    /** @type {(() => void) | null} */
    let f = null;
    if (k === 'q' || k === 'Q' || k === 'Escape') f = close;
    else if (k === 'ArrowDown' || k === 'j' || k === 'Enter') f = function () { by(lineH()); };
    else if (k === 'ArrowUp' || k === 'k') f = function () { by(-lineH()); };
    else if (k === ' ' || k === 'PageDown' || k === 'f') f = function () { by(page); };
    else if (k === 'PageUp' || k === 'b') f = function () { by(-page); };
    else if (k === 'g' || k === 'Home') f = function () { body.scrollTop = 0; paintSt(); };
    else if (k === 'G' || k === 'End') f = function () { body.scrollTop = body.scrollHeight; paintSt(); };
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    f();
  }, true);

  return {
    show: show,
    close: close,
    isOpen: function () { return open; },
  };
}
