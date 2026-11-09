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
 * 共享外壳组件：不 import 任何东西（gen-shell 核对）；输出只用 textContent 拼，不写 innerHTML。
 */

/** 目录（ls 的结果，cd 的目标；wild = 旷野） */
export const DIRS = ['blog', 'curio', 'daymark', 'wild'];
/** 账号终端的命令字（= shell/account/commands.js ROOT_COMMAND）、进站的命令字（= shell/space/commands.js ADMIN_COMMAND）；这个文件不 import 任何东西，只能抄一份 */
const ROOT_COMMAND = 'root';
const ADMIN_COMMAND = 'styrigx';
/** 环境提示符（= shell/space/commands.js ENV_GUEST / ENV_ROOT）：账号没登录 / 已登录 */
export const ENV_GUEST = 'styrigx@space';
export const ENV_ROOT = 'root@account';

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
/** 命令（help 的顺序 = 补全的顺序） */
export const COMMANDS = ['help', 'cd', 'ls', 'cat', 'sudo', 'theme', 'lock', 'ask', 'clear'];
/** 各命令参数的候选 */
export const ARGS = {
  cd: ['blog', 'curio', 'daymark', 'wild', '~', '..'],
  ls: ['blog', 'curio', 'daymark', 'wild'],
  cat: ['daymark/today'],
  sudo: [ROOT_COMMAND, ADMIN_COMMAND],
  theme: ['dark', 'light', 'auto'],
};
const HIST_KEY = 'sgx-term-hist';
const HIST_MAX = 50;

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
};

/**
 * 页面字符串表的 term 节叠在英文上
 * @param {Document} [doc] @returns {Record<string, string>}
 */
export function termStrings(doc) {
  /** @type {Record<string, string>} */
  let page = {};
  try {
    const d = doc || document;
    const el = d.getElementById('sgx-i18n-shell');
    const o = el && el.textContent ? JSON.parse(el.textContent) : null;
    if (o && o.term && typeof o.term === 'object') page = o.term;
  } catch (e) {}
  return Object.assign({}, TERM_EN, page);
}

/**
 * 一行命令 → 命令名 + 参数（按空白切；空行 → null）
 * @param {string} line @returns {{cmd: string, args: string[], rest: string} | null}
 */
export function parse(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  const m = /^(\S+)\s*([\s\S]*)$/.exec(s);
  if (!m) return null;
  const rest = m[2].trim();
  return { cmd: m[1].toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest: rest };
}

/** 一组字符串的公共前缀 @param {string[]} list */
function commonPrefix(list) {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

/**
 * tab 补全：只补最后一个词（第一个词补命令名，第二个词按命令补参数）。
 * 唯一候选 → 补全并在命令名后加空格；多个 → 补到公共前缀，options 列出全部；没有 → 原样。
 * @param {string} line
 * @returns {{line: string, options: string[]}}
 */
export function complete(line) {
  const src = String(line == null ? '' : line);
  const lead = src.replace(/^\s+/, '');
  const pad = src.slice(0, src.length - lead.length);
  const words = lead.split(/\s+/);
  /** @type {string[]} */
  let pool;
  let idx = words.length - 1;
  if (idx === 0) pool = COMMANDS;
  else if (idx === 1) pool = /** @type {Record<string, string[]>} */ (ARGS)[words[0].toLowerCase()] || [];
  else pool = [];
  const word = words[idx];
  const hits = pool.filter(function (c) { return c.indexOf(word) === 0; });
  if (!hits.length) return { line: src, options: [] };
  const head = pad + words.slice(0, idx).join(' ') + (idx ? ' ' : '');
  if (hits.length === 1) {
    const one = hits[0];
    const takesArgs = idx === 0 && Object.prototype.hasOwnProperty.call(ARGS, one) || one === 'ask';
    return { line: head + one + (takesArgs ? ' ' : ''), options: [] };
  }
  return { line: head + commonPrefix(hits), options: hits };
}

/**
 * 补全的「影子」：只有唯一候选时，返回还没打的那一截（输入框后面淡色显示，→ 接受）
 * @param {string} line @returns {string}
 */
export function ghost(line) {
  const src = String(line == null ? '' : line);
  if (!src.trim()) return '';
  const c = complete(src);
  if (c.options.length || c.line === src) return '';
  const full = c.line.replace(/\s+$/, '');
  return full.indexOf(src) === 0 ? full.slice(src.length) : '';
}

/**
 * cd 的参数 → 目标目录（'~' 或 DIRS 之一）；不认识 → null
 * @param {string} cwd 当前目录（'~' 或 DIRS 之一） @param {string} [arg]
 * @returns {string|null}
 */
export function normDir(cwd, arg) {
  let a = String(arg == null ? '' : arg).trim();
  if (!a || a === '~' || a === '/' || a === '~/') return '~';
  a = a.replace(/^~\//, '').replace(/^\.\//, '').replace(/\/+$/, '');
  if (a === '..' || a === '.') return a === '.' ? (cwd || '~') : '~';
  const up = /^\.\.\/(.+)$/.exec(a);
  if (up) a = up[1];
  a = a.toLowerCase();
  return DIRS.indexOf(a) >= 0 ? a : null;
}

/** 提示符里的路径 @param {string} cwd */
export function cwdPath(cwd) {
  return !cwd || cwd === '~' ? '~' : '~/' + cwd;
}

/**
 * 文案里的 {x} / {help} 等占位换成片段：返回 [[类, 文字], …]
 * @param {string} s @param {Record<string, [string, string]>} map 占位名 → [类, 文字]
 * @returns {Array<[string, string]>}
 */
export function fill(s, map) {
  /** @type {Array<[string, string]>} */
  const out = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m;
  const str = String(s || '');
  while ((m = re.exec(str))) {
    if (m.index > last) out.push(['', str.slice(last, m.index)]);
    const v = map[m[1]];
    out.push(v ? v : ['', m[0]]);
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push(['', str.slice(last)]);
  return out;
}

/**
 * @typedef {Array<[string, string, string?]>} Seg 一行：[类, 文字, 链接?]
 * @typedef {{ t: 'line', seg: Seg, cls?: string } | { t: 'help', head: Seg, rows: Array<[string, string]> }} Out
 * @typedef {{ out: Out[], clear?: boolean, after?: () => void }} Result
 * @typedef {Object} TermAct
 * @property {(dir: string) => ({ kind: 'scroll', label: string } | { kind: 'nav', href: string, go: () => void })} cd
 * @property {(which: string, sub?: string) => ({ href: string, go: () => void })} sudo  which = ROOT_COMMAND（账号终端，sub = '' | reauth | reset）| ADMIN_COMMAND（盾牌）
 * @property {(mode: string) => void} theme  '' = 打开外观面板；dark / light / auto = 设定
 * @property {() => void} lock
 * @property {(q: string) => void} ask
 * @property {() => Promise<{ text: string, by: string } | null>} today
 * @property {() => string} daymarkHref
 */

/**
 * @param {{ str?: Record<string, string>, act: TermAct, cwd?: string, storage?: Storage | null, signedIn?: () => boolean }} o
 */
export function createShell(o) {
  const S = Object.assign({}, TERM_EN, o.str || {});
  const act = o.act;
  const signedIn = o.signedIn || function () { return accountSignedIn(); };
  let cwd = o.cwd && DIRS.indexOf(o.cwd) >= 0 ? o.cwd : '~';
  const store = o.storage === undefined ? safeSession() : o.storage;
  /** @type {string[]} */
  let hist = [];
  try {
    const raw = store ? store.getItem(HIST_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) hist = arr.filter(function (x) { return typeof x === 'string'; }).slice(-HIST_MAX);
  } catch (e) {}
  let hi = hist.length;
  let draft = '';
  /** @type {Array<() => void>} */
  const subs = [];

  function saveHist() {
    try { if (store) store.setItem(HIST_KEY, JSON.stringify(hist.slice(-HIST_MAX))); } catch (e) {}
  }
  /** @param {string} line */
  function push(line) {
    const s = line.trim();
    if (s && hist[hist.length - 1] !== s) {
      hist.push(s);
      if (hist.length > HIST_MAX) hist = hist.slice(-HIST_MAX);
      saveHist();
    }
    hi = hist.length;
    draft = '';
  }
  /** @param {string} s @returns {Out} */
  const plain = function (s, cls) { return { t: 'line', seg: [['', s]], cls: cls || 'o' }; };
  /** @param {string} key @param {string} x @param {string} [cls] @param {string} [href] @returns {Out} */
  const tpl = function (key, x, cls, href) { return { t: 'line', seg: fill(S[key], { x: [href ? 'a' : 'k', x, href || ''] }), cls: cls || 'o' }; };
  /** @param {string} c @param {string} x @returns {Out} */
  const noDir = function (c, x) { return { t: 'line', seg: fill(S.noDir, { c: ['', c], x: ['k', x] }), cls: 'err' }; };
  /** @param {Seg} seg @returns {Out} */
  const arrow = function (seg) { return { t: 'line', seg: /** @type {Seg} */ ([['ok', '→ ']]).concat(seg), cls: 'o' }; };

  function helpOut() {
    /** @type {Out} */
    const h = {
      t: 'help',
      head: [['k', 'cd'], ['', ' blog · curio · daymark · wild · ~']],
      rows: [
        ['ls', S.dLs],
        ['cat', S.dCat],
        ['sudo ' + ROOT_COMMAND, S.dAccount],
        ['sudo ' + ADMIN_COMMAND, S.dSecurity],
        ['theme', S.dTheme],
        ['lock', S.dLock],
        ['ask', S.dAsk],
        ['clear', S.dClear],
      ],
    };
    return h;
  }

  /**
   * 执行一行。返回输出（today 是异步的，返回 Promise）
   * @param {string} line @returns {Result | Promise<Result>}
   */
  function exec(line) {
    push(line);
    const p = parse(line);
    if (!p) return { out: [] };
    const a0 = (p.args[0] || '').toLowerCase();
    switch (p.cmd) {
      case 'help':
      case '?':
        return { out: [helpOut()] };
      case 'clear':
      case 'cls':
        return { out: [], clear: true };
      case 'ls': {
        const d = p.args.length ? normDir(cwd, p.args[0]) : cwd;
        if (d === null) return { out: [noDir('ls', p.args[0])] };
        if (d === '~') return { out: [{ t: 'line', seg: DIRS.map(function (x, i) { return /** @type {[string, string]} */ (['dir', x + '/' + (i < DIRS.length - 1 ? '  ' : '')]); }), cls: '' }] };
        if (d === 'daymark') return { out: [{ t: 'line', seg: [['', 'today']], cls: '' }] };
        return { out: [plain(S.lsEmpty)] };
      }
      case 'cd': {
        const d = normDir(cwd, p.args[0]);
        if (d === null) return { out: [noDir('cd', p.args[0])] };
        const r = act.cd(d);
        cwd = d;
        emit();
        if (r && r.kind === 'scroll') return { out: r.label ? [arrow(fill(S.scrolled, { x: ['', r.label] }))] : [] };
        if (r && r.kind === 'nav') return { out: [arrow(fill(S.opening, { x: ['k', r.href] }))], after: r.go };
        return { out: [] };
      }
      case 'cat': {
        const f = (p.args[0] || '').replace(/^~\//, '').replace(/^\.\//, '');
        const ok = f === 'daymark/today' || (cwd === 'daymark' && f === 'today') || f === '../daymark/today';
        if (!f) return { out: [plain(S.usageCat)] };
        if (!ok) return { out: [tpl('noFile', p.args[0], 'err')] };
        const href = act.daymarkHref();
        return act.today().then(function (q) {
          if (q && q.text) {
            /** @type {Out[]} */
            const out = [{ t: 'line', seg: [['q', '“' + q.text + '”']], cls: '' }];
            if (q.by) out.push(plain(q.by));
            return { out: out };
          }
          return { out: [tpl('todayNone', href, 'o', href)] };
        }, function () {
          return { out: [tpl('todayFail', href, 'o', href)] };
        });
      }
      case 'sudo': {
        /* sudo root [reauth|reset]：账号终端（2026-11-08 账号命令体系 v3）；sudo styrigx：盾牌（进站 v3 L1；原 sudo security） */
        const a1 = (p.args[1] || '').toLowerCase();
        const okRoot = a0 === ROOT_COMMAND && (a1 === '' || a1 === 'reauth' || a1 === 'reset') && p.args.length <= 2;
        if (!okRoot && !(a0 === ADMIN_COMMAND && p.args.length === 1)) return { out: [plain(S.usageSudo)] };
        const r = act.sudo(a0, a1);
        return { out: [arrow(fill(S.opening, { x: ['k', r.href] }))], after: r.go };
      }
      case 'theme': {
        if (!a0) return { out: [arrow([['', S.themeOpen]])], after: function () { act.theme(''); } };
        if (ARGS.theme.indexOf(a0) < 0) return { out: [plain(S.usageTheme)] };
        act.theme(a0);
        return { out: [arrow(fill(S.themeSet, { x: ['k', a0] }))] };
      }
      case 'lock':
        return { out: [arrow([['', S.locking]])], after: function () { act.lock(); } };
      case 'ask': {
        const q = p.rest;
        return { out: [arrow([['', S.asking]])], after: function () { act.ask(q); } };
      }
      default:
        return { out: [tpl('notFound', p.cmd, 'err')] };
    }
  }

  function emit() {
    subs.forEach(function (f) { try { f(); } catch (e) {} });
  }

  return {
    str: S,
    exec: exec,
    help: helpOut,
    /** 提示符（环境提示符规则）：styrigx@space:~$ / styrigx@space:~/blog$；账号已登录 root@account:~# / root@account:~/blog# */
    ps1: function () { const r = signedIn(); return (r ? ENV_ROOT : ENV_GUEST) + ':' + cwdPath(cwd) + (r ? '#' : '$'); },
    /** 标题栏：styrigx@space: ~ / root@account: ~ */
    title: function () { return (signedIn() ? ENV_ROOT : ENV_GUEST) + ': ' + cwdPath(cwd); },
    cwd: function () { return cwd; },
    /** @param {() => void} f */
    onChange: function (f) { subs.push(f); },
    /** ↑：上一条（第一次按先存下正在打的草稿） @param {string} cur */
    prev: function (cur) {
      if (!hist.length) return null;
      if (hi === hist.length) draft = cur;
      if (hi > 0) hi--;
      return hist[hi];
    },
    /** ↓：下一条；到底回到草稿 */
    next: function () {
      if (hi >= hist.length) return null;
      hi++;
      return hi === hist.length ? draft : hist[hi];
    },
    history: function () { return hist.slice(); },
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
 * @param {{ autoHelp?: boolean }} [opts]
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

  function paintPrompt() {
    if (ps) ps.textContent = sh.ps1();
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
    paintPrompt();
    if (r.after) r.after();
  }
  /** @param {string} line */
  function run(line) {
    const pr = sh.ps1();
    echo(pr, line);
    const r = sh.exec(line);
    if (r && typeof (/** @type {any} */ (r)).then === 'function') {
      inp.disabled = true;
      /** @type {Promise<Result>} */ (r).then(function (x) {
        inp.disabled = false;
        finish(x);
        try { inp.focus({ preventScroll: true }); } catch (e) {}
      });
    } else finish(/** @type {Result} */ (r));
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
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
