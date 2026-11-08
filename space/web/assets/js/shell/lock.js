/**
 * @fileoverview 全站锁屏界面（按需加载：由 shell/lock-guard.js 在 locked / unknown 时 import()；守卫、去处判定在 lock-guard.js）。
 * 原说明：全站锁屏（2.4.0 H；2026-10-23 Turnstile 入口改临时 LockKey）。
 * 分层规范 L4：lock.js 只负责两件事——
 * 1. 按 L1（middleware 注入的 <html data-sgx-lock-session>）画锁屏，不自己判断会话；
 * 2. 把密码、临时钥匙或通行密钥提交给 L2（workers/auth-gateway/src/api/*）。
 * 唯一状态源是服务端签发的 sgx-lock-session 会话；禁止用 sessionStorage、
 * localStorage、前端内存或标签页状态另做判断。
 *
 * lock-v10 命令解锁（2026-11-08，Gray：「按设计稿」「弹窗是实现的方式」；设计稿 entry-v2/lock.html K1–K4）：
 * 锁屏上没有任何弹层 / 底部弹层 / 对话框。终端窗里有一行真的命令输入框，解锁就是在这里敲命令：
 * - help（man / ?）列出可用命令；clear 清屏；
 * - password（sudo、sudo spacekey password）→ 同一行变成 `[sudo] password for …:`，输入不回显，回车提交 → POST /api/lock-password；
 * - passkey（sudo spacekey passkey）→ 系统通行密钥窗口 → /api/lock-passkey；
 * - tempkey（sudo tempkey、key）→ 同一行变成 `tempkey:`，输入不回显 → POST /api/lock-tempkey-unlock（在设置 → 安全与隐私 → 临时钥匙页签发，12 位 XXXX-XXXX-XXXX）；
 * - reset（forgot）→「无法登录？」重置登录，也在终端里一步步问：进站凭证 → （服务端要求时）再验锁屏凭证 → 去 /security/lock/；
 * - 不认识的命令 → `command not found: x · try help`。
 * 快捷键 password / passkey 只是替你把命令敲进去再回车；只显示 /api/lock-entry 说已配置的（读取失败按已配置）。
 * 出错、冷却倒计时、验证中、access granted 都打印成终端行；终端输出 aria-hidden，读屏走一个 aria-live 区域（同样的文字）。
 * 本地开发（localhost）tempkey 直接开锁（不输临时钥匙）。
 */
import { on } from '../lib/events.js';
import { reducedMotion, esc } from '../lib/util.js';
import { onKeyboardHeight } from './vk.js';
import { tapFeedback } from '../lib/dialog-behavior.js';
import { getPasskeyAssertion, passkeyErrorText, assertionOptions, assertionToJSON, isPasskeyCancel } from '../auth/passkey-assert.js';
import { KEY_LOCK, KEY_SPACE } from '../lib/key-names.js';
import { profileDefaults, readCache, effectiveProfile } from '../lib/profile.js';
import { sgxNavigate } from '../lib/diag-jumptrace.js';
import { isLocalDev, pageState, askServer, proceed, bindAutoLock } from './lock-guard.js';
import { langPath, langs } from '../lib/lang-path.js';
import { setLang } from '../lib/prefs.js';
import { i18nTable, pageLang } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-core（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('core');

/**
 * 锁屏头像的替代文字 = 个人资料的姓名（2026-11-07）：构建期默认值（data/profile.yaml）← 本机缓存里改过的（上次进门时 GET /api/profile 写的）。
 * 锁屏前不问接口；这只是显示用的文字，和会话判断无关（上面「唯一状态源是服务端会话」说的是解锁状态）。
 */
function lockName() {
  return effectiveProfile(readCache(), profileDefaults()).name;
}

/**
 * 命令表：别名（小写、空白归一）→ 命令。
 * @type {Record<string, string>}
 */
const ALIAS = {
  'help': 'help', '?': 'help', 'ls': 'help',
  'man': 'man', 'man space': 'man',
  /* cd .. / cd /：和 Ctrl+C 一样「返回」（2026-11-08 03:11 Gray） */
  'cd ..': 'back', 'cd /': 'back',
  'password': 'password', 'pw': 'password', 'sudo': 'sudo', 'sudo spacekey': 'sudo', 'sudo spacekey password': 'password', 'sudo password': 'password',
  'passkey': 'passkey', 'pk': 'passkey', 'sudo spacekey passkey': 'passkey', 'sudo passkey': 'passkey',
  'tempkey': 'tempkey', 'key': 'tempkey', 'sudo tempkey': 'tempkey',
  'reset': 'reset', 'forgot': 'reset', 'sudo reset': 'reset',
  'clear': 'clear', 'cls': 'clear',
};
/** Tab 补全候选（顺序 = help 列表顺序） */
const COMPLETE = ['help', 'password', 'passkey', 'tempkey', 'reset', 'clear', 'man space', 'sudo spacekey password', 'sudo spacekey passkey', 'sudo tempkey'];
/** 输凭证时敲这几行 = 返回（同 Ctrl+C） */
const BACK_RE = /^cd\s*(\.\.|\/)\s*$/;

/**
 * 显示锁屏 UI（2.4.0 H；lock-v10 命令解锁）。
 */
export function showLockScreen() {
  const en = document.documentElement.lang === 'en';
  const isLocal = isLocalDev();

  /* 头像：复用顶栏头像图片 .sgx-tb-avatar（2026-11 PR-5 按设计稿 AI 窗口头部不再有头像；顶栏头像是账号下拉的入口） */
  const navImg = /** @type {HTMLImageElement|null} */ (document.querySelector('#site-nav .sgx-tb-avatar'));
  const avatarSrc = navImg ? navImg.src.replace(/\/avatar\/96\.webp/, '/avatar/192.webp') : '';

  /* 顶栏保持全站同一个（2026-11-04 P5-1 全大椭圆）：字标 + 页名 + 右边按钮，外观取页面顶栏同一份。
     锁屏上它们只是外观（span、不可点、不进读屏），导航 / 快捷面板 / AI 在锁定时打不开，不能绕过锁屏。类名照抄。 */
  const tbLogoEl = document.querySelector('#site-nav .sgx-tb-logo');
  const tbLogo = tbLogoEl ? tbLogoEl.innerHTML : '';
  const tbActs = Array.from(document.querySelectorAll('#site-nav .sgx-tb-acts .sgx-tb-btn')).map(function (b) {
    return '<span class="' + b.className + '">' + b.innerHTML + '</span>';
  }).join('');

  /* 底部语言切换（设计稿 `~/styrigx_ · zh · en`）：配置里的语言（hugo.yaml languages），点了和快捷面板语言行同一个写法（lib/prefs.js setLang） */
  const curLang = pageLang();
  /* 设计稿顺序 zh · en（配置顺序是默认语言 en 在前，这里倒过来） */
  const langBtns = langs().slice().reverse().map(function (l) {
    return '<span class="sgx-lock-tsep" aria-hidden="true"> · </span>' +
      '<button type="button" class="sgx-lock-lang" data-lang="' + l + '" lang="' + l + '"' +
      (l === curLang ? ' aria-current="true"' : '') + '>' + l + '</button>';
  }).join('');

  const termUser = (String(lockName() || '').trim().split(/\s+/)[0] || 'user').toLowerCase();

  const ov = document.createElement('div');
  ov.id = 'sgx-lock';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', tx('lockLockScreen'));
  /* 版面（设计稿 K1）：顶栏（只是外观）→ 头像 → 状态胶囊 `$ STATUS: …` → 名字 → 欢迎回来 · 很高兴再次见到你 →
     锁屏终端窗（标题栏 `$ LOCK · tty1` · 输出 · 命令输入行 · 快捷键）→ 底部 `~/styrigx_ · zh · en`。 */
  ov.innerHTML =
    '<div class="sgx-glass-bg" aria-hidden="true"></div>' +
    '<div class="sgx-lock-tb"><div class="sgx-topbar">' +
    '<span class="sgx-tb-logo" aria-hidden="true">' + tbLogo + '</span>' +
    /* 顶栏标题：静止时「锁定屏幕」，正在输入凭证 / 验证时「解锁屏幕」（syncTitle） */
    '<div class="sgx-tb-pill"><span class="sgx-tb-title" id="sgx-lock-title">' + tx('lockLockScreen2') + '</span></div>' +
    '<span class="sgx-tb-acts" aria-hidden="true">' + tbActs + '</span>' +
    '</div></div>' +
    '<div class="sgx-lock-stage" id="sgx-lock-stage">' +
    '<div class="sgx-lock-user">' +
    '<div class="sgx-lock-av" id="sgx-lock-avatar">' +
    (avatarSrc
      ? '<img src="' + avatarSrc + '" alt="' + esc(lockName()) + '" translate="no" data-sgx-personal width="120" height="120">'
      : '<span class="sgx-lock-fb" aria-hidden="true">S</span>') +
    '</div>' +
    '<p class="sgx-lock-st" id="sgx-lock-st" data-st="locked" aria-hidden="true"><i></i><span id="sgx-lock-st-tx">$ STATUS: LOCKED</span></p>' +
    '<p class="sgx-lock-nm" aria-hidden="true" translate="no" data-sgx-personal>' + esc(lockName()) + '</p>' +
    '<p class="sgx-lock-greet"><span class="sgx-lock-welcome">' + tx('lockWelcomeBack') + '</span>' +
    '<span class="sgx-lock-gsep" aria-hidden="true"> · </span>' +
    '<span class="sgx-lock-sub">' + tx('lockGoodToSeeYou') + '</span></p>' +
    '<div class="sgx-lock-term" id="sgx-lock-term">' +
    '<div class="sgx-lock-term-bar" aria-hidden="true"><span><b>$</b> LOCK · tty1</span><span id="sgx-lock-tty">guest</span></div>' +
    '<div class="sgx-lock-tbody" id="sgx-lock-tbody">' +
    '<div class="sgx-lock-log" id="sgx-lock-log" aria-hidden="true"></div>' +
    /* 命令输入行：真的 <input>（有 aria-label）。输凭证时 type=password（不回显），隐藏用户名给密码管理器（LockKey / 重置时 SpaceKey） */
    '<form class="sgx-lock-line" id="sgx-lock-form" data-mode="cmd" novalidate>' +
    '<input type="text" class="sgx-lock-pmu" id="sgx-lock-pmu" name="username" autocomplete="username" value="' + KEY_LOCK + '" aria-hidden="true" tabindex="-1" readonly>' +
    '<label class="sgx-lock-ps" id="sgx-lock-ps" for="sgx-lock-cmd" aria-hidden="true"></label>' +
    '<span class="sgx-lock-cur sgx-lock-icur" aria-hidden="true"></span>' +
    '<input type="text" class="sgx-lock-in" id="sgx-lock-cmd" name="cmd" placeholder=" " autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" maxlength="256" aria-label="' + esc(tx('lockTermCmdAria')) + '">' +
    '</form>' +
    '<p class="sgx-lock-hint" id="sgx-lock-hint" hidden><span id="sgx-lock-hint-tx" aria-hidden="true"></span> ' +
    '<button type="button" class="sgx-lock-cc" id="sgx-lock-cc" aria-label="' + esc(tx('lockCancel')) + '">Ctrl+C</button>' +
    '<span aria-hidden="true"> ' + esc(tx('lockTermBack')) + '</span></p>' +
    '</div>' +
    '<p class="sgx-lock-qh" id="sgx-lock-qh" aria-hidden="true" hidden>' + esc(tx('lockTermHint')) + '</p>' +
    '<div class="sgx-lock-qk">' +
    '<button type="button" class="sgx-lock-k" id="sgx-lock-k-pw" data-k="password" data-run="sudo spacekey password" aria-label="' + esc(tx('lockUsePassword')) + '" hidden>password</button>' +
    '<button type="button" class="sgx-lock-k" id="sgx-lock-k-pk" data-k="passkey" data-run="sudo spacekey passkey" aria-label="' + esc(tx('lockUsePasskey')) + '" hidden>passkey</button>' +
    '</div>' +
    '</div>' +
    /* 读屏：终端输出的同样文字（终端本身 aria-hidden） */
    '<p class="sgx-lock-sr" id="sgx-lock-live" role="status" aria-live="polite"></p>' +
    '</div>' +
    '<p class="sgx-lock-tail" translate="no"><span aria-hidden="true">~/styrigx<span class="sgx-lock-tcur"></span></span>' + langBtns + '</p>' +
    '</div>';
  document.body.appendChild(ov);
  document.body.classList.add('sgx-locked');
  /* 守卫先盖的遮罩（lock-guard.js showLockCover）：锁屏已经画上，撤掉 */
  const cover = document.getElementById('sgx-lock-cover');
  if (cover && cover.parentNode) cover.parentNode.removeChild(cover);
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  const $ = function (/** @type {string} */ id) { return document.getElementById(id); };
  const input = /** @type {HTMLInputElement} */ ($('sgx-lock-cmd'));
  const form = /** @type {HTMLFormElement} */ ($('sgx-lock-form'));
  const pmu = /** @type {HTMLInputElement} */ ($('sgx-lock-pmu'));
  const logEl = /** @type {HTMLElement} */ ($('sgx-lock-log'));
  const psEl = /** @type {HTMLElement} */ ($('sgx-lock-ps'));
  const hintEl = /** @type {HTMLElement} */ ($('sgx-lock-hint'));
  const hintTx = /** @type {HTMLElement} */ ($('sgx-lock-hint-tx'));
  const live = /** @type {HTMLElement} */ ($('sgx-lock-live'));
  const termEl = /** @type {HTMLElement} */ ($('sgx-lock-term'));
  const stage = /** @type {HTMLElement} */ ($('sgx-lock-stage'));

  /* ---------- 终端输出 ---------- */
  const TERM_ST = { locked: 'LOCKED', sudo: 'SUDO', verifying: 'VERIFYING', denied: 'DENIED', unlocked: 'UNLOCKED' };
  const P_CMD = '<span class="sgx-lock-pp">styrigx@space</span><span class="sgx-lock-pd">:~$</span> ';
  /** @type {string[]} */ let liveBuf = [];
  let liveTimer = 0;
  /** 读屏：同一轮打印的几行合成一句播报 @param {string} t */
  function announce(t) {
    if (!t) return;
    liveBuf.push(t);
    if (liveTimer) return;
    liveTimer = window.setTimeout(function () {
      liveTimer = 0;
      live.textContent = liveBuf.join(' ');
      liveBuf = [];
    }, 30);
  }
  /**
   * 打印一行。
   * @param {string} html 行内容（已转义）
   * @param {string} [cls] 行样式：lm 次要 / ld 注释 / lbad 出错 / lok 通过
   * @param {string|false} [sr] 读屏文字（默认取行的纯文字；false 不播报）
   * @returns {HTMLElement}
   */
  function out(html, cls, sr) {
    const d = document.createElement('div');
    if (cls) d.className = cls.split(' ').map(function (c) { return 'sgx-lock-' + c; }).join(' ');
    d.innerHTML = html;
    logEl.appendChild(d);
    while (logEl.childNodes.length > 80) logEl.removeChild(/** @type {Node} */ (logEl.firstChild));
    if (sr !== false) announce(typeof sr === 'string' ? sr : (d.textContent || ''));
    return d;
  }
  /** 出错：`✗ permission denied · …`，状态胶囊变 DENIED @param {string} msg */
  function deny(msg) {
    out('✗ permission denied' + (msg ? ' · ' + esc(msg) : ''), 'lbad');
    chip('denied');
  }
  /** 行内提示（不是验证失败）：`✗ …` @param {string} msg */
  function warn(msg) { out('✗ ' + esc(msg), 'lbad'); }
  function boot() {
    logEl.textContent = '';
    out('styrigx space os 1.0 tty1', 'ld', false);
    const g = document.createElement('div');
    g.className = 'sgx-lock-lgap';
    logEl.appendChild(g);
  }
  /** @param {string} st */
  function chip(st) {
    const c = $('sgx-lock-st');
    const t = $('sgx-lock-st-tx');
    if (c) c.setAttribute('data-st', st);
    if (t) t.textContent = '$ STATUS: ' + (TERM_ST[/** @type {keyof typeof TERM_ST} */ (st)] || 'LOCKED');
    const tty = $('sgx-lock-tty');
    if (tty) tty.textContent = st === 'unlocked' ? termUser : 'guest';
  }

  /* ---------- 输入行状态 ----------
     cmd 敲命令 · man 手册（man space，按 q 退出） · pw 解锁密码 · temp 临时钥匙 · rkey 重置：进站凭证 · rpick 重置：选锁屏凭证 · rpw 重置：解锁密码 · busy 等服务端 / 系统窗口 · done 已解锁 */
  /** @type {'cmd'|'man'|'pw'|'temp'|'rkey'|'rpick'|'rpw'|'busy'|'done'} */ let mode = 'cmd';
  /** 当前快捷键高亮（password / passkey） */
  let keyOn = '';
  const SECRET = { pw: 1, temp: 1, rkey: 1, rpw: 1 };
  /** @param {string} m */
  function promptHtml(m) {
    if (m === 'pw' || m === 'rpw') return '[sudo] password for ' + esc(termUser) + ': ';
    if (m === 'temp') return 'tempkey: ';
    if (m === 'rkey') return 'spacekey: ';
    if (m === 'rpick') return esc(tx('lockTermPick')) + ' [' + rOpts.map(function (_, i) { return i + 1; }).join('/') + ']: ';
    if (m === 'man') return ':';
    return P_CMD;
  }
  function syncTitle() {
    const el = $('sgx-lock-title');
    if (el) el.textContent = mode === 'cmd' || mode === 'man' || mode === 'done' ? tx('lockLockScreen2') : tx('lockUnlockScreen');
  }
  /**
   * 切换输入行。
   * @param {typeof mode} m
   * @param {{focus?: boolean, key?: string}} [o]
   */
  function setMode(m, o) {
    /* 离开冷却那一态：倒计时行收掉（回来时重新画） */
    if (cdLine && m !== mode) { if (cdLine.parentNode) cdLine.parentNode.removeChild(cdLine); cdLine = null; }
    mode = m;
    const secret = Object.prototype.hasOwnProperty.call(SECRET, m);
    form.setAttribute('data-mode', m);
    input.value = '';
    input.readOnly = false;
    input.type = secret ? 'password' : 'text';
    input.setAttribute('autocomplete', m === 'pw' || m === 'rpw' || m === 'rkey' ? 'current-password' : 'off');
    input.setAttribute('inputmode', m === 'rpick' ? 'numeric' : 'text');
    input.setAttribute('aria-label',
      m === 'pw' || m === 'rpw' ? tx('lockPassword') :
      m === 'temp' ? tx('lockTemporaryKey') :
      m === 'rkey' ? tx('rfSpacePh') :
      m === 'rpick' ? tx('rfStep2') : m === 'man' ? tx('lockManQuit') : tx('lockTermCmdAria'));
    pmu.value = m === 'rkey' ? KEY_SPACE : KEY_LOCK;
    psEl.innerHTML = promptHtml(m);
    const hidden = m === 'busy' || m === 'done';
    form.hidden = hidden;
    /* 手册模式：终端输出不限高、快捷键收起（像 less 占满屏） */
    termEl.classList.toggle('is-man', m === 'man');
    input.disabled = hidden;
    /* 输凭证时下面一行注释（设计稿 K3）+ 可点的 Ctrl+C（触屏没有 Ctrl） */
    if (secret || m === 'rpick' || m === 'man') {
      hintTx.textContent = '# ' + (m === 'temp' ? tx('lockFormatXxxxXxxxXxxx') + ' · ' : m === 'rpick' ? '' : m === 'man' ? tx('lockManQuit') + ' · ' : tx('lockTermSecretHint') + ' · ');
      hintEl.hidden = false;
    } else {
      hintEl.hidden = true;
    }
    if (m === 'pw' || m === 'temp' || m === 'rkey' || m === 'rpick' || m === 'rpw') chip('sudo');
    else if (m === 'man') chip('locked');
    else if (m === 'busy') chip('verifying');
    else if (m === 'done') chip('unlocked');
    else if (m === 'cmd') {
      const c = $('sgx-lock-st');
      if (!c || c.getAttribute('data-st') !== 'denied') chip('locked');
    }
    keyOn = o && o.key ? o.key : (m === 'cmd' ? '' : keyOn);
    const ks = ov.querySelectorAll('.sgx-lock-k');
    for (let i = 0; i < ks.length; i++) ks[i].classList.toggle('is-on', !!keyOn && ks[i].getAttribute('data-k') === keyOn);
    syncTitle();
    if (o && o.focus && !hidden) focusInput();
  }
  function focusInput() {
    try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (_) {} }
  }
  /** 回到命令行（出错 / Ctrl+C 之后） */
  function toCmd() {
    rKey = '';
    setMode('cmd', { focus: document.activeElement === input || document.activeElement === document.body });
  }

  /* ---------- 锁屏凭证配置（/api/lock-entry；读取失败按已配置处理） ---------- */
  /** @type {{passkey:boolean, password:boolean}} */ let cfg = { passkey: true, password: true };
  const cfgReady = fetch('/api/lock-entry', { method: 'GET', credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      /* 账号拆分 PR3：lock-entry 只回锁屏自己的 passkey / password */
      if (j && j.ok) cfg = { passkey: !!j.passkey, password: !!j.password };
    }, function () {})
    .then(function () { applyKeys(); return cfg; });
  function pkUsable() { return cfg.passkey && !!window.PublicKeyCredential; }
  function applyKeys() {
    if (done) return;
    const kPw = $('sgx-lock-k-pw');
    const kPk = $('sgx-lock-k-pk');
    if (kPw) kPw.hidden = !cfg.password;
    if (kPk) kPk.hidden = !pkUsable();
    const qh = $('sgx-lock-qh');
    if (qh) qh.hidden = !cfg.password && !pkUsable();
  }

  /* ---------- 命令 ---------- */
  /** @type {string[]} */ const hist = [];
  let histIdx = 0;
  function help() {
    /** @type {Array<[string, string]>} */
    const rows = [];
    if (cfg.password) rows.push(['password', tx('lockTermDescPw')]);
    if (pkUsable()) rows.push(['passkey', tx('lockTermDescPk')]);
    rows.push(['tempkey', tx('lockTermDescTemp')], ['reset', tx('lockTermDescReset')], ['clear', tx('lockTermDescClear')], ['help', tx('lockTermDescHelp')]);
    out(esc(tx('lockTermHelpTitle')), 'lm');
    for (let i = 0; i < rows.length; i++) {
      out('<span class="sgx-lock-hk">' + rows[i][0] + '</span><span class="sgx-lock-lm">' + esc(rows[i][1]) + '</span>', 'lh', rows[i][0] + ' — ' + rows[i][1]);
    }
  }
  /* man space：手册（NAME / SYNOPSIS / COMMANDS，2026-11-08 03:15 Gray）。像 less 一样占住终端，提示符变成 `:`，
     按 q（或 Esc / Ctrl+C / 点「Ctrl+C 返回」）退出：手册整块收掉，回到提示符。 */
  /** @type {HTMLElement|null} */ let manEl = null;
  function manPage() {
    /** @param {string} t */
    const sec = function (t) { return '<div class="sgx-lock-mh">' + t + '</div>'; };
    /** @param {string} k @param {string} d */
    const row = function (k, d) { return '<div class="sgx-lock-lh"><span class="sgx-lock-hk sgx-lock-mk">' + k + '</span><span class="sgx-lock-lm">' + esc(d) + '</span></div>'; };
    /** @param {string} t */
    const ind = function (t) { return '<div class="sgx-lock-mi">' + t + '</div>'; };
    const html =
      '<div class="sgx-lock-ld">SPACE(1)' + '<span class="sgx-lock-mr">' + esc(tx('lockManTitle')) + '</span></div>' +
      sec('NAME') + ind('space — ' + esc(tx('lockManName'))) +
      sec('SYNOPSIS') +
      ind('password | passkey | tempkey | reset | clear | help') +
      ind('sudo spacekey password | passkey') +
      ind('sudo tempkey · man space · cd .. · cd /') +
      sec('COMMANDS') +
      row('password', tx('lockTermDescPw') + ' · pw, sudo') +
      row('passkey', tx('lockTermDescPk') + ' · pk') +
      row('tempkey', tx('lockTermDescTemp') + ' · key') +
      row('reset', tx('lockTermDescReset') + ' · forgot') +
      row('clear', tx('lockTermDescClear') + ' · Ctrl+L') +
      row('help', tx('lockTermDescHelp') + ' · ?, ls') +
      row('cd ..', tx('lockManDescBack') + ' · cd /') +
      '<div class="sgx-lock-ld">(END)</div>';
    manEl = out(html, 'man', 'man space: NAME, SYNOPSIS, COMMANDS. ' + tx('lockManQuit'));
    setMode('man', { focus: document.activeElement === input || document.activeElement === document.body });
    /* 手册整页可见（终端输出平时最多 40vh、顶上裁掉）：从 NAME 开始看 */
    try { manEl.scrollIntoView({ block: 'start' }); } catch (e) {}
  }
  /** 退出手册：收掉整块，回提示符 */
  function quitMan() {
    if (mode !== 'man') return;
    if (manEl && manEl.parentNode) manEl.parentNode.removeChild(manEl);
    manEl = null;
    toCmd();
  }

  /** @param {string} raw */
  function runCmd(raw) {
    const shown = raw.replace(/\s+/g, ' ').trim();
    out(P_CMD + esc(shown), '', shown ? '$ ' + shown : false);
    if (!shown) return;
    if (hist[hist.length - 1] !== shown) hist.push(shown);
    histIdx = hist.length;
    let c = ALIAS[shown.toLowerCase()] || '';
    if (c === 'sudo') c = cfg.password ? 'password' : pkUsable() ? 'passkey' : 'password';
    /* 新命令开始：上一条的 DENIED 撤掉 */
    if (c) chip('locked');
    if (c === 'help') help();
    else if (c === 'man') manPage();
    else if (c === 'back') { /* 命令行里「返回」= 什么都不做（同 Ctrl+C 清掉这一行） */ }
    else if (c === 'clear') boot();
    else if (c === 'password') cmdPassword();
    else if (c === 'passkey') cmdPasskey();
    else if (c === 'tempkey') cmdTemp();
    else if (c === 'reset') cmdReset();
    else out(esc('command not found: ' + shown.split(' ')[0] + ' · try help'), 'lbad');
  }

  /* ---------- 解锁密码 ---------- */
  let pwLockedUntil = 0;
  function cmdPassword() {
    if (!cfg.password) { warn(tx('lockNoPasswordSetYet')); return; }
    setMode('pw', { focus: true, key: 'password' });
    if (Date.now() < pwLockedUntil) cooldown('pw');
  }
  /** @param {string} pw */
  function submitPw(pw) {
    if (Date.now() < pwLockedUntil) return;
    out(promptHtml('pw'), '', false);
    if (!pw) { warn(tx('lockEnterPassword2')); return; }
    busy(true);
    fetch('/api/lock-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', password: pw }),
    })
      /* 区分网络错误（fetch 抛错）/ 服务器错误（非 JSON 响应）/ 业务错误 */
      .then(readJson)
      .then(function (res) {
        busy(false);
        if (mode !== 'pw') return;
        const j = res.j;
        if (!j) { deny(tx('lockServerError')); return; }
        if (j.ok) { unlock('password'); return; }
        if (j.error === 'cooldown') {
          /* retryAfter（秒）：网关无会话总限流给的；没有就是密码输错的 30 秒冷却 */
          pwLockedUntil = Date.now() + (j.retryAfter > 0 ? j.retryAfter * 1000 : 30000);
          deny(tx('lockTooManyAttempts'));
          cooldown('pw');
        } else if (j.error === 'not-set') {
          deny(tx('lockNoPasswordSetYet'));
          toCmd();
        } else if (j.error === 'server') {
          deny(tx('lockServerError'));
        } else {
          deny(tx('lockWrongPassword'));
        }
      })
      .catch(function () {
        busy(false);
        if (mode !== 'pw') return;
        deny(tx('lockNetworkError'));
      });
  }

  /* ---------- 临时钥匙 ---------- */
  let tempLockedUntil = 0;
  function cmdTemp() {
    if (isLocal) {
      /* 本地开发没有后端：直接开锁 */
      unlock('tempkey');
      return;
    }
    setMode('temp', { focus: true, key: '' });
    if (Date.now() < tempLockedUntil) cooldown('temp');
  }
  /** @param {string} raw */
  function submitTemp(raw) {
    if (Date.now() < tempLockedUntil) return;
    out(promptHtml('temp'), '', false);
    const code = raw.trim();
    if (!code) { warn(tx('lockEnterTheTemporaryKey2')); return; }
    busy(true);
    fetch('/api/lock-tempkey-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    })
      .then(readJson)
      .then(function (res) {
        busy(false);
        if (mode !== 'temp') return;
        const j = res.j;
        if (!j) { deny(tx('lockServerError')); return; }
        if (j.ok) { unlock('tempkey'); return; }
        if (j.error === 'cooldown') {
          /* retryAfter（秒）：网关无会话总限流（src/core/anon-limit.js）给的；没有就是临时码自己的 15 分钟锁 */
          tempLockedUntil = Date.now() + (j.retryAfter > 0 ? j.retryAfter * 1000 : 15 * 60000);
          deny(tx('lockTooManyAttempts'));
          cooldown('temp');
        } else if (j.error === 'wrong' || j.error === 'code') {
          deny(tx('lockInvalidOrExpiredKey'));
        } else {
          deny(tx('lockServerError'));
        }
      })
      .catch(function () {
        busy(false);
        if (mode !== 'temp') return;
        deny(tx('lockNetworkError'));
      });
  }

  /**
   * 冷却倒计时：终端里一行 `› N 秒后可再试`（临时钥匙按分钟），走完前输入行只读；Ctrl+C 仍可回命令行。
   * @param {'pw'|'temp'} which
   */
  /** @type {HTMLElement|null} */ let cdLine = null;
  function cooldown(which) {
    const until = which === 'pw' ? pwLockedUntil : tempLockedUntil;
    if (cdLine && cdLine.parentNode) cdLine.parentNode.removeChild(cdLine);
    const line = out('', 'lm lcd', false);
    cdLine = line;
    let first = true;
    input.readOnly = true;
    function tick() {
      const left = until - Date.now();
      if (cdLine !== line) return;
      if (mode !== which || left <= 0) {
        if (line.parentNode) line.parentNode.removeChild(line);
        cdLine = null;
        if (mode === which) input.readOnly = false;
        return;
      }
      const t = which === 'pw' ? tx('lockRetrySec', { n: Math.ceil(left / 1000) }) : tx('lockRetryMin', { n: Math.ceil(left / 60000) });
      line.textContent = '› ' + t;
      if (first) { announce(t); first = false; }
      window.setTimeout(tick, which === 'pw' ? 1000 : 5000);
    }
    tick();
  }

  /** 等服务端时输入行只读（焦点留着，手机键盘不收起） @param {boolean} b */
  let isBusy = false;
  function busy(b) {
    isBusy = b;
    input.readOnly = b;
    form.classList.toggle('is-busy', b);
  }
  /** @param {Response} r */
  function readJson(r) {
    return r.text().then(function (t) {
      let j = null;
      try { j = JSON.parse(t); } catch (e) {}
      return { s: r.status, j: j };
    });
  }

  /* ---------- 通行密钥（设计稿 K4：系统通行密钥窗口盖在终端上，终端显示「等待通行密钥」） ---------- */
  let pkRun = 0;
  function cmdPasskey() {
    if (!pkUsable()) { warn(tx('lockTermPkUnavailable')); return; }
    out('› ' + esc(tx('lockTermWaitPk')), 'lm');
    keyOn = 'passkey';
    setMode('busy', { key: 'passkey' });
    pkAuth(++pkRun);
  }
  /** @param {string} [msg] */
  function pkFailed(msg) {
    deny(msg || tx('pkFailed'));
    toCmd();
  }
  /** @param {number} run */
  function pkAuth(run) {
    /* 服务端回 unknown-key 时要告诉密码管理器删哪一把：这里记下 id */
    let credId = '';
    fetch('/api/lock-passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'challenge', type: 'auth' }),
    })
      .then(function (r) { return r.json(); })
      .then(function (ch) {
        if (run !== pkRun) throw { done: true };
        if (!ch || !ch.ok) throw new Error('challenge');
        /* B1-2：公共函数（30s 超时 + 4 档错误）；锁屏上没有弹层要藏 */
        return getPasskeyAssertion(assertionOptions(ch)).then(function (cred) {
          return { cred: cred, cid: ch.cid };
        });
      })
      .then(function (res) {
        if (run !== pkRun) throw { done: true };
        const cred = res.cred;
        credId = cred.id;
        return fetch('/api/lock-passkey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'auth', cid: res.cid, credential: assertionToJSON(cred) }),
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (run !== pkRun) return;
        if (j && j.ok) {
          unlock('passkey');
        } else {
          /* 服务端不认识这把密钥 → 通知密码管理器删掉 */
          try {
            if (j && j.error === 'unknown-key' && window.PublicKeyCredential &&
                typeof PublicKeyCredential.signalUnknownCredential === 'function') {
              PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: credId }).catch(function () {});
            }
          } catch (e) {}
          pkFailed();
        }
      })
      .catch(function (e) {
        if (e && e.done) return;
        if (run !== pkRun) return;
        if (e && e.kind) pkFailed(passkeyErrorText(e.kind, en));
        else pkFailed();
      });
  }

  /* ---------- 重置登录（「无法登录？」：reset 命令，在终端里一步步问） ----------
     与账号页 /account/reset/ 同一套流程（auth/reset-flow.js 的服务端约定），只是锁屏上画成命令行：
     - 锁屏凭证已设置（或读不到配置，按已设置处理）：进站凭证 → POST /api/lock-reset verify；
       恢复开关有效直接拿到重置锁屏票（sgx-lock-reset）；否则服务端回 needLock → 再验锁屏凭证（锁屏通行密钥 / 解锁密码，
       账号拆分 PR3 起网关不读账号凭证）→ 重置锁屏票 → 去 /security/lock/ 重设解锁方式。
     - 锁屏凭证都没设置（启动站）：视为从零重置——进站凭证 → POST /api/space-auth { purpose:'lock-reset' }
       （重置锁屏票 by=root）→ 同样去 /security/lock/ 设第一把锁屏凭证。
     进站凭证只存在这里的闭包变量 rKey 里（回命令行 / 完成即清空），不进 DOM、不进历史。 */
  let rKey = '';
  let rBootstrap = false;
  /** @type {Array<'password'|'passkey'>} */ let rOpts = [];
  /** @param {string} url @param {any} body */
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(readJson);
  }
  function cmdReset() {
    busy(true);
    cfgReady.then(function () {
      busy(false);
      rBootstrap = !cfg.passkey && !cfg.password;
      out('# ' + esc(tx('rfTitle')) + ' · ' + esc(tx('rfSpaceLead')), 'ld');
      setMode('rkey', { focus: true, key: '' });
    });
  }
  /** @param {string} key */
  function submitResetKey(key) {
    out(promptHtml('rkey'), '', false);
    if (!key) { warn(tx('rfSpaceEmpty')); return; }
    busy(true);
    /** @param {{message: string}} e */
    const fail = function (e) { busy(false); if (mode === 'rkey') deny(e.message); };
    if (rBootstrap) {
      post('/api/space-auth', { key: key, purpose: 'lock-reset' }).then(function (res) {
        if (res.j && res.j.ok) { busy(false); resetDone(); return; }
        if (res.s === 429) fail({ message: tx('lockTooManyAttempts') });
        else if (res.s === 503 || res.s === 500) fail({ message: tx('lockServerError') });
        else fail({ message: tx('lockWrongSpaceCredential') });
      }, function () { fail({ message: tx('lockNetworkError') }); });
      return;
    }
    post('/api/lock-reset', { action: 'verify', spaceKey: key }).then(function (res) {
      if (res.s === 200 && res.j && res.j.ok) {
        busy(false);
        if (!res.j.needLock) { resetDone(); return; }
        rKey = key;
        rOpts = [];
        if (res.j.password) rOpts.push('password');
        if (res.j.passkey && window.PublicKeyCredential) rOpts.push('passkey');
        if (!rOpts.length) {
          out(esc(tx('rfNoLock')), 'lm');
          out('# ' + esc(tx('rfRecover')), 'ld');
          toCmd();
          return;
        }
        resetPick();
        return;
      }
      if (res.s === 429) fail({ message: tx('lockTooManyAttempts') });
      else fail({ message: tx('lockVerificationFailed') });
    }, function () { fail({ message: tx('lockNetworkError') }); });
  }
  function resetPick() {
    out(esc(tx('rfStep2')) + ':', 'lm');
    for (let i = 0; i < rOpts.length; i++) {
      out('&nbsp;&nbsp;<span class="sgx-lock-pp">[' + (i + 1) + ']</span> ' + rOpts[i] +
        ' <span class="sgx-lock-ld">' + esc(rOpts[i] === 'password' ? tx('rfMPassword') : tx('rfMPasskey')) + '</span>', '',
        (i + 1) + ' ' + rOpts[i] + ' — ' + (rOpts[i] === 'password' ? tx('rfMPassword') : tx('rfMPasskey')));
    }
    setMode('rpick', { focus: true, key: '' });
  }
  /** @param {string} raw */
  function submitResetPick(raw) {
    const v = raw.trim().toLowerCase();
    out(promptHtml('rpick') + esc(raw.trim()), '', false);
    const n = parseInt(v, 10);
    const pick = rOpts.indexOf(/** @type {any} */ (v)) >= 0 ? v : (n >= 1 && n <= rOpts.length ? rOpts[n - 1] : '');
    if (pick === 'password') setMode('rpw', { focus: true, key: '' });
    else if (pick === 'passkey') resetPasskey();
    else warn(tx('lockTermPickBad'));
  }
  /** @param {any} proof */
  function resetVerify(proof) {
    return post('/api/lock-reset', { action: 'verify', spaceKey: rKey, lockProof: proof }).then(function (res) {
      if (res.s === 200 && res.j && res.j.ok && !res.j.needLock) return;
      if (res.s === 429) throw { message: tx('lockTooManyAttempts') };
      throw { message: tx('lockVerificationFailed') };
    }, function () { throw { message: tx('lockNetworkError') }; });
  }
  /** @param {string} pw */
  function submitResetPw(pw) {
    out(promptHtml('rpw'), '', false);
    if (!pw) { warn(tx('rfEnterCred')); return; }
    busy(true);
    resetVerify({ type: 'password', password: pw }).then(function () {
      busy(false);
      resetDone();
    }, function (e) {
      busy(false);
      if (mode === 'rpw') deny(e && e.message ? e.message : tx('lockVerificationFailed'));
    });
  }
  function resetPasskey() {
    out('› ' + esc(tx('lockTermWaitPk')), 'lm');
    setMode('busy', { key: '' });
    const run = ++pkRun;
    post('/api/lock-reset', { action: 'challenge' }).then(function (res) {
      const j = res.j;
      if (!j || !j.ok) throw { message: tx('lockFailedToStart') };
      return getPasskeyAssertion(assertionOptions(j)).then(function (cred) {
        return resetVerify({ type: 'passkey', cid: j.cid, credential: assertionToJSON(cred) });
      }, function (err) {
        /* 取消 / 没有匹配钥匙（NotAllowedError）：提示后回到选择，可重新选 */
        if (err && err.kind === 'cancelled') throw { cancelled: true, message: tx('lockCancelledYouCanSelect') };
        if (isPasskeyCancel(err)) throw { cancelled: true, message: passkeyErrorText('nokey', en) };
        throw { message: err && err.kind ? passkeyErrorText(err.kind, en) : tx('lockPasskeyFailed') };
      });
    }, function () { throw { message: tx('lockNetworkError') }; }).then(function () {
      if (run !== pkRun) return;
      resetDone();
    }, function (e) {
      if (run !== pkRun) return;
      const msg = e && e.message ? e.message : tx('lockPasskeyFailed');
      if (e && e.cancelled) warn(msg); else deny(msg);
      setMode('rpick', { focus: true, key: '' });
    });
  }
  function resetDone() {
    rKey = '';
    out('✓ ' + esc(tx('lockTermResetOk')), 'lok');
    out('› ' + esc(tx('lockTermToLockPage')), 'lm');
    setMode('busy', { key: '' });
    /* 跳转到锁屏凭证管理页（重置锁屏票可开此页，仍进不了主页；启动站同样在这里设第一把锁屏凭证） */
    sgxNavigate(langPath('/security/lock/', pageLang()));
  }

  /* ---------- 提交 / 键盘 ---------- */
  function submit() {
    if (isBusy || done) return;
    const v = input.value;
    if (mode === 'man') { quitMan(); return; }
    /* 输凭证 / 重置途中敲 cd .. 或 cd / = 返回（同 Ctrl+C） */
    if (mode !== 'cmd' && BACK_RE.test(v.trim())) { input.value = ''; interrupt(); return; }
    if (mode === 'cmd') { input.value = ''; runCmd(v); }
    else if (mode === 'pw') { input.value = ''; submitPw(v); }
    else if (mode === 'temp') { input.value = ''; submitTemp(v); }
    else if (mode === 'rkey') { input.value = ''; submitResetKey(v); }
    else if (mode === 'rpick') { input.value = ''; submitResetPick(v); }
    else if (mode === 'rpw') { input.value = ''; submitResetPw(v); }
  }
  /** Ctrl+C / Esc：输凭证时回命令行（打印 ^C），命令行里清掉这一行 */
  function interrupt() {
    if (mode === 'man') { quitMan(); return; }
    if (mode === 'busy' || mode === 'done' || isBusy) return;
    out(promptHtml(mode) + (mode === 'cmd' ? esc(input.value) : '') + '^C', '', false);
    input.value = '';
    if (mode !== 'cmd') {
      chip('locked');
      toCmd();
    }
  }
  on(form, 'submit', function (/** @type {Event} */ e) { e.preventDefault(); submit(); });
  on(input, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (mode === 'man') {
      /* 手册里像 less：q / Esc 退出，其他键不进输入行（Ctrl+C 走下面同一个 interrupt） */
      if (e.key === 'q' || e.key === 'Q' || e.key === 'Escape') { e.preventDefault(); quitMan(); return; }
      if (!(e.ctrlKey && e.key.toLowerCase() === 'c') && e.key.length === 1) { e.preventDefault(); return; }
    }
    if (e.key === 'Escape') {
      if (mode !== 'cmd') { e.preventDefault(); interrupt(); }
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') {
        /* 命令行里有选中文字时照常复制 */
        if (mode === 'cmd' && input.selectionStart !== input.selectionEnd) return;
        e.preventDefault();
        interrupt();
        return;
      }
      if (k === 'l' && mode === 'cmd') { e.preventDefault(); boot(); return; }
    }
    if (mode !== 'cmd') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!hist.length) return;
      e.preventDefault();
      histIdx = Math.max(0, Math.min(hist.length, histIdx + (e.key === 'ArrowUp' ? -1 : 1)));
      input.value = hist[histIdx] || '';
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && input.value.trim()) {
      /* Tab 补全（空行时 Tab 照常移焦点，键盘用户能走到快捷键） */
      e.preventDefault();
      const v = input.value.replace(/\s+/g, ' ').replace(/^\s/, '').toLowerCase();
      const hits = COMPLETE.filter(function (c) { return c.indexOf(v) === 0; });
      if (hits.length === 1) input.value = hits[0];
      else if (hits.length > 1) {
        let pre = hits[0];
        for (let i = 1; i < hits.length; i++) while (hits[i].indexOf(pre) !== 0) pre = pre.slice(0, -1);
        if (pre.length > v.length) input.value = pre;
        else out(P_CMD + esc(input.value) + '<br>' + hits.map(esc).join('&nbsp;&nbsp;'), '', hits.join(', '));
      }
    }
  });
  /* 手机软键盘的 keydown 常是 Unidentified：手册里看输入内容，有 q 就退出，别的字清掉 */
  on(input, 'input', function () {
    if (mode !== 'man') return;
    if (/q/i.test(input.value)) quitMan();
    else input.value = '';
  });
  /* 点终端任何地方 = 聚焦输入行（点快捷键 / Ctrl+C 按钮除外） */
  on(termEl, 'click', function (/** @type {MouseEvent} */ e) {
    const t = /** @type {HTMLElement|null} */ (e.target);
    if (t && t.closest && t.closest('button, input')) return;
    if (!form.hidden) focusInput();
  });
  /* 焦点不在输入框时直接打字：转进输入行 */
  on(document, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (done || form.hidden || !document.getElementById('sgx-lock')) return;
    const t = /** @type {HTMLElement|null} */ (e.target);
    if (t === input || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t && t.closest && t.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    if (mode === 'man' && (e.key === 'q' || e.key === 'Q' || e.key === 'Escape')) { e.preventDefault(); quitMan(); focusInput(); return; }
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      focusInput();
      if (mode === 'man') return;
      if (!input.readOnly) input.value += e.key;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      focusInput();
    }
  });
  const cc = $('sgx-lock-cc');
  if (cc) on(cc, 'click', function () { tapFeedback(); interrupt(); focusInput(); });

  /* 快捷键（设计稿「不想打命令？点一下自动输入」）：替你把命令敲进去再回车（输凭证途中点 = 先 Ctrl+C） */
  let typing = false;
  /** @param {string} cmd */
  function typeAndRun(cmd) {
    if (typing || isBusy || done || mode === 'busy') return;
    if (mode !== 'cmd') interrupt();
    typing = true;
    focusInput();
    if (reducedMotion()) {
      input.value = cmd;
      typing = false;
      submit();
      return;
    }
    let i = 0;
    input.value = '';
    (function step() {
      if (mode !== 'cmd' || done) { typing = false; return; }
      i = Math.min(cmd.length, i + 2);
      input.value = cmd.slice(0, i);
      if (i < cmd.length) { window.setTimeout(step, 16); return; }
      typing = false;
      submit();
    })();
  }
  const ks = ov.querySelectorAll('.sgx-lock-k');
  for (let i = 0; i < ks.length; i++) {
    const k = /** @type {HTMLElement} */ (ks[i]);
    on(k, 'click', function (/** @type {Event} */ e) {
      e.stopPropagation();
      tapFeedback();
      typeAndRun(k.getAttribute('data-run') || '');
    });
  }

  /* 底部语言：写偏好（同快捷面板），换到另一种语言的同一页（查询串原样：lock / return 都在） */
  const lbs = ov.querySelectorAll('.sgx-lock-lang');
  for (let i = 0; i < lbs.length; i++) {
    const b = /** @type {HTMLElement} */ (lbs[i]);
    on(b, 'click', function () {
      const l = b.getAttribute('data-lang') || '';
      const url = setLang(/** @type {any} */ (l));
      if (url && url !== location.pathname + location.search + location.hash) location.replace(url);
    });
  }

  /* 手机软键盘：输入行被键盘盖住时整组上移刚好够的距离（不是整块键盘高度，头像可以被顶出去） */
  /** @type {(() => void)|null} */ let kbStop = null;
  on(input, 'focus', function () {
    if (kbStop) return;
    try {
      kbStop = onKeyboardHeight(function (h) {
        try {
          stage.style.transform = '';
          if (!(h > 0)) return;
          const r = termEl.getBoundingClientRect();
          const over = r.bottom + 12 - (window.innerHeight - h);
          if (over > 0) stage.style.transform = 'translateY(' + Math.round(-over) + 'px)';
        } catch (e) {}
      });
    } catch (e) { kbStop = null; }
  });
  on(input, 'blur', function () {
    /* 整个页面失焦（Samsung Pass 自动填充 / 指纹窗口盖上来）不算离开输入框 */
    try { if (!document.hasFocus()) return; } catch (e) {}
    stage.style.transform = '';
    if (kbStop) { try { kbStop(); } catch (e) {} kbStop = null; }
  });

  /* ---------- 解锁 / 会话 ---------- */
  let done = false;
  function cleanup() {
    if (kbStop) { try { kbStop(); } catch (e) {} kbStop = null; }
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.classList.remove('sgx-locked');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    bindAutoLock();
  }
  let granted = false;
  function grantedLines() {
    if (granted) return;
    granted = true;
    /* 读屏只报一句「已解锁」（终端行和开机输出都 aria-hidden） */
    out('✓ access granted', 'lok', tx('lockBootUnlocked'));
    out('› booting space…<span class="sgx-lock-cur"></span>', 'lm', false);
    setMode('done');
  }

  /** 服务端确认有效后：交给模块级 proceed（唯一去处判定） */
  function onServerOk(ans) {
    done = true;
    pkRun++;
    grantedLines();
    /* 这次是在锁屏上亲手解的（unlockVia 有值）→ 先放开机动画，放完（或被跳过）再交给 proceed；
       首帧对账 / 别的标签页解锁（没敲过凭证）不放。只是推迟同一个 proceed，去处和会话判断不变。 */
    if (unlockVia && !reducedMotion()) bootSequence(ans, function () { proceed(ans, doUnlockAnimation); });
    else proceed(ans, doUnlockAnimation);
  }

  /* 解锁成功（密码 / 通行密钥 / 临时钥匙）后：先向服务端确认会话真的生效，再按服务端给的 next 走；
     没确认到 → 停在锁屏显示错误，绝不跳转。 */
  /** 这次解锁用的方式（password / passkey / tempkey）；只在锁屏上真的敲了凭证时有值 */
  let unlockVia = '';
  /** @param {string} via */
  function unlock(via) {
    if (done) return;
    done = true;
    unlockVia = via || '';
    out('› ' + esc(tx('lockVerifying')) + '…', 'lm');
    setMode('busy');
    if (isLocal) {
      /* 本地开发没有后端：原地开锁（开机动画照放，没有会话时长） */
      grantedLines();
      if (!reducedMotion()) bootSequence({ ok: true, by: unlockVia }, doUnlockAnimation);
      else doUnlockAnimation();
      return;
    }
    askServer().then(function (ans) {
      if (ans.ok) onServerOk(ans);
      else sessionCheckFailed();
    });
  }

  /* 锁屏显示期间（用户可能在别的标签页解锁了）：visibilitychange（visible）、focus、pageshow 时对账，
     节流 1 秒。ok → proceed；401/网络失败 → 保持锁屏（fail closed）。 */
  let lastRecheck = 0;
  function recheckSession() {
    if (done || isLocal) return;
    const now = Date.now();
    if (now - lastRecheck < 1000) return;
    lastRecheck = now;
    askServer().then(function (ans) {
      if (!done && ans.ok) onServerOk(ans);
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') recheckSession();
  });
  window.addEventListener('focus', recheckSession);
  window.addEventListener('pageshow', function (e) {
    if (e && e.persisted) recheckSession();
  });

  /* 会话没生效：停在锁屏，终端里报错，回命令行（允许重试），不跳转 */
  function sessionCheckFailed() {
    done = false;
    deny(tx('lockSessionNotRecognized'));
    toCmd();
  }

  /* ---------- 开机动画（2026-11-08 Gray：「解锁后来一段加载动画」；设计稿 entry-v2/boot.html?from=1） ----------
     全屏底色（跟主题 --sgx-bg-1）+ 块光标，逐行打印：系统行 → 验证方式与会话时长（接口真实值）→ 挂载四站 → gray-ai → welcome back。
     节奏照稿：首行 260ms，之后每行 190ms，末行后 520ms 再交出去（淡入主页在 doUnlockAnimation）。
     输出 aria-hidden；按任意键 / 点击跳过（直接打完、立刻交出去）。减少动态效果时不放（onServerOk 判断）。 */
  /** @type {HTMLElement|null} */ let bootEl = null;
  /**
   * @param {{by?:string, exp?:number}} ans 服务端回答（by 进门方式、exp 会话到期毫秒）
   * @param {() => void} then 放完 / 跳过后
   */
  function bootSequence(ans, then) {
    const by = String(ans.by || unlockVia || '');
    let sess = '';
    const left = Number(ans.exp || 0) - Date.now();
    /* 时钟不可信（差出一个月以上）就不写时长，不编数 */
    if (left > 0 && left < 31 * 864e5) {
      sess = left >= 36e5 ? Math.round(left / 36e5) + 'h' : Math.max(1, Math.ceil(left / 6e4)) + 'm';
    }
    const ver = (by === 'tempkey' ? 'tempkey verified' : 'LockKey verified' + (by === 'password' || by === 'passkey' ? ' (' + by + ')' : '')) +
      (sess ? ' · session ' + sess : '');
    const OK = ' <span class="sgx-lock-bok">ok</span>';
    /** @type {string[]} */
    const lines = [
      '<span class="sgx-lock-bh">&gt; styrigx space os — styrigx@space</span>',
      '<span class="sgx-lock-bok">&gt; ' + esc(ver) + '</span>',
      '&gt; mounting /space/blog ...' + OK,
      '&gt; mounting /space/curio ...' + OK,
      '&gt; mounting /space/daymark ...' + OK,
      '&gt; mounting /space/wild ...' + OK,
      '&gt; loading gray-ai ...' + OK,
      '&gt; welcome back, ' + esc(termUser) + '_',
    ];
    const el = document.createElement('div');
    el.id = 'sgx-lock-boot';
    el.className = 'sgx-lock-boot';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="sgx-lock-bout" id="sgx-lock-bout"><span class="sgx-lock-cur"></span></div>';
    ov.appendChild(el);
    bootEl = el;
    const outEl = /** @type {HTMLElement} */ (el.firstChild);
    /* 输入行已收起（mode done）；焦点从锁屏里撤出来，手机键盘收起 */
    try { if (document.activeElement && ov.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur(); } catch (e) {}
    requestAnimationFrame(function () { el.classList.add('is-on'); });
    let n = 0;
    let timer = 0;
    let finished = false;
    /** @param {number} k */
    function render(k) {
      outEl.innerHTML = lines.slice(0, k).map(function (l) { return '<div>' + l + '</div>'; }).join('') + '<span class="sgx-lock-cur"></span>';
      el.setAttribute('data-lines', String(k));
    }
    function finish() {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      document.removeEventListener('keydown', skip, true);
      document.removeEventListener('pointerdown', skip, true);
      then();
    }
    /** @param {Event} e */
    function skip(e) {
      if (finished) return;
      try { e.preventDefault(); e.stopPropagation(); } catch (x) {}
      window.clearTimeout(timer);
      render(lines.length);
      finish();
    }
    document.addEventListener('keydown', skip, true);
    document.addEventListener('pointerdown', skip, true);
    function step() {
      render(++n);
      timer = window.setTimeout(n < lines.length ? step : finish, n < lines.length ? 190 : 520);
    }
    timer = window.setTimeout(step, 260);
  }

  /* 开锁动画：显示桌面 */
  function doUnlockAnimation() {
    grantedLines();
    if (bootEl && !reducedMotion()) {
      /* 放过开机动画：开机层连同锁屏一起淡出，主页从 96% 缩放回 100% */
      document.body.classList.remove('sgx-locked');
      ov.classList.add('sgx-lock-booted');
      window.setTimeout(cleanup, 520);
      return;
    }
    if (reducedMotion()) {
      ov.style.transition = 'opacity .25s ease';
      ov.style.opacity = '0';
      window.setTimeout(cleanup, 280);
    } else {
      document.body.classList.remove('sgx-locked');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          ov.classList.add('sgx-lock-out');
        });
      });
      window.setTimeout(cleanup, 450);
    }
  }

  /* ---------- 开机 ---------- */
  boot();
  setMode('cmd');
  /* 电脑上直接把光标放进命令行；触屏不自动聚焦（不一进来就弹键盘） */
  try {
    if (!window.matchMedia('(pointer: coarse)').matches) focusInput();
  } catch (e) {}

  /* 首帧对账：页面是 locked 或根本没有会话标记（unknown）时立刻问服务端。
     服务端说有效 → 直接按 next 走，不让用户对着一个本来有效的会话再解一次锁（2026-10-21）。 */
  if (!isLocal) {
    askServer().then(function (ans) {
      if (!done && ans.ok) {
        try { console.warn('[sgx-lock] page said ' + pageState() + ' but lock-session-check ok'); } catch (e) {}
        onServerOk(ans);
      }
    });
  }
}
