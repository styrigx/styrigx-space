/**
 * @fileoverview 终端（v5 S5 终端合一，term-design-v5）：原锁屏 tty1、主页 tty2、盾牌 tty3、账号 tty5 合成一个终端——一个会话、一份历史、一张命令表。
 * AI 窗口（tty4）不动：它里面以 $ 开头的输入照旧走这里的 createShell（自己的历史 sgx-term-hist-4）。
 *
 * - 引擎 createShell()：命令表（shell/term/cmds/index.js）、提示符（身份 shell/term/core/who.js：nobody / link / styrigx / root，服务端说了算）、
 *   历史（↑↓，sessionStorage sgx-term-hist，全站一份）、Tab 补全、cd 的当前目录。真正的动作（跳页 / 外观 / AI / 打开账号窗口）由调用方经 act 传进来。
 * - 视图 mountTerminal()：把一个终端窗口标记（[data-sgx-term]）接到引擎上。输入行用 shell/term/view/input-line.js（秘密输入 / 选择 / 等待 / ^C 都在那里），
 *   要输入、选择、验证的命令（sudo、lock、share、账号命令、sub）交给调用方给的两层上下文去跑（layers：钥匙层 shell/space/layer.js、
 *   账号层 shell/account/cmd/layer.js），它们共用这一个输入行（shell/term/view/layer-ctx.js）。账号窗口（头像，shell/account/window.js）照旧，有自己的命令行。
 *   桌面是居中大窗（#sgx-term 抽屉），手机整块卡片；四站只有这一个（v5 S7 起主页首屏是 neofetch，不再嵌终端）。
 * - 文案：#sgx-i18n-shell 的 term 节（data/sgx-shell-i18n/<语言>.yaml，缺键回退下面的英文）。
 *
 * 共享外壳组件：只许 import shell/term/**（终端统一 T1，gen-shell 核对）。
 */
import { ROOT_COMMAND, ADMIN_COMMAND, parse } from './term/core/parse.js';
import { KH_EN, shellSection, flatStrings } from './term/core/strings.js';
import { createRegistry } from './term/core/registry.js';
import { completeLine, ghostOf, completerOf } from './term/core/complete.js';
import { createHistory } from './term/core/history.js';
import { cwdPath, ps1, title, createWho, PS_RESET } from './term/core/who.js';
import { fill, outKit } from './term/core/out.js';
import { createEngine } from './term/core/engine.js';
import { DIRS, normDir } from './term/cmds/fs/tree.js';
import { CMDS } from './term/cmds/index.js';
import { createInputLine } from './term/view/input-line.js';

export { DIRS, normDir, cwdPath, fill, parse, createWho, ps1 };

/** 命令表 */
const REG = createRegistry(CMDS);
/** 命令（man 索引的顺序 = 补全的顺序） */
export const COMMANDS = REG.names();
/** 各命令参数的候选 */
export const ARGS = /** @type {Record<string, string[]>} */ ({});
REG.list().forEach(function (c) { if (c.args) ARGS[c.name] = c.args; });
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
  usageSudo: 'usage: sudo ' + ADMIN_COMMAND + ' [reset] | sudo ' + ROOT_COMMAND + ' [reauth | reset] | sudo -v',
  usageTheme: 'usage: theme [dark | light | auto]',
  usageCat: 'usage: cat daymark/today',
  usageLock: 'usage: lock [passwd | passkey [add | rm <n>] | --all]',
  usageShare: 'usage: share [add | rm <n> | rm --all]',
  usagePasswd: 'usage: passwd',
  usagePasskey: 'usage: passkey [add | rm <n>]',
  usageDevice: 'usage: device [rm <n> | rm --all]',
  usageApp: 'usage: app [rm <n>]',
  themeSet: 'theme → {x}',
  themeOpen: 'appearance panel opened',
  asking: 'asking Gray AI …',
  fetching: 'fetching {x}…',
  manIndex: 'manual pages · man <command> to read one',
  manNone: 'No manual entry for {x}',
  manPager: 'q or enter to quit',
  notDir: '{c}: not a directory: {x}',
  usageFind: 'usage: find <keyword>',
  findNone: 'find: no matches for {x}',
  findDown: 'find: search is unavailable right now · try again later',
  findLimited: 'find: too many searches · try again in a minute',
  askLocked: 'AI is locked · run {s} first; use {f} to search by keyword',
  needEntry: 'not entered · run {x} first',
  needRoot: 'not signed in to the account · run {x} first',
  linkDenied: 'a share-link session can’t do this · enter with your own key',
  alreadyIn: 'already entered · {x} to verify again',
  notHere: '{x}: run it in the terminal (Ctrl K)',
  resetOnly: 'in reset: passwd · passkey [add | rm <n>] · exit',
};

/**
 * 页面字符串表的 term 节叠在英文上
 * @param {Document} [doc] @returns {Record<string, string>}
 */
export function termStrings(doc) {
  return Object.assign({}, TERM_EN, shellSection(doc, 'term'));
}

/** 打错命令时拿来比的真命令（命令名 + 几个常用的整句） */
const SUGGEST = COMMANDS.concat(['open blog', 'open curio', 'open daymark', 'open wild', 'sudo ' + ROOT_COMMAND, 'sudo ' + ADMIN_COMMAND, 'sudo -v', 'cat daymark/today', 'lock passwd', 'lock passkey', 'share add']);

/**
 * tab 补全：只补最后一个词（第一个词补命令名，第二个词按命令补参数）。
 * @param {string} line @param {string[]} [names] 第一个词的候选（缺省全部命令）
 * @returns {{line: string, options: string[]}}
 */
export function complete(line, names) {
  return completeLine(line, {
    names: names || COMMANDS,
    argsOf: function (c) { return ARGS[c] || []; },
    takesArgs: function (c) { const x = REG.get(c); return !!x && (!!x.args || !!x.takesArgs); },
  });
}

/** 补全的「影子」：只有唯一候选时，返回还没打的那一截 @param {string} line */
export function ghost(line) {
  return ghostOf(line, function (l) { return complete(l); });
}

/**
 * @typedef {Array<[string, string, string?]>} Seg 一行：[类, 文字, 链接?]
 * @typedef {{ t: 'line', seg: Seg, cls?: string }} Out
 * @typedef {{ out: Out[], clear?: boolean, after?: () => void, pager?: boolean, flow?: boolean }} Result
 *   pager = 显示完进 pager（man；提示符 `:`，q / enter 回命令行）；flow = 交给那一层去跑了（它自己打输出、换输入模式）
 * @typedef {Object} TermAct
 * @property {(dir: string) => ({ kind: 'scroll', label: string } | { kind: 'nav', href: string, go: () => void })} cd  open 的站点目录
 * @property {(mode: string) => void} theme  '' = 打开外观面板；dark / light / auto = 设定
 * @property {(q: string) => void} ask
 * @property {(q: string) => Promise<any>} find  find <词>（v5 S4，GET /api/find）
 * @property {() => Promise<{ text: string, by: string } | null>} today
 * @property {() => string} daymarkHref
 * @property {(layer: string) => ({ href: string, go: () => void })} [account]  open ~/account[/层]
 * @property {() => Promise<any[]|null>} [proxyList]  ls ~/proxy
 * @property {() => void} [close]  exit：关掉终端窗口
 */

/**
 * @param {{ str?: Record<string, string>, act: TermAct, cwd?: string, storage?: Storage | null, histKey?: string,
 *   who?: { get: () => import('./term/core/who.js').Who, on: (f: any) => void } }} o
 *   histKey 缺省 sgx-term-hist（AI 窗口里的 $ 命令是 sgx-term-hist-4）；who 缺省一直是 nobody（没有身份来源的地方）
 */
export function createShell(o) {
  const S = Object.assign({}, TERM_EN, o.str || {});
  const act = o.act;
  const who = o.who || { get: function () { return /** @type {any} */ ('nobody'); }, on: function () {} };
  let cwd = o.cwd && DIRS.indexOf(o.cwd) >= 0 ? o.cwd : '~';
  const hist = createHistory({ storage: o.storage === undefined ? safeSession() : o.storage, key: o.histKey || HIST_KEY });
  /** @type {Array<() => void>} */
  const subs = [];
  function emit() {
    subs.forEach(function (f) { try { f(); } catch (e) {} });
  }
  who.on(emit);

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
    /** 这个身份在 man 索引里列出的命令名（registry listed） */
    names: function () { return REG.listed(who.get()); },
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
    /** 提示符：nobody@space:~$ · nobody@space:~# · styrigx@space:~/blog# · root@account:~# */
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
    /** 这个身份的 Tab 补全（第一个词只补列出的命令） @param {string} line */
    complete: function (line) { return complete(line, REG.listed(who.get())); },
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

/** reset 层只认这几条（账号 reset：passwd / passkey / exit；钥匙 reset 有自己的命令解析 shell/space/reset.js） */
const ACCT_RESET_OK = ['passwd', 'passkey', 'exit', 'clear', 'man', 'history'];
/** 秘密输入（不回显）的模式：解锁 / 账号密码、恢复钥匙、新密码两次、机场链接 */
const SECRET = ['pw', 'rkey', 'newpw', 'newpw2', 'suburl'];

/**
 * 把一个终端窗口标记接到引擎上。标记（抽屉 shell-topbar.html）：
 *   [data-sgx-term] > .sgx-term-bar [data-term-title] … ；.sgx-term-body [data-term-body] > [data-term-out] + form[data-term-form]
 *   > input[data-term-pmu] + label[data-term-ps] + .sgx-term-field > input[data-term-in] + [data-term-ghost]；p[data-term-hint]；p[data-term-kh]
 * @param {Element} root
 * @param {ReturnType<typeof createShell>} sh
 * @param {{ kh?: string, onBack?: () => void, isShown?: () => boolean, pmUser?: string,
 *   layers?: (line: any) => { space?: any, acct?: any } }} [opts] kh = 命令行时按键提示行那一句（#sgx-i18n-shell kh 节）；onBack = 触屏「‹ 返回」/ 最外层 esc
 */
export function mountTerminal(root, sh, opts) {
  const o = opts || {};
  const doc = root.ownerDocument || document;
  const out = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-out]'));
  const body = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-body]'));
  const form = /** @type {HTMLFormElement|null} */ (root.querySelector('[data-term-form]'));
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-term-in]'));
  const psEl = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-ps]'));
  const pmu = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-term-pmu]'));
  const hint = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-hint]'));
  const titleEl = root.querySelector('[data-term-title]');
  const gh = /** @type {HTMLElement|null} */ (root.querySelector('[data-term-ghost]'));
  if (!out || !form || !input || !psEl || !pmu || !hint) return null;
  const inp = input;
  const outEl = out;
  const SP = flatStrings(shellSection(doc, 'space'));
  /** 输入行自己要的几句（秘密输入 / 命名的读屏名、^C、没有这个选项）：钥匙层那一节 @param {string} k */
  const t = function (k) { return SP[k] || ''; };

  /** man 显示完进 pager：提示符 `:`，q / enter 回命令行（终端统一 T5） */
  let pager = false;
  /** @type {{ space?: any, acct?: any }} */
  let R = {};
  /** 当前提示符：pager `:`；reset 层各自的；其余按身份 */
  function psNow() {
    if (pager) return ':';
    if (R.space && R.space.inReset) return PS_RESET.space;
    if (R.acct && R.acct.inReset) return PS_RESET.account;
    return sh.ps1();
  }
  /** @type {any} */
  let C = null;
  C = createInputLine({
    dom: {
      root: /** @type {HTMLElement} */ (root),
      log: outEl,
      form: form,
      input: inp,
      ps: psEl,
      pmu: pmu,
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
    complete: function (line) {
      if (R.space && R.space.inReset) return R.space.completeReset(line);
      if (R.acct && R.acct.inReset) return completerOf({ names: ACCT_RESET_OK, args: { passkey: ['add', 'rm'] } })(line);
      return sh.complete(line);
    },
    onMode: function (m) { root.setAttribute('data-term-mode', m); paint(); },
    onCmdInterrupt: function () {
      if (pager) { quitPager(); return true; }
      if (R.space && R.space.inReset) { C.out('^C', 'd'); R.space.leaveReset(); return true; }
      if (R.acct && R.acct.inReset) { C.out('^C', 'd'); R.acct.leaveReset(); return true; }
      return false;
    },
    onReveal: function () { scrollEnd(); },
    kh: {
      cmdKey: function () { return inLayer() ? 'cmdLayer' : o.kh || ''; },
      canBackCmd: function () { return inLayer() || !!o.onBack; },
      onBack: function () { C.refocus = true; if (!C.interrupt() && o.onBack) o.onBack(); },
    },
    pmDefault: o.pmUser || '',
    maxLines: 400,
  });
  /** reset 层里（esc / ‹ 返回 = 离开 reset） */
  function inLayer() { return !!((R.space && R.space.inReset) || (R.acct && R.acct.inReset)); }

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
  /** 终端窗口回前台 / 关上时各层要做的事（关上：结束 reauth 等） */
  C.shown = function () { return o.isShown ? o.isShown() : true; };

  R = (o.layers && o.layers(C)) || {};

  function paint() {
    if (C && C.mode === 'cmd') psEl.textContent = psNow();
    if (titleEl) titleEl.textContent = sh.title();
  }
  sh.onChange(paint);
  function paintGhost() {
    if (!gh) return;
    const g = C.mode === 'cmd' && !pager && !inLayer() && inp.selectionStart === inp.value.length ? ghostOf(inp.value, sh.complete) : '';
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
  /** @param {Result} r */
  function finish(r) {
    if (r.clear) outEl.textContent = '';
    print(r.out || []);
    pager = !!r.pager;
    if (pager) print([{ t: 'line', seg: [['', '# ' + String(sh.str.manPager || TERM_EN.manPager)]], cls: 'o' }]);
    paint();
    if (r.after) r.after();
  }
  /** @param {boolean} on */
  function busyEv(on) { try { doc.dispatchEvent(new CustomEvent('sgx-busy', { detail: on })); } catch (e) {} }

  /** 命令行回车（input-line 只在命令模式调这里） @param {string} raw */
  function onCmd(raw) {
    if (pager) { quitPager(); return; }
    /* 钥匙的 reset 层：命令解析在 shell/space/reset.js（层不变），它自己回显 */
    if (R.space && R.space.inReset) { R.space.runResetCmd(raw); paintGhost(); return; }
    const line = String(raw || '').replace(/\s+/g, ' ').trim();
    C.echo(line);
    if (!line) return;
    if (R.acct && R.acct.inReset) {
      const p0 = parse(line);
      if (p0 && ACCT_RESET_OK.indexOf(p0.cmd) === -1) { print([{ t: 'line', seg: [['', String(sh.str.resetOnly || TERM_EN.resetOnly)]], cls: 'err' }]); return; }
    }
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

  function quitPager() {
    pager = false;
    inp.value = '';
    paintGhost();
    paint();
  }
  inp.addEventListener('input', paintGhost);
  inp.addEventListener('keyup', paintGhost);
  inp.addEventListener('click', paintGhost);
  inp.addEventListener('keydown', function (e) {
    if (e.isComposing || C.mode !== 'cmd') return;
    if (pager && (e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); quitPager(); return; }
    if (e.key === 'ArrowRight' && gh && !gh.hidden && inp.selectionStart === inp.value.length) {
      e.preventDefault();
      inp.value = inp.value + gh.textContent;
      paintGhost();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !pager) {
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
    if (tg && tg.closest('a, button, input')) return;
    const sel = doc.getSelection && doc.getSelection();
    if (sel && String(sel).length) return;
    C.focusIn(true);
  });
  paint();

  /** 外面要跑一条命令（GUI 跳终端、地址 ?entry=sudo、上锁的地方）：当作敲进来的 @param {string} line */
  function run(line) {
    if (C.mode !== 'cmd') C.interrupt();
    onCmd(line);
  }
  return {
    input: inp,
    /** 输入行上下文（input-line） */
    line: C,
    /** 两层上下文（钥匙 space / 账号 acct） */
    layers: function () { return R; },
    run: run,
    /** 输入行预填（不替人回车） @param {string} s */
    prefill: function (s) {
      if (C.mode !== 'cmd') return;
      inp.value = s;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    },
    focus: function () { C.focusIn(true); },
    /** 窗口关上：各层收尾（reauth / reset 票、印过的明文） */
    closed: function () {
      if (C.mode !== 'cmd' && C.mode !== 'done') C.interrupt();
      if (pager) quitPager();
      [R.space, R.acct].forEach(function (r) { if (r && r.onTermClosed) r.onTermClosed(); });
    },
  };
}

/** 外壳按键提示行英文底（单测用） */
export { KH_EN };
