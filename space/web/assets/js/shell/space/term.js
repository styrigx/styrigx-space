/**
 * @fileoverview 进站终端外壳（进站 v3，SPACE-V3 §1.3「前端文件」/ §2.2）：锁屏（shell/space/entry.js，全屏）和盾牌（shell/space/shield.js，下拉）共用的
 * 一行真输入框 + 输出区：输出行、命令回显、选项（可点）、不回显的秘密输入、^C / esc、↑↓ 历史、手机输入法回车补提交（#333 的 IME 修正）、
 * 触屏 ^C 键、一轮结束后把焦点还给输入行。写法照账号终端外壳 shell/account/term.js（那边是一个宿主，这边两个宿主）。
 *
 * 不认识任何命令：宿主传 onCmd(raw)（命令模式下回车）和 ps()（命令行提示符）。类名都带宿主给的前缀 p
 * （锁屏 sgx-entry、盾牌复用账号下拉的 sgx-at），行样式 `<p>-l` + `<p>-l--<d|er|warn|ok|echo|opts>`。
 */
import { esc } from '../../lib/util.js';

/**
 * @typedef {Object} TermDom
 * @property {HTMLElement} root 点它的空白处 = 聚焦输入行；选项 / ^C 按钮的点击在这里接
 * @property {HTMLElement} log 输出区（aria-hidden，读屏走 live）
 * @property {HTMLFormElement} form
 * @property {HTMLInputElement} input
 * @property {HTMLElement} ps 提示符（label）
 * @property {HTMLInputElement} pmu 给密码管理器的隐藏用户名
 * @property {HTMLElement} hint 输入行下面一行注释 + 触屏 ^C
 * @property {HTMLElement} live aria-live 区
 */

/** 输入不回显的模式：解锁密码、临时钥匙、恢复钥匙、新密码两次 */
export const SECRET_MODES = Object.freeze(['pw', 'temp', 'rkey', 'newpw', 'newpw2']);

/**
 * @param {{
 *   dom: TermDom,
 *   p: string,
 *   t: (k: string) => string,
 *   ps: () => string,
 *   onCmd: (raw: string) => void,
 *   isShown?: () => boolean,
 *   ariaCmd?: string,
 *   maxLines?: number,
 *   onMode?: (m: string) => void,
 *   onReveal?: (el: HTMLElement) => void,
 *   onCmdInterrupt?: () => boolean,
 * }} o
 */
export function createTerm(o) {
  const d = o.dom;
  const p = o.p;
  const t = o.t;
  const input = d.input;
  const form = d.form;
  const doc = input.ownerDocument || document;
  const isShown = o.isShown || function () { return true; };
  /** @type {string[]} */ const hist = [];
  let histIdx = 0;
  /** pick 模式的选项 { key → fn } */ let picks = /** @type {Record<string, () => void>} */ ({});
  let pickDefault = '';

  /** @type {any} */
  const C = {
    t: t, esc: esc, input: input, p: p,
    /** @type {string} cmd · pick · pw · temp · rkey · newpw · newpw2 · pkname · busy · done */ mode: 'cmd',
    /** 当前一轮的输错次数 */ tries: 0,
    /** 秘密输入 / 命名的提交函数 */ onSecret: null,
    /** ^C 时额外做的事 */ onCancel: null,
    /** 等待中（busy）也能 ^C 的那件事（通行密钥）：^C 时调它 */ busyCancel: null,
    /** 进 busy 时输入行有焦点：回命令行要把焦点还回来 */ refocus: false,
  };
  const live = function (/** @type {string} */ s) { if (s) d.live.textContent = s; };

  /* ---------- 输出 ---------- */
  /** @param {string} html @param {string} [cls] d 注释 · er 出错 · warn 提示 · ok 通过 · echo 回显（不播报）· opts 选项 */
  C.out = function (html, cls) {
    const el = doc.createElement('div');
    el.className = p + '-l' + (cls ? ' ' + p + '-l--' + cls : '');
    el.innerHTML = html;
    d.log.appendChild(el);
    while (o.maxLines && d.log.childNodes.length > o.maxLines) d.log.removeChild(/** @type {Node} */ (d.log.firstChild));
    if (cls !== 'echo') live(el.textContent || '');
    if (o.onReveal) o.onReveal(el);
    return el;
  };
  /** 命令回显（当前提示符 + 命令） @param {string} cmd @param {string} [ps] */
  C.echo = function (cmd, ps) { C.out('<span class="' + p + '-p">' + esc(ps || o.ps()) + '</span> <span class="' + p + '-w">' + esc(cmd) + '</span>', 'echo'); };
  /** 选项回显 `> 2` @param {string} key */
  C.echoPick = function (key) { C.out('<span class="' + p + '-p">&gt;</span> <span class="' + p + '-w">' + esc(key) + '</span>', 'echo'); };
  /** 黄色命令字 @param {string} s */
  C.k = function (s) { return '<span class="' + p + '-y" translate="no">' + esc(s) + '</span>'; };
  /** 注释行 `# …`（{x} 换成黄色命令） @param {string} txt @param {string} [x] */
  C.note = function (txt, x) { return C.out('# ' + esc(txt).replace('{x}', x ? C.k(x) : ''), 'd'); };
  /** 成功行 @param {string} txt @param {string} [dim] */
  C.ok = function (txt, dim) { return C.out('<span class="' + p + '-ok">' + esc(txt) + '</span>' + (dim ? ' <span class="' + p + '-dim">· ' + esc(dim) + '</span>' : '')); };
  /** 红字（{x} 换成黄色命令） @param {string} txt @param {string} [x] */
  C.err = function (txt, x) { return C.out(esc(txt).replace('{x}', x ? C.k(x) : ''), 'er'); };
  /** 黄字提示 @param {string} txt @param {string} [x] */
  C.warn = function (txt, x) { return C.out(esc(txt).replace('{x}', x ? C.k(x) : ''), 'warn'); };
  /** 选项行（每个是能点的按钮） @param {Array<[string, string, boolean?]>} list [键, 文字, 默认?] */
  C.opts = function (list) {
    return C.out(list.map(function (it) {
      return '<button type="button" class="' + p + '-o' + (it[2] ? ' is-on' : '') + '" data-term-pick="' + esc(it[0]) + '"><b translate="no">[' + esc(it[0]) + ']</b> ' + esc(it[1]) + '</button>';
    }).join(''), 'opts');
  };
  C.clearLog = function () { d.log.textContent = ''; };

  /* ---------- 输入行 ---------- */
  const isSecret = function (/** @type {string} */ m) { return SECRET_MODES.indexOf(m) !== -1; };
  /**
   * 切换输入行。x.ps 提示符（默认：pick / pkname → `>`，其余 = 宿主的 ps()）；x.pm 隐藏用户名；x.hint 注释；x.cc 等待中也显示 ^C；x.aria 输入框读屏名
   * @param {string} m @param {{ps?: string, pm?: string, hint?: string, cc?: boolean, aria?: string, inputmode?: string}} [x]
   */
  C.setMode = function (m, x) {
    if ((m === 'busy' || m === 'done') && doc.activeElement === input) C.refocus = true;
    C.mode = m;
    const secret = isSecret(m);
    form.setAttribute('data-mode', m);
    input.value = '';
    input.readOnly = false;
    input.type = secret ? 'password' : 'text';
    input.setAttribute('autocomplete', m === 'pw' || m === 'rkey' ? 'current-password' : m === 'newpw' || m === 'newpw2' ? 'new-password' : 'off');
    input.setAttribute('inputmode', (x && x.inputmode) || (m === 'pick' ? 'numeric' : 'text'));
    input.setAttribute('aria-label', (x && x.aria) || (secret ? t('common.secretAria') : m === 'pkname' ? t('keys.nameAria') : o.ariaCmd || t('common.termAria')));
    if (x && x.pm) d.pmu.value = x.pm;
    d.ps.textContent = (x && x.ps) || (m === 'pick' || m === 'pkname' ? '>' : o.ps());
    const hidden = m === 'busy' || m === 'done';
    form.hidden = hidden;
    input.disabled = hidden;
    const cc = secret || m === 'pick' || m === 'pkname' || !!(x && x.cc);
    if ((x && x.hint) || cc) {
      d.hint.innerHTML = (x && x.hint ? '# ' + esc(x.hint) : '') +
        (cc ? '<span class="' + p + '-cc">' + (x && x.hint ? ' · ' : '# ') + '<button type="button" data-term-cc translate="no" aria-label="' + esc(t('common.interruptAria')) + '">^C</button></span>' : '');
      d.hint.classList.toggle(p + '-hint--cc', cc && !(x && x.hint));
      d.hint.hidden = false;
    } else d.hint.hidden = true;
    if (o.onMode) o.onMode(m);
  };
  /** 回命令行（一轮结束 / ^C / 出错）；原来输入行有焦点就还回去（触屏键盘收起后命令行像死了，#333） */
  C.toCmd = function () {
    picks = {};
    pickDefault = '';
    C.onSecret = null;
    C.onCancel = null;
    C.busyCancel = null;
    const rf = C.refocus;
    C.refocus = false;
    C.setMode('cmd');
    if (rf) C.focusIn(true);
  };
  /** 秘密输入 / 命名 @param {string} m @param {(v: string) => void} fn @param {{ps?: string, pm?: string, hint?: string, aria?: string}} [x] */
  C.ask = function (m, fn, x) {
    C.onSecret = fn;
    C.setMode(m, x);
    C.focusIn();
  };
  /** 选择（数字 / 名字；回车 = 默认项） @param {Record<string, () => void>} pk @param {string} [def] @param {{ps?: string}} [x] */
  C.pick = function (pk, def, x) {
    picks = pk;
    pickDefault = def || '';
    C.setMode('pick', x);
    C.focusIn();
  };
  /** 聚焦输入行。触屏上只在要输秘密 / 名字时自动聚焦（不一打开就弹键盘），force 例外 @param {boolean} [force] */
  C.focusIn = function (force) {
    if (!isShown() || form.hidden) return;
    let fine = true;
    try { fine = window.matchMedia('(pointer: fine)').matches; } catch (e) {}
    if (!fine && !isSecret(C.mode) && C.mode !== 'pkname' && !force) return;
    try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
  };
  /** ^C / esc：退出当前命令。回 true = 这一下被吃掉了 */
  C.interrupt = function () {
    if (C.mode === 'cmd') return o.onCmdInterrupt ? o.onCmdInterrupt() : false;
    if (C.mode === 'done') return false;
    if (C.mode === 'busy') {
      const b = C.busyCancel;
      if (!b) return false;
      C.out('^C', 'd');
      b();
      C.toCmd();
      return true;
    }
    C.out((d.ps.textContent || '') + ' ^C', 'd');
    const c = C.onCancel;
    C.toCmd();
    if (c) c();
    return true;
  };
  /** 输入行只读（冷却倒计时） @param {boolean} b */
  C.readOnly = function (b) { input.readOnly = b; };

  /* ---------- 事件 ---------- */
  /** 提交次数 / 最近一次 enter 按下时的提交次数（-1 = 没有待补的 enter），见下面 keyup */
  let subN = 0;
  let enterAt = -1;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    subN++;
    const v = input.value;
    const m = C.mode;
    if (m === 'busy' || m === 'done' || input.readOnly) return;
    if (m === 'pick') {
      const key = String(v || '').trim().toLowerCase() || pickDefault;
      const fn = picks[key] || picks[key.replace(/^\[|\]$/g, '')];
      input.value = '';
      if (fn) { picks = {}; fn(); return; }
      /* 选项里没有的：说一声、接着选（不算次数） */
      if (key) { C.echoPick(key); C.err(t('common.noOption')); }
      return;
    }
    if (isSecret(m) || m === 'pkname') {
      if (m !== 'pkname' && !v) return;
      const fn = C.onSecret;
      input.value = '';
      if (m !== 'pkname') C.out('<span class="' + p + '-p">' + esc(d.ps.textContent || '') + '</span>', 'echo');
      if (fn) fn(v);
      return;
    }
    input.value = '';
    const shown = v.replace(/\s+/g, ' ').trim();
    if (shown && hist[hist.length - 1] !== shown) hist.push(shown);
    histIdx = hist.length;
    o.onCmd(v);
  });
  const submit = function () {
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true }));
  };
  input.addEventListener('keydown', function (e) {
    /* enter 提交：表单里还有密码管理器用的隐藏用户名框（两个文本框），浏览器不做隐式提交 */
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      enterAt = subN;
      if (e.isComposing) return;
      e.preventDefault();
      submit();
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (C.mode === 'cmd' && input.selectionStart !== input.selectionEnd) return;
      e.preventDefault();
      if (!C.interrupt()) {
        C.echo((input.value || '') + '^C');
        input.value = '';
      }
      return;
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L') && C.mode === 'cmd') { e.preventDefault(); C.clearLog(); return; }
    if (C.mode === 'pick' && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && !input.value && picks[e.key.toLowerCase()]) {
      e.preventDefault();
      const fn = picks[e.key.toLowerCase()];
      picks = {};
      fn();
      return;
    }
    if (C.mode !== 'cmd') return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && hist.length) {
      e.preventDefault();
      histIdx = Math.max(0, Math.min(hist.length, histIdx + (e.key === 'ArrowUp' ? -1 : 1)));
      input.value = hist[histIdx] || '';
    }
  });
  /* 手机输入法（三星键盘、Gboard 联想）在命令行按 enter 时 keydown 常带 isComposing，上面不提交、浏览器也不隐式提交：keyup 补一次 */
  input.addEventListener('keyup', function (e) {
    if (e.key !== 'Enter' || enterAt < 0) return;
    const at = enterAt;
    enterAt = -1;
    if (e.isComposing || at !== subN || C.mode === 'busy') return;
    submit();
  });
  d.root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    if (!tg || !tg.closest) return;
    if (tg.closest('[data-term-cc]')) { e.preventDefault(); C.refocus = true; if (!C.interrupt()) C.toCmd(); return; }
    const pk = /** @type {HTMLElement|null} */ (tg.closest('[data-term-pick]'));
    if (pk) {
      const key = pk.getAttribute('data-term-pick') || '';
      const fn = C.mode === 'pick' && picks[key];
      if (fn) { picks = {}; C.refocus = true; fn(); }
      return;
    }
    if (tg.closest('[data-term-log], form') && !tg.closest('button, a, input')) C.focusIn(true);
  });

  return C;
}

/**
 * 嵌套字符串表 → 点号键（space.session.lead → 'session.lead'）
 * @param {any} tree @param {string} [pre] @param {Record<string, string>} [acc]
 * @returns {Record<string, string>}
 */
export function flatStrings(tree, pre, acc) {
  const out = acc || {};
  if (!tree || typeof tree !== 'object') return out;
  for (const k in tree) {
    const v = tree[k];
    const key = pre ? pre + '.' + k : k;
    if (v && typeof v === 'object') flatStrings(v, key, out);
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/**
 * 外壳字符串表（#sgx-i18n-shell，四站同一份，当前语言已叠在英文上）的一节 → 取文案函数（缺键回 ''）。
 * @param {Document} doc @param {string} sec 例如 'space' @returns {(k: string) => string}
 */
export function shellTable(doc, sec) {
  /** @type {Record<string, string>} */
  let S = {};
  try {
    const el = doc.getElementById('sgx-i18n-shell');
    const j = el && el.textContent ? JSON.parse(el.textContent) : null;
    S = flatStrings(j && j[sec]);
  } catch (e) {}
  return function (k) { return S[k] || ''; };
}
