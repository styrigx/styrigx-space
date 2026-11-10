/**
 * @fileoverview 盾牌下拉 + 命令行（提示符 styrigx@space:~#，进站 v3 L1，SPACE-V3 §2.2 C、Q3 定稿 08:00）。顶栏盾牌点开，四站同一个。
 *
 * 头部：已进站（方式 · 剩余 h:mm）；有 reauth 时右边 `reauth · m:ss`。
 * 行（点进去是一层，左上 ‹ 返回）：
 * - 进站凭证 ›（reauth）：解锁密码（设 / 改 / 删）· 通行密钥（改名 / 删 / 添加）· 所有设备回锁屏（reauth，Q5）——keys.js
 * - 临时钥匙 ›（新建 / 列表 / 作废都 reauth）——tempkeys.js
 * - 分享链接 ›（管理页一律 reauth；新建本身只要进站会话，快捷面板「分享本页」不验证）——links.js
 * - 立即锁屏：不验证，只锁本机 —— lock-now.js
 * 没有 reauth 时点要验证的行：命令行自动跑 `sudo styrigx reauth`，通过后进那一层（reauth.js）。reauth 只认解锁密码 / 通行密钥。
 * 命令：help · clear · sudo styrigx reauth [passkey|password] · lock（= 立即锁屏）· exit（关下拉）；进站凭证层里另有 passwd、passkey add。
 * 没有弹层：原安全页、门口验证行、底部复验弹层、立即锁屏确认层都删了（Gray C）。
 * 样式复用账号下拉的 .sgx-pop* / .sgx-at*（外壳同一套，只是文案和命令不同）。后端只经 api.js；文案在外壳字符串表 space.*。
 */
import * as api from './api.js';
import { createTerm, shellTable } from './term.js';
import { completerOf } from '../term/core/complete.js';
import { TTY3_TABLE } from '../term/cmds/index-tty3.js';
import { suggest } from '../suggest.js';
import { CMD, PS_ADMIN, SHIELD_LAYERS, REAUTH_LAYERS, normCmd, parseShieldCmd, shieldLayerFrom, hmm, mmss } from './commands.js';
import { mountVerify } from './session.js';
import { mountReauth } from './reauth.js';
import { mountKeys } from './keys.js';
import { mountTempkeys } from './tempkeys.js';
import { mountLinks } from './links.js';
import { lockNow } from './lock-now.js';
import { profileDefaults, readCache, effectiveProfile } from '../../lib/profile.js';
import { esc } from '../../lib/util.js';

export { shieldLayerFrom };

/**
 * 挂到 #sgx-sec 上（topbar-panel.js 第一次打开时调）。
 * @param {{ dlg: HTMLDialogElement, ms: any, replace: (href: string) => void }} o
 */
export function mountShield(o) {
  const dlg = o.dlg;
  const doc = dlg.ownerDocument || document;
  const t = shellTable(doc, 'space');
  /** @param {string} k @param {Record<string, string|number>} v */
  const tf = function (k, v) { let s = t(k); for (const n in v) s = s.split('{' + n + '}').join(String(v[n])); return s; };
  const sheet = /** @type {HTMLElement} */ (dlg.querySelector('.sgx-qp-sheet'));

  /* ---------- 骨架（同账号下拉 shell/account/term.js） ---------- */
  sheet.innerHTML = '';
  const root = doc.createElement('div');
  root.className = 'sgx-at sgx-sh';
  root.innerHTML =
    '<div class="sgx-at-head" data-sh-head></div>' +
    '<div class="sgx-at-view" data-sh-view></div>' +
    '<div class="sgx-at-term" data-sh-term>' +
    '<div class="sgx-at-log" data-sh-log data-term-log aria-hidden="true"></div>' +
    '<form class="sgx-at-line" data-sh-form autocomplete="off" novalidate>' +
    '<input type="text" class="sgx-at-pmu" data-sh-pmu autocomplete="username" tabindex="-1" aria-hidden="true" value="' + esc(api.PM_USER.password) + '">' +
    '<label class="sgx-at-ps" for="sgx-sh-in" data-sh-ps translate="no"></label>' +
    '<input id="sgx-sh-in" class="sgx-at-in" data-sh-in type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">' +
    '</form>' +
    '<p class="sgx-at-hint" data-sh-hint hidden></p>' +
    '<p class="sgx-kh sgx-at-kh" data-sh-kh hidden></p>' +
    '<div class="sgx-at-live" data-sh-live role="status" aria-live="polite"></div>' +
    '</div>' +
    '<div class="sgx-at-ft" data-sh-ft></div>';
  sheet.appendChild(root);
  /** @param {string} a */
  const q = function (a) { return /** @type {HTMLElement} */ (root.querySelector('[' + a + ']')); };
  const headEl = q('data-sh-head');
  const viewEl = q('data-sh-view');
  const ftEl = q('data-sh-ft');

  /* let + 先 null：createTerm 里会先画一次按键提示行（kh.cmdKey 读 C），const 在那一刻还在暂时性死区 */
  /** @type {any} */
  let C = null;
  C = createTerm({
    dom: {
      root: q('data-sh-term'),
      log: q('data-sh-log'),
      form: /** @type {HTMLFormElement} */ (q('data-sh-form')),
      input: /** @type {HTMLInputElement} */ (q('data-sh-in')),
      ps: q('data-sh-ps'),
      pmu: /** @type {HTMLInputElement} */ (q('data-sh-pmu')),
      hint: q('data-sh-hint'),
      live: q('data-sh-live'),
      kh: q('data-sh-kh'),
    },
    p: 'sgx-at',
    /* 按键提示行：首层 esc 关下拉、下一层 esc 回首层；触屏「‹ 返回」走同一条路（escBack，最外层关下拉） */
    kh: {
      cmdKey: function () { return C && C.layer && C.layer !== 'home' ? 'cmdLayer' : 'cmd'; },
      canBackCmd: function () { return true; },
      onBack: function () { if (!escBack()) o.ms.close(); },
    },
    t: t,
    ps: function () { return PS_ADMIN; },
    ariaCmd: t('shield.cmdAria'),
    isShown: function () { return o.ms.isShown(); },
    onCmd: function (raw) { runCmd(raw); },
    /* tty3：Tab 补全 + 历史落 sessionStorage（终端统一 T4） */
    complete: completerOf(TTY3_TABLE),
    histKey: 'sgx-term-hist-3',
    onReveal: reveal,
    onMode: function (m) { root.setAttribute('data-sh-mode', m); },
  });
  Object.assign(C, {
    o: o, doc: doc, dlg: dlg, root: root, viewEl: viewEl, api: api, tf: tf,
    layer: 'home',
    /** 进站凭证配置 {password, passkey}（/api/lock-reauth status 顺带给）；null = 没读到（按都设了） */
    cfg: null,
    /** 进站会话 {by, exp}；null = 没读到 */
    sess: null,
    /** reauth 票到期（毫秒；0 = 没有） */
    reauthExp: 0,
    /** 两步确认中的那一项 */
    armed: '',
  });
  C.who = function () { return effectiveProfile(readCache(), profileDefaults()).name; };

  /**
   * 新行滚进下拉自己的滚动区（不用 scrollIntoView：三星「桌面版网站」放大时整页会平移，同 shell/account/term.js）。
   * @param {HTMLElement} el
   */
  function reveal(el) {
    try {
      for (let p = el.parentElement; p; p = p === dlg ? null : p.parentElement) {
        if (p.scrollHeight <= p.clientHeight || !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) continue;
        const pr = p.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.bottom > pr.bottom) p.scrollTop += r.bottom - pr.bottom;
        else if (r.top < pr.top) p.scrollTop -= pr.top - r.top;
        return;
      }
    } catch (e) {}
  }

  /* ---------- 头部 / 页脚 / 行（写法同账号下拉） ---------- */
  C.reauthLeft = function () { return C.reauthExp > Date.now() ? C.reauthExp - Date.now() : 0; };
  /** 主页头部：$ SECURITY · 右边 reauth 倒计时 */
  C.barHead = function () {
    const r = C.reauthLeft();
    headEl.innerHTML = '<div class="sgx-nav-h sgx-at-bar"><span translate="no"><b aria-hidden="true">$</b> SECURITY</span>' +
      '<span translate="no" class="sgx-at-hv"' + (r ? ' data-live' : '') + ' data-sh-cd>' + esc(r ? 'reauth · ' + mmss(r) : '') + '</span></div>';
  };
  /** 层头部：‹ 标题 · 右边路径 / reauth 倒计时 @param {string} title */
  C.subHead = function (title) {
    const r = C.reauthLeft();
    headEl.innerHTML = '<button type="button" class="sgx-at-bk" data-sh-back aria-label="' + esc(t('common.backAria')) + '">‹</button><h2 class="sgx-at-h">' + esc(title) + '</h2>' +
      '<span class="sgx-at-hv"' + (r ? ' data-live' : '') + ' data-sh-cd translate="no">' + esc(r ? 'reauth · ' + mmss(r) : 'locked') + '</span>';
  };
  /** @param {string} key */
  C.foot = function (key) { ftEl.textContent = key ? t(key) : ''; ftEl.hidden = !key; };
  /** 行 @param {{k: string, v?: string, sub?: string, act?: string, cls?: string, chev?: boolean, armed?: boolean, kHtml?: string, vHtml?: string, attrs?: string}} r */
  C.row = function (r) {
    const tag = r.act ? 'button type="button"' : 'div';
    const end = r.act ? 'button' : 'div';
    return '<' + tag + ' class="sgx-pop-row sgx-at-r' + (r.cls ? ' ' + r.cls : '') + '"' + (r.act ? ' data-sh-act="' + esc(r.act) + '"' : '') + (r.armed ? ' data-armed' : '') + (r.attrs || '') + '>' +
      '<span class="sgx-at-k"><span class="sgx-pop-k">' + (r.kHtml || esc(r.k)) + '</span>' + (r.sub ? '<small>' + esc(r.sub) + '</small>' : '') + '</span>' +
      '<span class="sgx-pop-v">' + (r.vHtml != null ? r.vHtml : esc(r.v || '')) + '</span>' + (r.chev ? '<span class="sgx-pop-chev" aria-hidden="true">›</span>' : '') +
      '</' + end + '>';
  };
  /** @param {string} txt @param {boolean} [line] */
  C.grp = function (txt, line) { return '<p class="sgx-pop-g' + (line ? ' sgx-pop-g--line' : '') + '">' + esc(txt) + '</p>'; };
  /** @param {string} txt */
  C.noteP = function (txt) { return '<p class="sgx-at-note">' + esc(txt) + '</p>'; };

  /** 服务端说没会话 / 票过期：401 session → 回锁屏；403 / 401 reauth → 回主页重新验证 @param {{s:number, j:any}} res @returns {boolean} */
  C.authErr = function (res) {
    if (api.isErr(res, api.ERR.session) || (res && res.s === 401 && !(res.j && res.j.error))) {
      C.err(t('common.sessExp'));
      o.ms.close(function () { o.replace('/?entry=1'); });
      return true;
    }
    if (api.isErr(res, api.ERR.reauth)) {
      C.reauthExp = 0;
      C.err(t('reauth.expired'), CMD.reauth);
      C.layer = 'home';
      C.render();
      return true;
    }
    return false;
  };

  /** 关下拉 / reauth 到期时收掉页面上的明文（临时钥匙码）；各层往上叠 */
  C.dropSecrets = function () {};
  mountVerify(C);
  mountReauth(C);
  mountKeys(C);
  mountTempkeys(C);
  mountLinks(C);

  /* ---------- 主页 ---------- */
  C.renderHome = function () {
    C.barHead();
    const s = C.sess;
    const by = s && s.by ? t('shield.by.' + s.by) || s.by : '';
    const left = s && s.exp ? hmm(s.exp - Date.now()) : '';
    const lockedV = C.reauthLeft() ? '' : 'reauth';
    viewEl.innerHTML =
      '<div class="sgx-pop-list">' +
      C.row({ k: t('shield.session'), v: [by, left ? tf('shield.left', { t: left }) : ''].filter(Boolean).join(' · ') || t('shield.in') }) +
      C.grp(t('shield.keysGroup'), true) +
      C.row({ k: t('keys.title'), v: lockedV || t('keys.hint'), act: 'keys', chev: true }) +
      C.row({ k: t('tempkeys.title'), v: lockedV || t('tempkeys.hint'), act: 'tempkeys', chev: true }) +
      C.row({ k: t('links.title'), v: lockedV || t('links.hint'), act: 'links', chev: true }) +
      '</div><div class="sgx-pop-list sgx-pop-list--line">' +
      C.row({ k: t('shield.lockNow'), v: 'lock', act: 'lock', cls: 'sgx-pop-row--acc' }) +
      '</div>';
    C.foot('shield.ft');
  };

  C.render = function () {
    root.setAttribute('data-sh-layer', C.layer);
    if (C.layer === 'keys') return C.renderKeys();
    if (C.layer === 'tempkeys') return C.renderTempkeys();
    if (C.layer === 'links') return C.renderLinks();
    C.renderHome();
  };

  /**
   * 进一层：要 reauth 的层没有 reauth → 命令行自动跑 sudo styrigx reauth，通过后进层（Q3 / Q4）
   * @param {string} to
   */
  C.go = function (to) {
    if (SHIELD_LAYERS.indexOf(to) === -1) to = 'home';
    C.armed = '';
    if (REAUTH_LAYERS.indexOf(to) !== -1 && !C.reauthLeft()) {
      C.withReauth(function () { C.go(to); }, t('reauth.lead.' + to));
      return;
    }
    C.layer = to;
    C.clearLog();
    C.toCmd();
    C.render();
    if (to === 'keys') C.enterKeys();
    if (to === 'tempkeys') C.enterTempkeys();
    if (to === 'links') C.enterLinks();
    keepFocus();
  };
  function keepFocus() {
    const ae = doc.activeElement;
    if (ae && ae !== doc.body && dlg.contains(ae) && ae.isConnected) return;
    C.focusIn();
    if (!dlg.contains(doc.activeElement)) { try { sheet.focus({ preventScroll: true }); } catch (e) {} }
  }

  /* ---------- 命令 ---------- */
  function help() {
    C.out('<span class="sgx-at-w">' + esc(CMD.reauth) + '</span> — ' + esc(t('help.reauth')) + ' · <span class="sgx-at-dim">passkey / password</span>');
    C.out('<span class="sgx-at-w">lock</span> — ' + esc(t('help.lock')) + ' · <span class="sgx-at-w">exit</span> — ' + esc(t('help.exit')) + ' · <span class="sgx-at-w">clear</span> — ' + esc(t('help.clear')));
    if (C.layer === 'keys') C.out('<span class="sgx-at-w">passwd</span> · <span class="sgx-at-w">passkey add</span> — ' + esc(t('help.keys')));
    C.note(t('help.shieldNote'));
  }
  /** @param {string} raw */
  function runCmd(raw) {
    const line = normCmd(raw);
    if (!line) return;
    C.echo(raw.trim());
    /* sub-*（代理订阅 P2）：转到账号终端（tty5）去跑（来源名大小写敏感，传原样的一行；topbar-panel 收 sgx-acct-run） */
    if (/^sub(-[a-z]+)?(\s|$)/.test(line)) {
      C.out('<span class="sgx-at-dim">→</span> <span class="sgx-at-y" translate="no">~/account</span>');
      doc.dispatchEvent(new CustomEvent('sgx-acct-run', { detail: raw.trim() }));
      return;
    }
    const c = parseShieldCmd(line);
    switch (c.cmd) {
      case 'help': help(); return;
      case 'clear': C.clearLog(); return;
      case 'reauth': C.cmdReauth(c.arg || '', null, t('reauth.lead.cmd')); return;
      case 'lock': C.lock(); return;
      case 'exit': o.ms.close(); return;
      case 'passwd': if (C.layer === 'keys') { C.cmdPasswd(true); return; } break;
      case 'passkey-add': if (C.layer === 'keys') { C.cmdPasskeyAdd(true); return; } break;
      default: break;
    }
    if (c.cmd === 'passwd' || c.cmd === 'passkey-add') { C.note(t('keys.onlyInLayer')); return; }
    /* 打错了：给最近的真命令（Gray 2026-11-09） */
    const sg = suggest(normCmd(raw), ['help', 'clear', CMD.reauth, 'lock', 'exit', 'passwd', 'passkey add']);
    if (sg) C.err(tf('common.didYouMean', { c: raw.trim().split(' ')[0] }), sg);
    else C.err(tf('common.notFound', { x: raw.trim().split(' ')[0] }));
  }

  /** 立即锁屏（行 / lock 命令）：不验证，只锁本机（Gray 08:03） */
  C.lock = function () {
    C.setMode('busy');
    lockNow(api).then(function (ok) {
      if (ok) { o.ms.close(function () { o.replace('/?entry=1'); }); return; }
      C.err(t('shield.lockFail'));
      C.toCmd();
    });
  };

  /* ---------- 事件 ---------- */
  /* esc：先退出当前命令，再撤两步确认，再回主页，最外层才交给下拉关掉 */
  /** esc / 触屏「‹ 返回」的同一条路：吃掉了回 true；最外层回 false（交给下拉关掉） */
  function escBack() {
    if (C.interrupt()) return true;
    if (C.armed || C.editing) { C.armed = ''; C.editing = ''; C.render(); return true; }
    if (C.layer !== 'home') { C.go('home'); return true; }
    return false;
  }
  dlg.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (escBack()) e.preventDefault();
  });
  root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    if (!tg || !tg.closest) return;
    if (tg.closest('[data-sh-back]')) { C.go('home'); return; }
    const a = /** @type {HTMLElement|null} */ (tg.closest('[data-sh-act]'));
    if (!a) return;
    e.preventDefault();
    act(a.getAttribute('data-sh-act') || '');
    keepFocus();
  });
  /** @param {string} a */
  function act(a) {
    if (SHIELD_LAYERS.indexOf(a) !== -1) {
      if (REAUTH_LAYERS.indexOf(a) !== -1 && !C.reauthLeft()) C.echo(CMD.reauth);
      C.go(a);
      return;
    }
    if (a === 'lock') { C.echo('lock'); C.lock(); return; }
    if (C.actKeys(a) || C.actTempkeys(a) || C.actLinks(a)) return;
  }
  try { window.addEventListener('pagehide', function () { C.endReauth(); }); } catch (e) {}

  /* ---------- 开 / 关 ---------- */
  /** 打开（topbar-panel 的 onOpen）。x.layer：旧地址 #sec=<层> / 页面入口要直接进的那一层 @param {{layer?: string}} [x] */
  function onOpen(x) {
    const want = shieldLayerFrom((x && x.layer) || '');
    C.clearLog();
    C.toCmd();
    C.layer = 'home';
    C.render();
    Promise.all([C.loadReauth(), api.sessionInfo()]).then(function (r) {
      C.sess = r[1];
      if (!C.sess && r[0] === 'session') { C.authErr({ s: 401, j: { error: 'session' } }); return; }
      C.render();
      if (C.reauthLeft()) C.startTick();
      if (want !== 'home') {
        if (!C.reauthLeft()) C.echo(CMD.reauth);
        C.go(want);
        return;
      }
      if (!C.root.querySelector('[data-sh-log]').childNodes.length) C.note(t('shield.typeHelp'), 'help');
    });
  }
  function onClose() {
    C.stopTick();
    C.armed = '';
    C.editing = '';
    C.dropSecrets();
    C.endReauth();
  }
  return { onOpen: onOpen, onClose: onClose, _state: function () { return { layer: C.layer, mode: C.mode, reauth: C.reauthLeft() > 0 }; } };
}
