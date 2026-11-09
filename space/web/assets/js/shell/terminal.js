/**
 * @fileoverview 站内终端（2026-11 UI 重设计 PR-2，设计稿 term-v1 / tb4.html）：一个模块，四站共用。
 *
 * - 引擎 createShell()：提示符按账号登录状态（环境提示符规则：没登录 styrigx@space:~$、已登录 root@account:~#；cd 之后 ~/blog$ / ~/blog#）、历史（↑ / ↓，sessionStorage 跨页保留）、tab 补全、clear；
 *   命令 help · cd · ls · cat · sudo · theme · lock · ask · clear，真正的动作（滚动 / 跳转 / 开面板 / 锁屏 / 问 AI）由调用方经 act 传进来。
 * - 解析 / 补全 parse()、complete()、normDir() 是纯函数（单测 tests/space/ui/shell/terminal.test.mjs）。
 * - 视图 mountTermView()：把一个终端窗口标记（[data-sgx-term]：标题栏 + 输出区 + 一行真 <input>）接到引擎上。
 *   主页首屏嵌入的那一个（layouts/index.html，data-sgx-term="home"）和全站抽屉（共享外壳 shell-topbar.html 的 #sgx-term）用同一个引擎实例。
 * - 文案：#sgx-i18n-shell 的 term 节（data/sgx-shell-i18n/<语言>.yaml，缺键回退下面的英文）。
 *
 * 共享外壳组件：只许 import shell/term/**（终端统一 T1，gen-shell 核对）；输出只用 textContent 拼，不写 innerHTML。
 * 终端统一 T3：引擎、注册表、补全、历史、提示符在 shell/term/core/，命令在 shell/term/cmds/（tty2 表 index-tty2.js）；这里是 tty2 的宿主 + 视图，原有导出照旧。
 */
import { ROOT_COMMAND, ADMIN_COMMAND, ENV_GUEST, ENV_ROOT, parse } from './term/core/parse.js';
import { KH_EN, shellSection } from './term/core/strings.js';
import { createRegistry } from './term/core/registry.js';
import { completeLine, ghostOf } from './term/core/complete.js';
import { createHistory } from './term/core/history.js';
import { cwdPath, envPs1, envTitle } from './term/core/prompt.js';
import { fill, outKit } from './term/core/out.js';
import { createEngine } from './term/core/engine.js';
import { DIRS, normDir } from './term/cmds/fs/tree.js';
import { TTY2_CMDS } from './term/cmds/index-tty2.js';

/** 目录（ls 的结果，cd 的目标；wild = 旷野）：shell/term/cmds/fs/tree.js */
export { DIRS, normDir, cwdPath, fill, parse };
/** 环境提示符（shell/term/core/parse.js，和 shell/space/commands.js 同一份）：账号没登录 / 已登录 */
export { ENV_GUEST, ENV_ROOT };

/**
 * 账号登录了没有：读 <html data-sgx-account-session="in|out">（首帧由 layout-mode.js __sgxAccountPs 按登录标记写好，账号终端登录 / 退出时改）。
 * @param {Document} [doc] @returns {boolean}
 */
export function accountSignedIn(doc) {
  try {
    const d = doc || document;
    return d.documentElement.getAttribute('data-sgx-account-session') === 'in';
  } catch (e) { return false; }
}
/** tty2 的命令表 */
const REG = createRegistry(TTY2_CMDS);
/** 命令（help 的顺序 = 补全的顺序） */
export const COMMANDS = REG.names('tty2');
/** 各命令参数的候选 */
export const ARGS = /** @type {Record<string, string[]>} */ ({});
REG.list('tty2').forEach(function (c) { if (c.args) ARGS[c.name] = c.args; });
const HIST_KEY = 'sgx-term-hist';

/** 英文底（源文本）；页面上以 #sgx-i18n-shell 的 term 节为准 */
export const TERM_EN = {
  welcome: 'space os 1.0 — type {help} to see all commands, {cd} to jump there',
  hint: 'tab complete · ↑ history · Ctrl K anywhere',
  hintShort: 'Ctrl K anywhere',
  input: 'Terminal command',
  output: 'Terminal output',
  drawer: 'Terminal',
  open: 'terminal',
  dLs: 'list directories',
  dCat: 'daymark/today',
  dAccount: 'sign in',
  dSecurity: 'site security',
  dTheme: 'dark · light · auto',
  dLock: 'lock now',
  dAsk: 'ask Gray AI',
  dClear: 'clear screen',
  notFound: 'command not found: {x} · try help',
  didYouMean: 'command not found: {c} — did you mean {x}?',
  noDir: '{c}: no such directory: {x}',
  noFile: 'cat: {x}: no such file',
  lsEmpty: 'nothing to list here · try cd ..',
  scrolled: 'scrolled to {x}',
  opening: 'opening {x} …',
  todayNone: 'no line for today yet · {x}',
  todayFail: 'couldn’t load today’s line · {x}',
  usageSudo: 'usage: sudo ' + ROOT_COMMAND + ' [reauth|reset] | sudo ' + ADMIN_COMMAND,
  usageTheme: 'usage: theme [dark | light | auto]',
  usageCat: 'usage: cat daymark/today',
  themeSet: 'theme → {x}',
  themeOpen: 'appearance panel opened',
  locking: 'locking …',
  asking: 'asking Gray AI …',
  fetching: 'fetching {x}…',
  manIndex: 'manual pages · man <command> to read one',
  manNone: 'No manual entry for {x}',
  manPager: 'q or enter to quit',
  notDir: '{c}: not a directory: {x}',
  usageTty: 'usage: tty [2 | 3 | 4 | 5]',
};

/**
 * 页面字符串表的 term 节叠在英文上
 * @param {Document} [doc] @returns {Record<string, string>}
 */
export function termStrings(doc) {
  return Object.assign({}, TERM_EN, shellSection(doc, 'term'));
}

/** 打错命令时拿来比的真命令（命令名 + 几个常用的整句） */
const SUGGEST = COMMANDS.concat(['cd blog', 'cd curio', 'cd daymark', 'cd wild', 'sudo ' + ROOT_COMMAND, 'sudo ' + ADMIN_COMMAND, 'cat daymark/today']);
/**
 * 页面字符串表的 kh 节叠在英文上（英文底 = shell/term/core/strings.js KH_EN）
 * @param {Document} [doc] @returns {Record<string, string>}
 */
function khStrings(doc) {
  return Object.assign({}, KH_EN, shellSection(doc, 'kh'));
}

/**
 * tab 补全：只补最后一个词（第一个词补命令名，第二个词按命令补参数）。
 * @param {string} line @returns {{line: string, options: string[]}}
 */
export function complete(line) {
  return completeLine(line, {
    names: COMMANDS,
    argsOf: function (c) { return ARGS[c] || []; },
    takesArgs: function (c) { const x = REG.get(c, 'tty2'); return !!x && (!!x.args || !!x.takesArgs); },
  });
}

/**
 * 补全的「影子」：只有唯一候选时，返回还没打的那一截（输入框后面淡色显示，→ 接受）
 * @param {string} line @returns {string}
 */
export function ghost(line) {
  return ghostOf(line, complete);
}

/**
 * @typedef {Array<[string, string, string?]>} Seg 一行：[类, 文字, 链接?]
 * @typedef {{ t: 'line', seg: Seg, cls?: string } | { t: 'help', head: Seg, rows: Array<[string, string]> }} Out
 * @typedef {{ out: Out[], clear?: boolean, after?: () => void, pager?: boolean }} Result  pager = 显示完进 pager（man；提示符 `:`，q / enter 回命令行）
 * @typedef {Object} TermAct
 * @property {(dir: string) => ({ kind: 'scroll', label: string } | { kind: 'nav', href: string, go: () => void })} cd  open 的站点目录：主页滚到那一节、别页去那个站（T6b 起 cd 命令不再调它）
 * @property {(which: string, sub?: string) => ({ href: string, go: () => void })} sudo  which = ROOT_COMMAND（账号终端，sub = '' | reauth | reset）| ADMIN_COMMAND（盾牌）
 * @property {(mode: string) => void} theme  '' = 打开外观面板；dark / light / auto = 设定
 * @property {() => void} lock
 * @property {(q: string) => void} ask
 * @property {() => Promise<{ text: string, by: string } | null>} today
 * @property {() => string} daymarkHref
 * @property {(layer: string) => ({ href: string, go: () => void })} [account]  open ~/account[/层]（T6）
 * @property {(layer: string) => ({ href: string, go: () => void })} [shield]  open ~/shield[/层]（T6）
 * @property {(n: number) => ({ go: () => void })} [tty]  tty 3 / 4 / 5（T6）
 */

/**
 * @param {{ str?: Record<string, string>, act: TermAct, cwd?: string, storage?: Storage | null, signedIn?: () => boolean }} o
 */
export function createShell(o) {
  const S = Object.assign({}, TERM_EN, o.str || {});
  const act = o.act;
  const signedIn = o.signedIn || function () { return accountSignedIn(); };
  let cwd = o.cwd && DIRS.indexOf(o.cwd) >= 0 ? o.cwd : '~';
  const hist = createHistory({ storage: o.storage === undefined ? safeSession() : o.storage, key: HIST_KEY });
  /** @type {Array<() => void>} */
  const subs = [];
  function emit() {
    subs.forEach(function (f) { try { f(); } catch (e) {} });
  }

  function helpOut() {
    /** @type {Out} */
    const h = {
      t: 'help',
      head: [['k', 'cd'], ['', ' blog · curio · daymark · wild · ~']],
      rows: [],
    };
    REG.list('tty2').forEach(function (c) { if (c.help) h.rows = h.rows.concat(c.help(x)); });
    return h;
  }
  /** 命令拿到的上下文 */
  const x = {
    S: S,
    act: act,
    k: outKit(S),
    help: helpOut,
    cwd: function () { return cwd; },
    /** @param {string} d */
    setCwd: function (d) { cwd = d; emit(); },
    /** 这个 tty 的命令名（man 索引） */
    names: function () { return COMMANDS; },
    /** 名字或别名 → 命令名（不认识 → ''） @param {string} n */
    resolve: function (n) { const c = REG.get(n, 'tty2'); return c ? c.name : ''; },
  };
  const engine = createEngine({
    registry: REG,
    tty: 'tty2',
    x: x,
    suggestions: SUGGEST,
    empty: function () { return { out: [] }; },
    /* 打错了：给最近的真命令（Gray 2026-11-09；输出区 aria-live，读屏照念）；不像任何命令就照旧 */
    notFound: function (p, sg) {
      if (sg) return { out: [{ t: 'line', seg: fill(S.didYouMean, { c: ['', p.cmd], x: ['k', sg] }), cls: 'err' }] };
      return { out: [x.k.tpl('notFound', p.cmd, 'err')] };
    },
  });

  /**
   * 执行一行。返回输出（today 是异步的，返回 Promise）
   * @param {string} line @returns {Result | Promise<Result>}
   */
  function exec(line) {
    hist.push(line);
    return engine.exec(line);
  }

  return {
    str: S,
    exec: exec,
    help: helpOut,
    /** 提示符（环境提示符规则）：styrigx@space:~$ / styrigx@space:~/blog$；账号已登录 root@account:~# / root@account:~/blog# */
    ps1: function () { return envPs1(signedIn(), cwd); },
    /** 标题栏：styrigx@space: ~ / root@account: ~ */
    title: function () { return envTitle(signedIn(), cwd); },
    cwd: function () { return cwd; },
    /** @param {() => void} f */
    onChange: function (f) { subs.push(f); },
    /** ↑：上一条（第一次按先存下正在打的草稿） @param {string} cur */
    prev: function (cur) { return hist.prev(cur); },
    /** ↓：下一条；到底回到草稿 */
    next: function () { return hist.next(); },
    history: function () { return hist.list(); },
  };
}

/** @returns {Storage|null} */
function safeSession() {
  try { return window.sessionStorage; } catch (e) { return null; }
}

/** 减弱动效 */
function reduced() {
  try {
    return document.documentElement.classList.contains('reduced-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { return false; }
}
export { reduced as reducedMotion };

/**
 * 把一个终端窗口标记接到引擎上。标记（主页 layouts/index.html、抽屉 shell-topbar.html 同一套类名）：
 *   [data-sgx-term] > .sgx-term-bar [data-term-title] … ；.sgx-term-body [data-term-body] > [data-term-out]（aria-live）+ form[data-term-form]
 *   > label[data-term-ps] + .sgx-term-field > input[data-term-in] + [data-term-ghost]
 * @param {Element} root
 * @param {ReturnType<typeof createShell>} sh
 * @param {{ autoHelp?: boolean, kh?: string, onBack?: () => void }} [opts] kh = 按键提示行那一句的键（#sgx-i18n-shell kh 节）；onBack = 触屏「‹ 返回」
 */
export function mountTermView(root, sh, opts) {
  const doc = root.ownerDocument || document;
  const out = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-out]'));
  const body = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-body]'));
  const form = /** @type {HTMLFormElement|null} */ (root.querySelector('[data-term-form]'));
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-term-in]'));
  const ps = root.querySelector('[data-term-ps]');
  const titleEl = root.querySelector('[data-term-title]');
  const gh = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-ghost]'));
  if (!out || !form || !input) return null;
  const inp = input;
  const outEl = out;

  /** man 显示完进 pager：提示符 `:`，q / enter 回命令行（终端统一 T5） */
  let pager = false;
  function paintPrompt() {
    if (ps) ps.textContent = pager ? ':' : sh.ps1();
    if (titleEl) titleEl.textContent = sh.title();
  }
  /* 账号登录 / 退出（账号终端改 <html data-sgx-account-session>）：提示符跟着换（环境提示符规则） */
  try {
    if (typeof MutationObserver === 'function') {
      new MutationObserver(paintPrompt).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-sgx-account-session'] });
    }
  } catch (e) {}
  function paintGhost() {
    if (!gh) return;
    const g = inp.selectionStart === inp.value.length ? ghost(inp.value) : '';
    gh.textContent = g;
    gh.style.left = inp.value.length + 'ch';
    gh.hidden = !g;
  }
  function scrollEnd() {
    const sc = body || outEl;
    sc.scrollTop = sc.scrollHeight;
  }
  /** @param {[string, string, string?]} s */
  function segEl(s) {
    if (s[0] === 'a' && s[2]) {
      const a = doc.createElement('a');
      a.className = 'sgx-term-a';
      a.href = s[2];
      a.textContent = s[1];
      return a;
    }
    if (!s[0]) return doc.createTextNode(s[1]);
    const sp = doc.createElement('span');
    sp.className = 'sgx-term-' + s[0];
    sp.textContent = s[1];
    return sp;
  }
  /** @param {Out} o */
  function outEl1(o) {
    const div = doc.createElement('div');
    if (o.t === 'help') {
      div.className = 'sgx-term-help';
      const head = doc.createElement('div');
      head.className = 'sgx-term-hh';
      o.head.forEach(function (s) { head.appendChild(segEl(s)); });
      div.appendChild(head);
      o.rows.forEach(function (r) {
        const cell = doc.createElement('div');
        const k = doc.createElement('span');
        k.className = 'sgx-term-k';
        k.textContent = r[0];
        const d = doc.createElement('span');
        d.className = 'sgx-term-dsc';
        d.textContent = ' ' + r[1];
        cell.appendChild(k);
        cell.appendChild(d);
        div.appendChild(cell);
      });
      return div;
    }
    div.className = 'sgx-term-ln' + (o.cls ? ' sgx-term-' + o.cls : '');
    o.seg.forEach(function (s) { div.appendChild(segEl(s)); });
    return div;
  }
  /** 回显一行命令 @param {string} pr @param {string} line */
  function echo(pr, line) {
    const div = doc.createElement('div');
    div.className = 'sgx-term-ln sgx-term-cmd';
    const p = doc.createElement('span');
    p.className = 'sgx-term-pp';
    p.textContent = pr;
    div.appendChild(p);
    div.appendChild(doc.createTextNode(' ' + line));
    outEl.appendChild(div);
  }
  /** @param {Out[]} list */
  function print(list) {
    list.forEach(function (o) { outEl.appendChild(outEl1(o)); });
    scrollEnd();
  }
  /** @param {Result} r */
  function finish(r) {
    if (r.clear) outEl.textContent = '';
    print(r.out || []);
    pager = !!r.pager;
    if (pager) print([{ t: 'line', seg: [['', '# ' + String(sh.str.manPager || TERM_EN.manPager)]], cls: 'o' }]);
    paintPrompt();
    if (r.after) r.after();
  }
  /** @param {boolean} on */
  function busyEv(on) { try { document.dispatchEvent(new CustomEvent('sgx-busy', { detail: on })); } catch (e) {} }
  /** @param {string} line */
  function run(line) {
    const pr = sh.ps1();
    echo(pr, line);
    const r = sh.exec(line);
    if (r && typeof (/** @type {any} */ (r)).then === 'function') {
      /* 异步命令（cat daymark/today）：先打一行输出式的等待提示，不留空白（输出区是 aria-live，读屏照念） */
      const pend = /** @type {any} */ (r).pending;
      if (pend) print([{ t: 'line', seg: [['', '› ' + String(sh.str.fetching || TERM_EN.fetching).split('{x}').join(pend)]], cls: 'o' }]);
      inp.disabled = true;
      /* 等待期间顶栏头像外圈的弧转快一档（topbar-panel.js mountAvBusy；这个文件不 import，只发事件） */
      busyEv(true);
      /** @type {Promise<Result>} */ (r).then(function (x) {
        busyEv(false);
        inp.disabled = false;
        finish(x);
        try { inp.focus({ preventScroll: true }); } catch (e) {}
      });
    } else finish(/** @type {Result} */ (r));
  }

  function quitPager() {
    pager = false;
    inp.value = '';
    paintGhost();
    paintPrompt();
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (pager) { quitPager(); return; }
    const v = inp.value;
    inp.value = '';
    paintGhost();
    run(v);
  });
  inp.addEventListener('input', paintGhost);
  inp.addEventListener('keyup', paintGhost);
  inp.addEventListener('click', paintGhost);
  inp.addEventListener('keydown', function (e) {
    if (e.isComposing) return;
    if (pager && (e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); quitPager(); return; }
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      /* 空行时 Tab 照常移焦点（不把键盘用户困在输入框里）；有字时才补全 */
      if (!inp.value.trim()) return;
      e.preventDefault();
      const c = complete(inp.value);
      if (c.options.length > 1 && c.line === inp.value) {
        echo(sh.ps1(), inp.value);
        print([{ t: 'line', seg: c.options.map(function (x) { return /** @type {[string, string]} */ (['k', x + '  ']); }), cls: '' }]);
      }
      inp.value = c.line;
      paintGhost();
      return;
    }
    if (e.key === 'ArrowRight' && gh && !gh.hidden && inp.selectionStart === inp.value.length) {
      e.preventDefault();
      inp.value = inp.value + gh.textContent;
      paintGhost();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const v = e.key === 'ArrowUp' ? sh.prev(inp.value) : sh.next();
      if (v === null) return;
      e.preventDefault();
      inp.value = v;
      try { inp.setSelectionRange(v.length, v.length); } catch (err) {}
      paintGhost();
      return;
    }
    if ((e.key === 'l' || e.key === 'L') && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      outEl.textContent = '';
      return;
    }
    if ((e.key === 'c' || e.key === 'C') && e.ctrlKey && !e.metaKey && !e.altKey && inp.selectionStart === inp.selectionEnd) {
      e.preventDefault();
      echo(sh.ps1(), inp.value + '^C');
      inp.value = '';
      paintGhost();
    }
  });
  /* 点终端空白处 = 聚焦输入框（选中文字时不抢） */
  root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    if (tg && tg.closest('a, button, input')) return;
    const sel = doc.getSelection && doc.getSelection();
    if (sel && String(sel).length) return;
    try { inp.focus({ preventScroll: true }); } catch (err) {}
  });
  sh.onChange(paintPrompt);
  paintPrompt();
  /* 按键提示行（Gray 2026-11-09 细节 1；同 shell/keyhint.js，这个文件不 import，内联几行）：[data-term-kh] 在窗口最底。
     桌面显示 opts.kh 那一句（主页 cmdHome / 抽屉 cmdDrawer）；触屏有 opts.onBack 时换成「‹ 返回」按钮（抽屉 = 关掉），没有就整行不显示 */
  const khEl = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-kh]'));
  if (khEl && opts && opts.kh) {
    const KS = khStrings(doc);
    let fine = true;
    try { fine = window.matchMedia('(pointer: fine)').matches; } catch (e) {}
    khEl.textContent = '';
    if (!fine) {
      const back = opts.onBack;
      if (back) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'sgx-kh-b';
        b.setAttribute('data-kh-back', '');
        b.setAttribute('aria-label', KS.backAria || 'Back');
        b.textContent = KS.back || '‹ back';
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); back(); });
        khEl.appendChild(b);
      }
      khEl.hidden = !back;
    } else {
      const k = doc.createElement('span');
      k.className = 'sgx-kh-k';
      k.setAttribute('aria-hidden', 'true');
      k.setAttribute('translate', 'no');
      k.textContent = KS[opts.kh] || '';
      khEl.appendChild(k);
      khEl.hidden = !k.textContent;
    }
  }
  if (opts && opts.autoHelp) {
    echo(sh.ps1(), 'help');
    print([sh.help()]);
    outEl.scrollTop = 0;
    if (body) body.scrollTop = 0;
  }
  return {
    input: inp,
    run: run,
    /** @param {{ scroll?: boolean }} [o2] */
    focus: function (o2) {
      if (o2 && o2.scroll) {
        try { root.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }); } catch (e) {}
      }
      try { inp.focus({ preventScroll: true }); } catch (e) {}
    },
  };
}
