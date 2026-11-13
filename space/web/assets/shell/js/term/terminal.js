/**
 * @fileoverview 终端（v5 S5 终端合一，term-design-v5）：原锁屏 tty1、主页 tty2、盾牌 tty3、账号 tty5 合成一个终端——一个会话、一份历史、一张命令表。
 * AI 窗口（tty4）不动：它里面以 $ 开头的输入照旧走这里的 createShell（自己的历史 sgx-term-hist-4）。
 *
 * - 引擎 createShell()：命令表（term/cmds/index.js）、提示符（身份 term/core/who.js：访客 nobody / v6 用户 / v6 root，服务端说了算）、
 *   历史（↑↓，sessionStorage sgx-term-hist，全站一份）、Tab 补全、cd 的当前目录。真正的动作（跳页 / 外观 / AI / 打开账号窗口）由调用方经 act 传进来。
 * - 视图 mountTerminal()：把一个终端窗口标记（[data-sgx-term]）接到引擎上。输入行用 term/view/input-line.js（秘密输入 / 选择 / 等待 / ^C 都在那里），
 *   要输入、选择、验证的命令（su、sudo、exit、lock、账号命令、sub）交给调用方给的两层上下文去跑（layers：v6 身份层 identity/layer.js、
 *   账号层 account/cmd/layer.js），它们共用这一个输入行（term/view/layer-ctx.js）。账号窗口（头像，account/window.js）只展示（S9），点一行 = 打开这个终端、预填命令。
 * - man 的结果在终端窗口里的全屏阅读页显示（S9，term/view/pager.js，less 式），不进滚动区。
 * - 每次打开终端窗口都是干净的新会话（S9）：滚动区回到欢迎行、提示符重画、进行中的输入 / 选择取消、cwd 回到本页；history 照旧（sessionStorage）。
 *   桌面是居中大窗（#sgx-term 抽屉），手机整块卡片；四站只有这一个（v5 S7 起主页首屏是 neofetch，不再嵌终端）。
 * - 文案：#sgx-i18n-shell 的 term 节（data/shell/sgx-shell-i18n/<语言>.yaml，缺键回退下面的英文）。
 *
 * 共享外壳组件：只许 import term/**（终端统一 T1，gen-shell 核对）。
 */
import { parse } from './core/parse.js';
import { KH_EN, shellSection, flatStrings } from './core/strings.js';
import { createRegistry } from './core/registry.js';
import { completeLine, ghostOf } from './core/complete.js';
import { createHistory } from './core/history.js';
import { cwdPath, ps1, title, createWho } from './core/who.js';
import { fill, outKit } from './core/out.js';
import { createEngine } from './core/engine.js';
import { DIRS, normDir } from './cmds/fs/tree.js';
import { CMDS } from './cmds/index.js';
import { createInputLine } from './view/input-line.js';
import { createPager } from './view/pager.js';

export { DIRS, normDir, cwdPath, fill, parse, createWho, ps1 };

/** 命令表 */
const REG = createRegistry(CMDS);
/** 命令（man 索引的顺序 = 补全的顺序） */
export const COMMANDS = REG.names();
/** 各命令参数的候选 */
export const ARGS = /** @type {Record<string, string[]>} */ ({});
/* 取值时现读（theme 的参数 = 调色板 id，来自共享读端 SgxUI，命令表加载时它可能还没挂上） */
REG.list().forEach(function (c) { if (c.args) Object.defineProperty(ARGS, c.name, { enumerable: true, get: function () { return c.args; } }); });
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
  notFound: 'command not found: {x} · try man',
  didYouMean: 'command not found: {c} — did you mean {x}?',
  noDir: '{c}: no such directory: {x}',
  noFile: 'cat: {x}: no such file',
  lsEmpty: 'nothing to list here · try cd ..',
  scrolled: 'scrolled to {x}',
  opening: 'opening {x} …',
  todayNone: 'no line for today yet · {x}',
  todayFail: 'couldn’t load today’s line · {x}',
  usageSudo: 'usage: sudo useradd | userdel | usermod | passwd <name> | groups [name] | who',
  usageTheme: 'usage: theme [palette id] · press Tab for the list',
  usageCat: 'usage: cat daymark/today',
  usageLock: 'usage: lock',
  usagePasswd: 'usage: passwd',
  usagePasskey6: 'usage: passkey [ls | add | rm <n>]',
  usageDevice: 'usage: device [rm <n> | rm --all]',
  usageProfile: 'usage: profile [set name | nick | sign | email <value> | avatar]',
  usageSu: 'usage: su <user> | su root',
  usageGroups: 'usage: groups [user]',
  usageWho: 'usage: who',
  usageUseradd: 'usage: useradd <name> [-e YYYY-MM-DD] [-G group,group]',
  usageUserdel: 'usage: userdel <name>',
  usageUsermod: 'usage: usermod -aG | -rG <group[,group]> <name>',
  usageRescue: 'usage: rescue',
  themeSet: 'theme → {x}',
  themeOpen: 'appearance panel opened',
  asking: 'asking Gray AI …',
  fetching: 'fetching {x}…',
  manIndex: 'manual pages · man <command> to read one',
  manNone: 'No manual entry for {x}',
  manPager: 'q or esc to quit',
  notDir: '{c}: not a directory: {x}',
  usageFind: 'usage: find <keyword>',
  findNone: 'find: no matches for {x}',
  findDown: 'find: search is unavailable right now · try again later',
  findLimited: 'find: too many searches · try again in a minute',
  askLocked: 'AI is locked · run {s} first; use {f} to search by keyword',
  needRoot6: 'permission denied · run {x} first',
  needSu: 'not signed in · {x} first',
  suUser: '<user>',
  exitFirst: 'signed in as {u} · {x} first',
  notHere: '{x}: run it in the terminal (Ctrl K)',
};

/**
 * 页面字符串表的 term 节叠在英文上
 * @param {Document} [doc] @returns {Record<string, string>}
 */
export function termStrings(doc) {
  return Object.assign({}, TERM_EN, shellSection(doc, 'term'));
}

/** 打错命令时拿来比的真命令（命令名 + 几个常用的整句） */
const SUGGEST = COMMANDS.concat(['open blog', 'open curio', 'open daymark', 'cat daymark/today']);

/**
 * tab 补全：只补最后一个词（第一个词补命令名，第二个词按命令补参数）。
 * @param {string} line @param {string[]} [names] 第一个词的候选（缺省全部命令） @param {any} [w] 当前身份（命令按身份给参数候选：argsFor）
 * @returns {{line: string, options: string[]}}
 */
export function complete(line, names, w) {
  return completeLine(line, {
    names: names || COMMANDS,
    argsOf: function (c) { const x = REG.get(c); return x && typeof x.argsFor === 'function' ? x.argsFor(w) : (ARGS[c] || []); },
    takesArgs: function (c) { const x = REG.get(c); return !!x && (!!x.args || !!x.takesArgs); },
    subArgsOf: function (c, a) { const x = REG.get(c); return x && x.subArgs ? x.subArgs(a) : []; },
  });
}

/** 补全的「影子」：只有唯一候选时，返回还没打的那一截 @param {string} line */
export function ghost(line) {
  return ghostOf(line, function (l) { return complete(l); });
}

/**
 * @typedef {Array<[string, string, string?]>} Seg 一行：[类, 文字, 链接?]
 * @typedef {{ t: 'line', seg: Seg, cls?: string }} Out
 * @typedef {{ out: Out[], clear?: boolean, after?: () => void, pager?: string, flow?: boolean }} Result
 *   pager = 输出交给全屏阅读页（man；值是页名，比如 SUB(1)），不进滚动区；flow = 交给那一层去跑了（它自己打输出、换输入模式）
 * @typedef {Object} TermAct
 * @property {(dir: string) => ({ kind: 'scroll', label: string } | { kind: 'nav', href: string, go: () => void })} cd  open 的站点目录
 * @property {(mode: string) => void} theme  '' = 打开调色板面板；调色板 id = 切到那套
 * @property {(q: string) => void} ask
 * @property {(q: string) => Promise<any>} find  find <词>（v5 S4，GET /api/find）
 * @property {() => Promise<{ text: string, by: string } | null>} today
 * @property {() => string} daymarkHref
 * @property {() => ({ href: string, go: () => void })} [account]  open ~/account：打开账号卡片
 * @property {() => Promise<any[]|null>} [proxyList]  ls ~/proxy
 * @property {() => void} [close]  exit：关掉终端窗口
 */

/**
 * @param {{ str?: Record<string, string>, act: TermAct, cwd?: string, storage?: Storage | null, histKey?: string,
 *   who?: { get: () => import('./core/who.js').Who, on: (f: any) => void } }} o
 *   histKey 缺省 sgx-term-hist（AI 窗口里的 $ 命令是 sgx-term-hist-4）；who 缺省一直是 nobody（没有身份来源的地方）
 */
export function createShell(o) {
  const S = Object.assign({}, TERM_EN, o.str || {});
  const act = o.act;
  const who = o.who || { get: function () { return /** @type {any} */ ('nobody'); }, on: function () {} };
  const cwd0 = o.cwd && DIRS.indexOf(o.cwd) >= 0 ? o.cwd : '~';
  let cwd = cwd0;
  const hist = createHistory({ storage: o.storage === undefined ? safeSession() : o.storage, key: o.histKey || HIST_KEY });
  /** @type {Array<() => void>} */
  const subs = [];
  function emit() {
    subs.forEach(function (f) { try { f(); } catch (e) {} });
  }
  who.on(emit);

  /** whoami 的 user（组、webmaster 标记；没有 → null） */
  const meV6 = function () { return who && typeof who.v6 === 'function' ? who.v6() : null; };
  /** 命令拿到的上下文 */
  const x = {
    S: S,
    act: act,
    k: outKit(S),
    cwd: function () { return cwd; },
    /** @param {string} d */
    setCwd: function (d) { cwd = d; emit(); },
    /** 终端身份（core/who.js；每次现读） */
    who: function () { return who.get(); },
    /** whoami 的 user（组、webmaster 标记；访客 / 没问到 → null） */
    me: meV6,
    /** 这个身份在 man 索引里列出的命令名（registry listed；组与站长看 whoami 的 user） */
    names: function () { return REG.listed(who.get(), meV6()); },
    /** man 索引的分段（定稿 v5.5 §四：root → 站长 → 普通用户 → 访客；registry sections） */
    sections: function () { return REG.sections(who.get(), meV6()); },
    /** 名字或别名 → 命令名（不认识 → ''） @param {string} n */
    resolve: function (n) { const c = REG.get(n); return c ? c.name : ''; },
    history: function () { return hist.list(); },
    /** 这一次执行的两层上下文（视图给；AI 窗口没有） @type {any} */
    v: null,
  };
  const engine = createEngine({
    registry: REG,
    x: x,
    suggestions: SUGGEST,
    empty: function () { return { out: [] }; },
    /* 打错了：给最近的真命令（Gray 2026-11-09）；不像任何命令就照旧 */
    notFound: function (p, sg) {
      if (sg) return { out: [{ t: 'line', seg: fill(S.didYouMean, { c: ['', p.cmd], x: ['k', sg] }), cls: 'err' }] };
      return { out: [x.k.tpl('notFound', p.cmd, 'err')] };
    },
  });

  /**
   * 执行一行（记进历史）。返回输出（异步命令返回 Promise）
   * @param {string} line @param {{ space?: any, acct?: any }} [v] 两层上下文
   * @returns {Result | Promise<Result>}
   */
  function exec(line, v) {
    hist.push(line);
    x.v = v || null;
    return engine.exec(line);
  }

  return {
    str: S,
    exec: exec,
    /** 提示符：nobody@space:~$ · styrigx@space:~/blog$ · root@space:~# */
    ps1: function () { return ps1(who.get(), cwd); },
    /** 标题栏：nobody@space: ~ */
    title: function () { return title(who.get(), cwd); },
    who: function () { return who.get(); },
    cwd: function () { return cwd; },
    /** @param {() => void} f 提示符要重画（cd / 身份变了） */
    onChange: function (f) { subs.push(f); },
    /** ↑：上一条（第一次按先存下正在打的草稿） @param {string} cur */
    prev: function (cur) { return hist.prev(cur); },
    /** ↓：下一条；到底回到草稿 */
    next: function () { return hist.next(); },
    history: function () { return hist.list(); },
    /** 新会话：cwd 回到本页（历史照旧） */
    reset: function () { cwd = cwd0; emit(); },
    /** 这个身份的 Tab 补全（第一个词只补列出的命令） @param {string} line */
    complete: function (line) { return complete(line, REG.listed(who.get(), meV6()), who.get()); },
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

/** 秘密输入（不回显）的模式：密码、新密码两次、机场链接（恢复钥匙走 pw） */
const SECRET = ['pw', 'newpw', 'newpw2', 'suburl'];

/**
 * 把一个终端窗口标记接到引擎上。标记（抽屉 shell-topbar.html）：
 *   [data-sgx-term] > .sgx-term-bar [data-term-title] … ；.sgx-term-body [data-term-body] > [data-term-out] + form[data-term-form]
 *   > label[data-term-ps] + .sgx-term-field > input[data-term-in] + [data-term-ghost]；p[data-term-hint]；p[data-term-kh]
 *   （给密码管理器的隐藏用户名只在秘密输入时由 input-line 插进表单，S9）。阅读页（man）由 pager.js 插在正文后面。
 * @param {Element} root
 * @param {ReturnType<typeof createShell>} sh
 * @param {{ kh?: string, onBack?: () => void, isShown?: () => boolean, pmUser?: string,
 *   layers?: (line: any) => { acct?: any, ident?: any } }} [opts] kh = 命令行时按键提示行那一句（#sgx-i18n-shell kh 节）；onBack = 触屏「‹ 返回」/ 最外层 esc
 */
export function mountTerminal(root, sh, opts) {
  const o = opts || {};
  const doc = root.ownerDocument || document;
  const out = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-out]'));
  const body = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-body]'));
  const form = /** @type {HTMLFormElement|null} */ (root.querySelector('[data-term-form]'));
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-term-in]'));
  const psEl = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-ps]'));
  const hint = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-hint]'));
  const titleEl = root.querySelector('[data-term-title]');
  const gh = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-ghost]'));
  if (!out || !form || !input || !psEl || !hint) return null;
  const inp = input;
  const outEl = out;
  const SP = flatStrings(shellSection(doc, 'space'));
  /** 输入行自己要的几句（秘密输入 / 命名的读屏名、^C、没有这个选项）：外壳字符串表 space 节 @param {string} k */
  const t = function (k) { return SP[k] || ''; };

  /** @type {{ acct?: any, ident?: any }} */
  let R = {};
  /** 欢迎行（新会话回到它）：标记里首帧那几行 */
  const welcome = Array.prototype.map.call(outEl.childNodes, function (/** @type {Node} */ n) { return n.cloneNode(true); });
  /** 当前提示符：按身份 */
  function psNow() { return sh.ps1(); }
  /** @type {any} */
  let C = null;
  C = createInputLine({
    dom: {
      root: /** @type {HTMLElement} */ (root),
      log: outEl,
      form: form,
      input: inp,
      ps: psEl,
      hint: hint,
      /* 输出区本身是 role=log（读屏会念新行），不再另写一份 live */
      live: doc.createElement('div'),
      kh: /** @type {HTMLElement|undefined} */ (root.querySelector('[data-term-kh]') || undefined),
    },
    p: 'sgx-at',
    t: t,
    ps: psNow,
    onCmd: function (raw) { onCmd(raw); },
    isShown: o.isShown,
    history: false,
    secretModes: SECRET,
    complete: function (line) { return sh.complete(line); },
    onMode: function (m) { root.setAttribute('data-term-mode', m); paint(); },
    onCmdInterrupt: function () { return false; },
    onReveal: function () { scrollEnd(); },
    kh: {
      cmdKey: function () { return o.kh || ''; },
      canBackCmd: function () { return !!o.onBack; },
      onBack: function () { C.refocus = true; if (!C.interrupt() && o.onBack) o.onBack(); },
    },
    pmDefault: o.pmUser || '',
    maxLines: 400,
  });

  /* 回显：所有层同一个写法（提示符 + 命令；终端窗口的样式） */
  /** @param {string} cmd @param {string} [ps] */
  C.echo = function (cmd, ps) {
    const div = doc.createElement('div');
    div.className = 'sgx-term-ln sgx-term-cmd';
    const p = doc.createElement('span');
    p.className = 'sgx-term-pp';
    p.textContent = ps || psNow();
    div.appendChild(p);
    div.appendChild(doc.createTextNode(' ' + cmd));
    outEl.appendChild(div);
    scrollEnd();
  };
  /** 终端窗口开着 */
  C.shown = function () { return o.isShown ? o.isShown() : true; };

  R = (o.layers && o.layers(C)) || {};

  function paint() {
    if (C && C.mode === 'cmd') psEl.textContent = psNow();
    if (titleEl) titleEl.textContent = sh.title();
  }
  sh.onChange(paint);
  function paintGhost() {
    if (!gh) return;
    const g = C.mode === 'cmd' && inp.selectionStart === inp.value.length ? ghostOf(inp.value, sh.complete) : '';
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
  /** @param {Out[]} list */
  function print(list) {
    list.forEach(function (ln) {
      const div = doc.createElement('div');
      div.className = 'sgx-term-ln' + (ln.cls ? ' sgx-term-' + ln.cls : '');
      ln.seg.forEach(function (s) { div.appendChild(segEl(s)); });
      outEl.appendChild(div);
    });
    scrollEnd();
  }
  const khS = shellSection(doc, 'kh');
  /** 全屏阅读页（man）：盖住正文和按键提示行；退出后焦点还给输入行 */
  const pg = createPager({
    root: /** @type {HTMLElement} */ (root),
    hide: /** @type {HTMLElement[]} */ ([body || outEl, root.querySelector('[data-term-kh]')].filter(Boolean)),
    seg: segEl,
    str: { quit: String(sh.str.manPager || TERM_EN.manPager), back: String(khS.back || KH_EN.back), backAria: String(khS.backAria || KH_EN.backAria), label: 'man' },
    /* 退出后焦点还给输入行（触屏不强制，免得弹键盘） */
    onClose: function () { scrollEnd(); paint(); C.focusIn(); },
  });
  /** @param {Result} r */
  function finish(r) {
    if (r.clear) outEl.textContent = '';
    if (r.pager) pg.show(r.pager, r.out || []);
    else print(r.out || []);
    paint();
    if (r.after) r.after();
  }
  /** @param {boolean} on */
  function busyEv(on) { try { doc.dispatchEvent(new CustomEvent('sgx-busy', { detail: on })); } catch (e) {} }

  /** 命令行回车（input-line 只在命令模式调这里） @param {string} raw */
  function onCmd(raw) {
    const line = String(raw || '').replace(/\s+/g, ' ').trim();
    C.echo(line);
    if (!line) return;
    const r = sh.exec(line, R);
    if (r && typeof (/** @type {any} */ (r)).then === 'function') {
      /* 异步命令（cat daymark/today、find、ls ~/proxy、man）：先打一行等待提示，输入行收起，回来再放开 */
      const pend = /** @type {any} */ (r).pending;
      if (pend) print([{ t: 'line', seg: [['', '› ' + String(sh.str.fetching || TERM_EN.fetching).split('{x}').join(pend)]], cls: 'o' }]);
      C.setMode('busy');
      busyEv(true);
      /** @type {Promise<Result>} */ (r).then(function (res) {
        busyEv(false);
        C.toCmd();
        finish(res);
        C.focusIn(true);
      }, function () { busyEv(false); C.toCmd(); });
      return;
    }
    if (r && (/** @type {any} */ (r)).flow) return;
    finish(/** @type {Result} */ (r));
  }

  inp.addEventListener('input', paintGhost);
  inp.addEventListener('keyup', paintGhost);
  inp.addEventListener('click', paintGhost);
  inp.addEventListener('keydown', function (e) {
    if (e.isComposing || C.mode !== 'cmd') return;
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
    }
  });
  /* esc：先退出当前命令 / 离开 reset 层；都没有才交给窗口关掉（modal-sheet 看 defaultPrevented） */
  root.addEventListener('keydown', function (e) {
    const ke = /** @type {KeyboardEvent} */ (e);
    if (ke.key !== 'Escape' || ke.defaultPrevented) return;
    if (C.interrupt()) ke.preventDefault();
  });
  /* 等通行密钥（busy）时输入行藏着、焦点掉到 body：在 document 上接 Ctrl+C / esc，只中断等待、不关窗口 */
  doc.addEventListener('keydown', function (e) {
    if (C.mode !== 'busy' || !C.busyCancel || !C.shown() || e.defaultPrevented) return;
    const ctrlC = e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'c' || e.key === 'C');
    if (!ctrlC && e.key !== 'Escape') return;
    e.preventDefault();
    C.refocus = true;
    C.interrupt();
  }, true);
  /* 点终端空白处 = 聚焦输入行（选中文字时不抢；选项 / ^C 按钮由 input-line 接） */
  root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    /* 输出里的按钮（sub 的复制等）：交给账号层 */
    const ab = tg && tg.closest('[data-at-act]');
    if (ab && R.acct && R.acct.actLog) { e.preventDefault(); R.acct.actLog(ab.getAttribute('data-at-act') || ''); return; }
    if (tg && tg.closest('a, button, input, [data-term-man]')) return;
    const sel = doc.getSelection && doc.getSelection();
    if (sel && String(sel).length) return;
    C.focusIn(true);
  });
  paint();

  /** 外面要跑一条命令：当作敲进来的 @param {string} line */
  function run(line) {
    if (C.mode !== 'cmd') C.interrupt();
    onCmd(line);
  }
  return {
    input: inp,
    /** 输入行上下文（input-line） */
    line: C,
    /** 两层上下文（账号 acct / v6 身份 ident） */
    layers: function () { return R; },
    run: run,
    /** 输入行预填（不替人回车） @param {string} s */
    prefill: function (s) {
      if (C.mode !== 'cmd') return;
      inp.value = s;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    },
    focus: function () { C.focusIn(true); },
    /** 窗口关上：各层收尾（印过的明文） */
    closed: function () {
      if (C.mode !== 'cmd' && C.mode !== 'done') C.interrupt();
      pg.close();
      [R.acct].forEach(function (r) { if (r && r.onTermClosed) r.onTermClosed(); });
    },
    /**
     * 新会话（S9，每次打开终端窗口）：进行中的输入 / 选择 / 等待取消、阅读页关上、滚动区回到欢迎行、cwd 回到本页、输入行清空。
     * 各层的收尾在上一次关窗口时（closed）已经做了。history 照旧。
     */
    fresh: function () {
      if (C.mode !== 'cmd' && C.mode !== 'done') C.interrupt();
      if (C.mode !== 'cmd') C.toCmd();
      pg.close();
      outEl.textContent = '';
      welcome.forEach(function (/** @type {Node} */ n) { outEl.appendChild(n.cloneNode(true)); });
      sh.reset();
      inp.value = '';
      paintGhost();
      paint();
      scrollEnd();
    },
    /** 阅读页开着 */
    paging: function () { return pg.isOpen(); },
  };
}

/** 外壳按键提示行英文底（单测用） */
export { KH_EN };
