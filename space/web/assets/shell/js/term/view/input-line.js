/**
 * @fileoverview 终端输入行 + 输出区（终端统一 T2，设计稿 v1.5 §4）：锁屏 / 盾牌（shell/space/term.js 转出，宿主 entry.js、shield.js）
 * 和账号下拉（shell/account/term.js）以前各写一份、约 200 行几乎一样，这里合成一份。
 * 一行真输入框 + 输出区：输出行、命令回显、选项（可点）、不回显的秘密输入、^C / esc、↑↓ 历史、手机输入法回车补提交（#333 的 IME 修正）、
 * 触屏 ^C 键、一轮结束后把焦点还给输入行。
 *
 * 不认识任何命令：宿主传 onCmd(raw)（命令模式下回车）和 ps()（命令行提示符）。类名都带宿主给的前缀 p
 * （锁屏 sgx-entry、盾牌和账号下拉 sgx-at），行样式 `<p>-l` + `<p>-l--<d|er|warn|ok|echo|opts>`；
 * 选项 / ^C 按钮的属性名由 attr 决定（锁屏 / 盾牌 data-term-pick / data-term-cc，账号下拉 data-at-pick / data-at-cc）。
 * 两边原有的细小差别（账号下拉没有历史、^C 回显、选择里敲命令等）用参数保留，产出的 DOM 和行为与 T2 之前逐字一致；T4 再统一。
 */
import { esc } from '../core/out.js';
import { mountKeyHint, khKeyFor } from './keyhint.js';
import { paintPick, pickInputMode } from './pick.js';
import { createHistory } from '../core/history.js';

/** 输入不回显的模式：解锁密码、恢复钥匙、新密码两次 */
export const SECRET_MODES = Object.freeze(['pw', 'rkey', 'newpw', 'newpw2']);

/**
 * @typedef {Object} TermDom
 * @property {HTMLElement} root 点它的空白处 = 聚焦输入行；选项 / ^C 按钮的点击在这里接
 * @property {HTMLElement} log 输出区（aria-hidden，读屏走 live）
 * @property {HTMLFormElement} form
 * @property {HTMLInputElement} input
 * @property {HTMLElement} ps 提示符（label）
 * @property {HTMLElement} hint 输入行下面一行注释 + 触屏 ^C
 * @property {HTMLElement} live aria-live 区
 * @property {HTMLElement} [kh] 最底一行按键提示（shell/keyhint.js；可选）
 */

/**
 * @typedef {Object} InputLineOpts
 * @property {TermDom} dom
 * @property {string} p 类名前缀
 * @property {(k: string) => string} t
 * @property {() => string} ps
 * @property {(raw: string) => void} onCmd
 * @property {() => boolean} [isShown]
 * @property {string} [ariaCmd]
 * @property {number} [maxLines]
 * @property {(m: string) => void} [onMode]
 * @property {(el: HTMLElement) => void} [onReveal]
 * @property {() => boolean} [onCmdInterrupt]
 * @property {{ cmdKey: () => string, canBackCmd: () => boolean, onBack: () => void }} [kh]
 * @property {any} [ctx] 挂到这个对象上（账号下拉的共享上下文）；缺省新建
 * @property {'term'|'at'} [attr] 选项 / ^C 的属性名：data-<attr>-pick、data-<attr>-cc（缺省 term）
 * @property {readonly string[]} [secretModes] 缺省 SECRET_MODES
 * @property {boolean} [history] 命令行 ↑↓ 历史（缺省 true；终端统一 T4 起有草稿，同站内终端）
 * @property {string} [histKey] 历史落 sessionStorage 的键（tty3 sgx-term-hist-3、tty5 sgx-term-hist-5）；缺省只在内存（锁屏 tty1）
 * @property {(line: string) => {line: string, options: string[]}} [complete] 命令行 Tab 补全（终端统一 T4）
 * @property {boolean} [ctrlL] Ctrl+L 清屏（缺省 true）
 * @property {boolean} [inputmode] 写 inputmode 属性（缺省 true）
 * @property {(m: string, secret: boolean) => string} [aria] 输入框读屏名（缺省：秘密 common.secretAria、命名 keys.nameAria、其余 ariaCmd / common.termAria）
 * @property {string} [pmDefault] 秘密输入时隐藏用户名的值（x.pm 优先）
 * @property {() => boolean} [ccCmd] 命令行也显示触屏 ^C（账号 reset 层）
 * @property {'ps'|'plain'} [ccEcho] 秘密 / 选择时 ^C 的回显：「提示符 ^C」（缺省）还是只有「^C」
 * @property {(m: string) => ''|'span'|'plain'} [echoSecret] 秘密提交后回显提示符的写法（缺省：秘密模式带 span）
 * @property {RegExp} [secretBack] 秘密输入时敲这个 = ^C（账号：cd .. / cd /）
 * @property {boolean} [pknameEmptyToCmd] 命名时空回车直接回命令行（账号）
 * @property {(key: string, raw: string) => void} [pickMiss] 选项里没有的输入；缺省说一声、接着选
 * @property {'term'|'at'} [ctrlC] Ctrl+C 没被吃掉时：term = 回显「输入 ^C」并清空（缺省）；at = 打一行 ^C
 * @property {boolean} [pickFocus] pick() 后聚焦输入行（缺省 true）
 * @property {boolean} [pickClickRefocus] 点选项后回命令行时把焦点还给输入行（缺省 true）
 * @property {string} [focusZone] 点这里的空白处聚焦输入行（缺省 '[data-term-log], form'）
 * @property {boolean} [focusForce] 点空白处时强制聚焦（触屏也弹键盘；缺省 true）
 */

/**
 * @param {InputLineOpts} o
 */
export function createInputLine(o) {
  const d = o.dom;
  const p = o.p;
  const t = o.t;
  const input = d.input;
  const form = d.form;
  const doc = input.ownerDocument || document;
  const isShown = o.isShown || function () { return true; };
  const attr = o.attr || 'term';
  const PICK = 'data-' + attr + '-pick';
  const CC = 'data-' + attr + '-cc';
  const secretModes = o.secretModes || SECRET_MODES;
  const useHist = o.history !== false;
  const hist = createHistory({ storage: o.histKey ? safeSession() : null, key: o.histKey || '' });
  /** pick 模式的选项 { key → fn } */ let picks = /** @type {Record<string, () => void>} */ ({});
  let pickDefault = '';

  /** @type {any} */
  const C = o.ctx || {};
  C.t = t; C.esc = esc; C.input = input; C.p = p;
  /** @type {string} cmd · pick · pw · rkey · newpw · newpw2 · pkname · busy · done */
  if (C.mode == null) C.mode = 'cmd';
  /** 当前一轮的输错次数 */ if (C.tries == null) C.tries = 0;
  /** 秘密输入 / 命名的提交函数 */ if (C.onSecret === undefined) C.onSecret = null;
  /** ^C 时额外做的事 */ if (C.onCancel === undefined) C.onCancel = null;
  /** 等待中（busy）也能 ^C 的那件事（通行密钥）：^C 时调它 */ if (C.busyCancel === undefined) C.busyCancel = null;
  /** 进 busy 时输入行有焦点：回命令行要把焦点还回来 */ if (C.refocus == null) C.refocus = false;
  const live = function (/** @type {string} */ s) { if (s) d.live.textContent = s; };
  /**
   * 给密码管理器的隐藏用户名（S9，Gray 三星实机：Samsung Internet + 三星键盘在空命令行、[y/N] 都弹「账号和密码」）：
   * 只在秘密输入时插进表单（同一表单里有「用户名」字段，三星就把整张表单当登录表单、任何文本框都给填充建议），离开秘密输入就拿掉。
   * @type {HTMLInputElement|null}
   */
  let pmu = null;
  /** @param {boolean} on @param {string} v */
  function paintPmu(on, v) {
    if (!on) { if (pmu) { pmu.remove(); pmu = null; } return; }
    if (!pmu) {
      pmu = doc.createElement('input');
      pmu.type = 'text';
      pmu.className = 'sgx-at-pmu';
      pmu.setAttribute('data-' + attr + '-pmu', '');
      pmu.setAttribute('autocomplete', 'username');
      pmu.setAttribute('tabindex', '-1');
      pmu.setAttribute('aria-hidden', 'true');
      pmu.readOnly = true;
      form.insertBefore(pmu, form.firstChild);
    }
    pmu.value = v;
  }

  /* ---------- 按键提示行（Gray 2026-11-09 细节 1） ---------- */
  const khOpt = o.kh;
  const kh = d.kh && khOpt ? mountKeyHint(d.kh, { onBack: khOpt.onBack }) : null;
  /** 按当前模式重画提示行（宿主换层后也调一次） */
  C.paintKh = function () {
    if (!kh || !khOpt) return;
    const key = khKeyFor(C.mode, khOpt.cmdKey(), !!C.busyCancel);
    kh.set(key, C.mode === 'cmd' ? khOpt.canBackCmd() : !!key);
  };

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
      return '<button type="button" class="' + p + '-o' + (it[2] ? ' is-on' : '') + '" ' + PICK + '="' + esc(it[0]) + '"><b translate="no">[' + esc(it[0]) + ']</b> ' + esc(it[1]) + '</button>';
    }).join(''), 'opts');
  };
  C.clearLog = function () { d.log.textContent = ''; };

  /* ---------- 输入行 ---------- */
  const isSecret = function (/** @type {string} */ m) { return secretModes.indexOf(m) !== -1; };
  const aria = o.aria || function (/** @type {string} */ m, /** @type {boolean} */ secret) {
    return secret ? t('common.secretAria') : m === 'pkname' ? t('keys.nameAria') : o.ariaCmd || t('common.termAria');
  };
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
    paintPmu(secret, (x && x.pm) || o.pmDefault || '');
    /* 选择的键盘按选项定：全是数字才弹数字键盘，[y/N] 等字母选项用文字键盘（同上：数字键盘打不出 y，只能回车 = 默认 N） */
    if (o.inputmode !== false) input.setAttribute('inputmode', (x && x.inputmode) || (m === 'pick' ? pickInputMode(Object.keys(picks)) : 'text'));
    input.setAttribute('aria-label', (x && x.aria) || aria(m, secret));
    d.ps.textContent = (x && x.ps) || (m === 'pick' || m === 'pkname' ? '>' : o.ps());
    const hidden = m === 'busy' || m === 'done';
    form.hidden = hidden;
    input.disabled = hidden;
    const cc = secret || m === 'pick' || m === 'pkname' || (m === 'cmd' && !!o.ccCmd && o.ccCmd()) || !!(x && x.cc);
    if ((x && x.hint) || cc) {
      d.hint.innerHTML = (x && x.hint ? '# ' + esc(x.hint) : '') +
        (cc ? '<span class="' + p + '-cc">' + (x && x.hint ? ' · ' : '# ') + '<button type="button" ' + CC + ' translate="no" aria-label="' + esc(t('common.interruptAria')) + '">^C</button></span>' : '');
      d.hint.classList.toggle(p + '-hint--cc', cc && !(x && x.hint));
      d.hint.hidden = false;
    } else d.hint.hidden = true;
    if (o.onMode) o.onMode(m);
    C.paintKh();
    /* busyCancel 常在 setMode('busy') 之后才挂上：下一拍再画一次 */
    if (m === 'busy') Promise.resolve().then(C.paintKh);
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
    if (o.pickFocus !== false) C.focusIn();
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
    C.out(o.ccEcho === 'plain' ? '^C' : (d.ps.textContent || '') + ' ^C', 'd');
    const c = C.onCancel;
    C.toCmd();
    if (c) c();
    return true;
  };
  /** 输入行只读（冷却倒计时） @param {boolean} b */
  C.readOnly = function (b) { input.readOnly = b; };

  /* ---------- 事件 ---------- */
  const echoSecret = o.echoSecret || function (/** @type {string} */ m) { return m === 'pkname' ? '' : 'span'; };
  const pickMiss = o.pickMiss || function (/** @type {string} */ key) {
    /* 选项里没有的：说一声、接着选（不算次数） */
    if (key) { C.echoPick(key); C.err(t('common.noOption')); }
  };
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
      const key = String(v || '').trim().replace(/\s+/g, ' ').toLowerCase() || pickDefault;
      const fn = picks[key] || picks[key.replace(/^\[|\]$/g, '')];
      input.value = '';
      if (fn) { picks = {}; fn(); return; }
      pickMiss(key, v);
      return;
    }
    if (isSecret(m) || m === 'pkname') {
      if (m !== 'pkname' && o.secretBack && o.secretBack.test(v)) { C.interrupt(); return; }
      if (m === 'pkname' && o.pknameEmptyToCmd && !v.trim()) { C.toCmd(); return; }
      if (m !== 'pkname' && !v) return;
      const fn = C.onSecret;
      input.value = '';
      const how = echoSecret(m);
      if (how === 'span') C.out('<span class="' + p + '-p">' + esc(d.ps.textContent || '') + '</span>', 'echo');
      else if (how === 'plain') C.out(esc(d.ps.textContent || ''), 'echo');
      if (fn) fn(v);
      return;
    }
    input.value = '';
    /* 只有命令行的输入进历史（秘密 / 选择 / 命名都在上面返回了） */
    if (useHist) hist.push(v.replace(/\s+/g, ' '));
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
    /* Tab 补全（终端统一 T4）：空行照常移焦点（不把键盘用户困在输入框里）；多个候选且补不动时列出来 */
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && o.complete && C.mode === 'cmd' && input.value.trim()) {
      e.preventDefault();
      const c = o.complete(input.value);
      if (c.options.length > 1 && c.line === input.value) {
        C.echo(input.value);
        C.out(c.options.map(function (k) { return C.k(k); }).join('  '));
      }
      input.value = c.line;
      return;
    }
    if (o.ctrlC === 'at') {
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        let sel = '';
        try { sel = String(doc.getSelection() || ''); } catch (err) {}
        if (sel && input.selectionStart !== input.selectionEnd) return;
        e.preventDefault();
        if (!C.interrupt()) C.out('^C', 'd');
      }
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (C.mode === 'cmd' && input.selectionStart !== input.selectionEnd) return;
      e.preventDefault();
      if (!C.interrupt()) {
        C.echo((input.value || '') + '^C');
        input.value = '';
      }
      return;
    }
    if (o.ctrlL !== false && e.ctrlKey && (e.key === 'l' || e.key === 'L') && C.mode === 'cmd') { e.preventDefault(); C.clearLog(); return; }
    if (C.mode === 'pick' && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1 && !input.value && picks[e.key.toLowerCase()]) {
      e.preventDefault();
      const fn = picks[e.key.toLowerCase()];
      picks = {};
      fn();
      return;
    }
    if (C.mode !== 'cmd' || !useHist) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const h = e.key === 'ArrowUp' ? hist.prev(input.value) : hist.next();
      if (h === null) return;
      e.preventDefault();
      input.value = h;
      try { input.setSelectionRange(h.length, h.length); } catch (err) {}
    }
  });
  /* 选择时高亮跟着输入框里的字走（手机输入法的数字进了输入框、不走上面的单键直选；Gray 2026-11-09 截图：打了 2 还亮着 [1]） */
  input.addEventListener('input', function () {
    if (C.mode === 'pick') paintPick(d.log, PICK, input.value, Object.keys(picks), pickDefault);
  });
  /* 手机输入法（三星键盘、Gboard 联想）在命令行按 enter 时 keydown 常带 isComposing，上面不提交、浏览器也不隐式提交：keyup 补一次 */
  input.addEventListener('keyup', function (e) {
    if (e.key !== 'Enter' || enterAt < 0) return;
    const at = enterAt;
    enterAt = -1;
    if (e.isComposing || at !== subN || C.mode === 'busy') return;
    submit();
  });
  const focusZone = o.focusZone || '[data-term-log], form';
  d.root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    if (!tg || !tg.closest) return;
    if (tg.closest('[' + CC + ']')) { e.preventDefault(); C.refocus = true; if (!C.interrupt()) C.toCmd(); return; }
    const pk = /** @type {HTMLElement|null} */ (tg.closest('[' + PICK + ']'));
    if (pk) {
      const key = pk.getAttribute(PICK) || '';
      const fn = C.mode === 'pick' && picks[key];
      if (fn) { picks = {}; if (o.pickClickRefocus !== false) C.refocus = true; fn(); }
      return;
    }
    if (tg.closest(focusZone) && !tg.closest('button, a, input')) C.focusIn(o.focusForce !== false);
  });

  C.paintKh();
  return C;
}

/** @returns {Storage|null} */
function safeSession() {
  try { return window.sessionStorage; } catch (e) { return null; }
}
