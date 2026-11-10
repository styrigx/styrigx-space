/**
 * @fileoverview 账号窗口（头像下拉 #sgx-acct）+ 终端里的账号层（v5 S5 终端合一：原账号下拉自带的终端 tty5 并进同一个终端）。
 *
 * 两件事，同一个上下文 C（以终端输入行为原型，shell/term/view/layer-ctx.js）：
 * - 终端里的账号命令（shell/term/cmds/acct、keys/sudo.js 的 sudo root …、sub-*）调这里挂在 C 上的流程：sudo root（session.js）、sudo root reauth（reauth.js）、
 *   sudo root reset（reset.js，reset@account:~#）、passwd / passkey（keys.js）、device（devices.js）、app + 奇趣 / 日刻授权同意（grants.js）、sub-*（proxy.js）、exit。
 *   要输入、选择、验证的都在终端里原地做完（Gray 15:22「只有 GUI 跳终端，终端不跳 GUI」）。
 * - 账号窗口（GUI）：已登录时的总览（头像 / 名字 · 个人资料 › · 设备 · 账号安全 · 应用授权 · 退出登录）和个人资料编辑（profile.js，纯 GUI）。
 *   设备 / 账号安全 / 应用授权 / 退出登录点了 = 跳终端跑对应命令（device / passkey / app / exit）；没登录时点头像 = 跳终端跑 sudo root。
 *
 * 只 import lib/、auth/、shell/（check-layers 规则 3）。文案在外壳字符串表 account.*（sgx-shell-i18n），四个站同一份。
 */
import { esc } from '../../lib/util.js';
import { toast } from '../../lib/toast.js';
import { flatStrings } from '../term/core/strings.js';
import { layerCtx } from '../term/view/layer-ctx.js';
import * as api from './api.js';
import { CMD, layerFromPath } from './commands.js';
import { mountSession } from './session.js';
import { mountReauth } from './reauth.js';
import { mountReset } from './reset.js';
import { mountKeys } from './keys.js';
import { mountDevices } from './devices.js';
import { mountGrants } from './grants.js';
import { mountProfile } from './profile.js';
import { mountProxy } from './proxy.js';

/** 嵌套字符串表 → 点号键：终端统一 T1 起在 shell/term/core/strings.js，这里转出 */
export { flatStrings };

/** 登录标记 cookie（账号 Worker 随 session 签发 / 清除，workers/account/src/core/config.js SIGNED_IN_MARKER）：只给首帧画提示符，鉴权只认 HttpOnly 的 session */
export const SIGNED_IN_COOKIE = 'sgx-account-signed-in';

/**
 * 首帧登录态：有登录标记 → 'in'，没有 → 'guest'（读不到 cookie → ''，等接口）。不是鉴权，GET /api/account 回来后校正。
 * @param {string} cookieStr document.cookie
 * @returns {'in'|'guest'|''}
 */
export function firstFrameState(cookieStr) {
  if (typeof cookieStr !== 'string') return '';
  const on = cookieStr.split(';').some(function (p) { return p.trim() === SIGNED_IN_COOKIE + '=1'; });
  return on ? 'in' : 'guest';
}

/**
 * 按接口结果校正登录标记（只是显示用的提示）：没有 session 就清掉；有 session 但没标记（这次改动前登录的设备）就补上，时长到 session 到期。
 * @param {Document} doc @param {any} s api.status() 的结果
 */
export function correctSignedInMarker(doc, s) {
  try {
    const has = firstFrameState(doc.cookie) === 'in';
    if (!s.session && has) doc.cookie = SIGNED_IN_COOKIE + '=; Path=/; Secure; SameSite=Strict; Max-Age=0';
    else if (s.session && !has) {
      const left = Math.floor(((s.session.expiresAt || 0) - Date.now()) / 1000);
      if (left > 0) doc.cookie = SIGNED_IN_COOKIE + '=1; Path=/; Secure; SameSite=Strict; Max-Age=' + left;
    }
  } catch (e) {}
}

/** 只做再验证时，等页面把要复验的事做完的上限（毫秒）；到点不管做没做完都结束 reauth */
export const REAUTH_HOLD_MS = 60000;

/** 第一屏要显示的层（旧地址 / 站内入口给的名字，见 commands.layerFromPath） */
export { layerFromPath };

/** 账号窗口里的层 → 终端命令（设备 / 账号安全 / 应用授权都在终端里看、在终端里改） */
export const LAYER_CMD = Object.freeze({ devices: 'device', keys: 'passkey', grants: 'app' });

/**
 * @typedef {Object} TermLink 终端那一头（topbar-panel.js 给）
 * @property {(line: string) => void} run 收起账号窗口、打开终端、当作敲进来跑这一行
 * @property {(f: () => void) => void} show 收起账号窗口、打开终端，然后 f（流程自己往终端里写）
 * @property {(after?: () => void) => void} close 收起终端窗口（主页首屏的终端收不起：直接 after）
 */

/**
 * @param {{
 *   dlg: HTMLDialogElement|null,
 *   ms: any,
 *   S: any,
 *   line: any,
 *   who: { setAccount: (on: boolean) => void, drop: () => void },
 *   term: TermLink,
 *   replace: (href: string) => void,
 *   reload?: () => void,
 * }} o S = 外壳字符串表的 account 节（嵌套）；line = 终端输入行（input-line 的 C）；dlg / ms 没有（页面没有账号窗口）时只挂终端那一层
 */
export function mountAccount(o) {
  const doc = document;
  const dlg = o.dlg;
  const S = flatStrings(o.S || {});
  /** @param {string} k */
  const t = function (k) { return S[k] || ''; };
  /** @param {string} k @param {Record<string, string|number>} v */
  const tf = function (k, v) { let s = t(k); for (const n in v) s = s.split('{' + n + '}').join(String(v[n])); return s; };
  /** auth/post-json.js errText 用的是旧的平铺键名：这里接到新表上 @param {string} k */
  const errT = function (k) { return k === 'reauthExpired' ? t('reauth.expired') : k === 'devCurrent' ? t('devices.currentHint') : t('common.' + k); };
  const reload = o.reload || function () { try { location.reload(); } catch (e) {} };

  /* ---------- 骨架（窗口只剩头部 / 内容 / 页脚；终端在顶栏的终端窗口里） ---------- */
  const sheet = dlg ? /** @type {HTMLElement|null} */ (dlg.querySelector('.sgx-qp-sheet')) : null;
  const root = doc.createElement('div');
  root.className = 'sgx-at';
  root.innerHTML = '<div class="sgx-at-head" data-at-head></div><div class="sgx-at-view" data-at-view></div><div class="sgx-at-ft" data-at-ft></div>';
  if (sheet) { sheet.innerHTML = ''; sheet.appendChild(root); }
  /** @param {string} a */
  const q = function (a) { return /** @type {HTMLElement} */ (root.querySelector('[' + a + ']')); };
  const headEl = q('data-at-head');
  const viewEl = q('data-at-view');
  const ftEl = q('data-at-ft');
  const ms = o.ms || { isShown: function () { return false; }, isOpen: function () { return false; }, close: function (/** @type {any} */ f) { if (f) f(); } };

  /**
   * 账号层上下文：状态 + 窗口函数；功能模块读写它，并把自己的函数挂上来。输出 / 输入模式来自终端输入行（原型）。
   * @type {any}
   */
  const C = layerCtx(o.line, {
    o: { ms: ms, replace: o.replace }, doc: doc, dlg: dlg || root, root: root, viewEl: viewEl, headEl: headEl,
    t: t, tf: tf, errT: errT, esc: esc, api: api, toast: toast, reload: reload,
    /** '' 未知 · in · guest */ st: '',
    /** api.status() 的结果 */ status: null,
    layer: 'home',
    /** reauth / reset 票到期（毫秒；0 = 没有） */ reauthExp: 0, resetExp: 0,
    /** reset 票下已改过凭证，还没选登出方式 */ resetPending: false,
    /** 当前在 sudo root reset 里 */ inReset: false,
    /** 奇趣 / 日刻要授权：{ app } */ consent: null,
    tries: 0,
    armed: '', editing: '',
    /** 登录状态变了：收起终端时重新载入（账号相关的部件按新状态重画） */ loginChanged: false,
  });
  /** 注释行 `# …`（这里传文案键；{x} 换成黄色命令） @param {string} key @param {string} [x] */
  C.note = function (key, x) { C.out('# ' + esc(t(key)).replace('{x}', x ? C.k(x) : ''), 'd'); };
  /** 服务端错误码 → 红字 @param {{s: number, j: any}} res */
  C.apiErr = function (res) { C.err(api.errText(errT, res && res.j && res.j.error, res && res.s)); };
  C.netErr = function () { C.err(t('common.errNetwork')); };

  /* ---------- 状态 / 票 ---------- */
  /** api.status() → 更新 st / 票 @returns {Promise<any>} */
  C.loadStatus = function () {
    return api.status().then(function (s) {
      if (!s) return null;
      C.status = s;
      correctSignedInMarker(doc, s);
      C.setSt(s.session ? 'in' : 'guest');
      C.reauthExp = s.reauth && s.reauth.expiresAt > Date.now() ? s.reauth.expiresAt : 0;
      C.resetExp = s.reset && s.reset.expiresAt > Date.now() ? s.reset.expiresAt : 0;
      return s;
    });
  };
  /** @param {string} s */
  C.setSt = function (s) {
    C.st = s;
    root.setAttribute('data-acct-state', s);
    if (dlg) dlg.setAttribute('data-acct-state', s);
    try { doc.documentElement.setAttribute('data-sgx-account-session', s === 'in' ? 'in' : 'out'); } catch (e) {}
    if (s) o.who.setAccount(s === 'in');
  };
  C.reauthLeft = function () { return C.reauthExp > Date.now() ? C.reauthExp - Date.now() : 0; };
  C.resetLeft = function () { return C.resetExp > Date.now() ? C.resetExp - Date.now() : 0; };
  /** @param {number} ms2 */
  C.mmss = function (ms2) { const s = Math.ceil(ms2 / 1000); return (s < 600 ? '0' : '') + Math.floor(s / 60) + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); };

  /* ---------- 头部 / 页脚 / 行 ---------- */
  /** @param {string} title @param {string} right @param {boolean} [cd] */
  C.subHead = function (title, right, cd) {
    headEl.innerHTML = '<button type="button" class="sgx-at-bk" data-at-back aria-label="' + esc(t('common.backAria')) + '">‹</button><h2 class="sgx-at-h">' + esc(title) + '</h2>' +
      '<span class="sgx-at-hv"' + (cd ? ' data-at-cd data-live' : '') + ' translate="no">' + esc(right) + '</span>';
  };
  /** @param {string} key */
  C.foot = function (key) { ftEl.textContent = key ? t(key) : ''; ftEl.hidden = !key; };
  /** 行 @param {{k: string, v?: string, sub?: string, act?: string, cls?: string, chev?: boolean, attrs?: string, armed?: boolean, kHtml?: string, vHtml?: string}} r */
  C.row = function (r) {
    const tag = r.act ? 'button type="button"' : 'div';
    const end = r.act ? 'button' : 'div';
    return '<' + tag + ' class="sgx-pop-row sgx-at-r' + (r.cls ? ' ' + r.cls : '') + '"' + (r.act ? ' data-at-act="' + esc(r.act) + '"' : '') + (r.armed ? ' data-armed' : '') + (r.attrs || '') + '>' +
      '<span class="sgx-at-k"><span class="sgx-pop-k">' + (r.kHtml || esc(r.k)) + '</span>' + (r.sub ? '<small>' + esc(r.sub) + '</small>' : '') + '</span>' +
      '<span class="sgx-pop-v">' + (r.vHtml != null ? r.vHtml : esc(r.v || '')) + '</span>' + (r.chev ? '<span class="sgx-pop-chev" aria-hidden="true">›</span>' : '') +
      '</' + end + '>';
  };
  /** 层的路径（头部右边） @param {string} layer */
  C.path = function (layer) { return layer === 'profile' ? '~/account/profile' : ''; };
  /** 已授权应用数（主页「应用授权」右边，O14） */
  C.grantCount = function () { return C.grants ? String(C.grants.filter(function (/** @type {any} */ g) { return g.granted; }).length) : ''; };
  C.paintGrantCount = function () {
    const el = viewEl.querySelector('[data-at-v="grants"] .sgx-pop-v');
    if (el) el.textContent = C.grantCount();
  };

  /* ---------- 功能模块 ---------- */
  mountSession(C);
  mountReauth(C);
  mountReset(C);
  mountKeys(C);
  mountDevices(C);
  mountGrants(C);
  mountProfile(C);
  mountProxy(C);
  /** 终端输出里的按钮（sub 的复制）：终端窗口点到 [data-at-act] 时调 @param {string} a */
  C.actLog = function (a) { return C.actProxy(a); };
  /* 终端里的账号命令：账号状态还没问过（这一页第一次用）就先问一次再跑（命令要看 st / 票） */
  ['cmdSession', 'cmdReauth', 'cmdReset', 'cmdExit', 'cmdPasswd', 'cmdPasskeyAdd', 'passkeyList', 'passkeyRm', 'deviceList', 'deviceRm', 'deviceRmAll', 'appList', 'appRm', 'cmdSub'].forEach(function (k) {
    const f = C[k];
    C[k] = function () {
      const args = arguments;
      if (C.status) return f.apply(C, args);
      C.setMode('busy');
      C.loadStatus().then(function () { C.toCmd(); f.apply(C, args); }, function () { C.toCmd(); f.apply(C, args); });
    };
  });

  C.render = function () {
    root.setAttribute('data-at-layer', C.st === 'in' ? C.layer : 'guest');
    if (C.st !== 'in') { headEl.innerHTML = ''; viewEl.innerHTML = ''; C.foot(''); return; }
    if (C.layer === 'profile') return C.renderProfile();
    C.renderHome();
  };

  C.renderHome = function () {
    headEl.innerHTML = '';
    const p = C.who();
    const navImg = /** @type {HTMLImageElement|null} */ (doc.querySelector('#site-nav .sgx-tb-avatar'));
    const src = navImg ? navImg.src.replace(/\/avatar\/\d+\.webp/, '/avatar/192.webp') : '/avatar/192.webp';
    const s = C.status;
    const dev = (s && s.session && s.session.device) || t('devices.this');
    const sec = s && (s.configured.password || s.configured.passkey) ? t('keys.hint') : t('keys.unprotected');
    viewEl.innerHTML =
      '<div class="sgx-pop-me"><button type="button" class="sgx-pop-me-a" data-at-act="profile"><img src="' + esc(src) + '" alt="" width="48" height="48" class="sgx-pop-avatar" data-sgx-avatar="192">' +
      '<span class="sgx-pop-who"><b translate="no" data-sgx-personal>' + esc(p.name) + '</b><small><span translate="no" data-sgx-personal>' + esc(p.nickname) + '</span><span class="sgx-pop-state"> · <i aria-hidden="true">✓</i> ' + esc(t('common.signedIn')) + '</span></small></span></button>' +
      '<button type="button" class="sgx-pop-edit" data-at-act="profile">' + esc(t('common.edit')) + '</button></div>' +
      '<div class="sgx-pop-list">' +
      C.row({ k: t('profile.title'), v: t('profile.hint'), act: 'profile', chev: true }) +
      C.row({ k: t('devices.title'), v: dev, sub: 'device', act: 'devices', chev: true }) +
      C.row({ k: t('keys.title'), v: sec, sub: 'passkey', act: 'keys', chev: true }) +
      C.row({ k: t('grants.title'), v: C.grantCount(), sub: 'app', act: 'grants', chev: true, attrs: ' data-at-v="grants"' }) +
      '</div><div class="sgx-pop-list sgx-pop-list--line">' + C.row({ k: t('common.signOut'), v: 'exit', act: 'exit', cls: 'sgx-pop-row--acc' }) + '</div>';
    C.foot('');
  };

  /** 服务端说没会话 / 票过期：401 lock → 没进站；401 reset → 结束 reset；401 account → 回没登录；403 reauth → 重新验证 @param {{s:number, j:any}} res @returns {boolean} */
  C.authErr = function (res) {
    if (api.isErr(res, api.ERR.lock)) { C.err(t('common.sessExp')); o.who.drop(); return true; }
    if (api.isErr(res, api.ERR.reset)) { C.endReset(true); return true; }
    if (api.isErr(res, api.ERR.account)) {
      C.setSt('guest');
      C.layer = 'home';
      C.render();
      C.err(t('session.notSignedIn'), CMD.session);
      return true;
    }
    if (api.isErr(res, api.ERR.reauth)) {
      C.reauthExp = 0;
      C.err(t('reauth.expired'));
      return true;
    }
    return false;
  };

  /** 登出 / 授权同意之后：收起终端（登录状态变了就重新载入） */
  C.finished = function () {
    o.term.close(function () { afterTerm(); });
  };
  function afterTerm() {
    if (!C.loginChanged) return;
    C.loginChanged = false;
    /* 只做再验证时顺带登录了：等页面把复验的事做完再重新载入，不然重载会打断它 */
    const h = holdReauth;
    if (h) h.then(function () { window.setTimeout(reload, 0); });
    else window.setTimeout(reload, 0);
  }
  /** 终端窗口关上：离开 reset（没选登出方式 = 不登出）、结束 reauth、忘掉印过的地址；登录状态变了就重新载入 */
  C.onTermClosed = function () {
    if (C.inReset) { if (C.resetPending) C.toast(t('reset.signOut.pending')); C.inReset = false; C.resetPending = false; C.resetExp = 0; C.stopTick(); }
    C.forgetProxy();
    const h = holdReauth;
    holdReauth = null;
    if (h) h.then(function () { C.endReauth(); });
    else C.endReauth();
    afterTerm();
  };

  /* ---------- 窗口的层 ---------- */
  /** @param {string} to */
  C.go = function (to) {
    C.layer = to === 'profile' ? 'profile' : 'home';
    C.editing = '';
    C.render();
    if (C.layer === 'profile') C.enterProfile();
    keepFocus();
  };
  /** 重画后焦点别丢到 body（不然 esc / 键盘都到不了窗口） */
  function keepFocus() {
    if (!dlg || !sheet) return;
    const ae = doc.activeElement;
    if (ae && ae !== doc.body && dlg.contains(ae) && ae.isConnected) return;
    try { sheet.focus({ preventScroll: true }); } catch (e) {}
  }
  /** esc：先撤编辑，再回首层；最外层回 false（交给窗口关掉） */
  function escBack() {
    if (C.editing) { C.editing = ''; C.render(); return true; }
    if (C.layer !== 'home') { C.go('home'); return true; }
    return false;
  }
  if (dlg) {
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (escBack()) e.preventDefault();
    });
  }
  root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    if (!tg) return;
    if (tg.closest('[data-at-back]')) { C.go('home'); return; }
    const a = /** @type {HTMLElement|null} */ (tg.closest('[data-at-act]'));
    if (!a) return;
    e.preventDefault();
    act(a.getAttribute('data-at-act') || '');
    keepFocus();
  });
  /** 行上的动作：个人资料在窗口里；设备 / 账号安全 / 应用授权 / 退出登录 = 跳终端跑命令 @param {string} a */
  function act(a) {
    if (a === 'profile') { C.go('profile'); return; }
    if (a === 'exit') { o.term.run('exit'); return; }
    if (Object.prototype.hasOwnProperty.call(LAYER_CMD, a)) { o.term.run(/** @type {any} */ (LAYER_CMD)[a]); return; }
    if (a === 'ed-cancel') { C.editing = ''; C.render(); return; }
    C.actProfile(a);
  }

  /* ---------- 开 / 关 ---------- */
  /**
   * 打开账号窗口（topbar-panel 的 onOpen）。x.layer：旧地址跳来（O1）或站内入口要直接进的那一层；x.app：奇趣 / 日刻的授权同意；x.reset：sudo root reset；x.reauth：只再验证。
   * x.run：别处转来的一条命令（终端里跑）。没登录：跳终端 sudo root（登录后再授权同意 / 回到这里）。
   * @param {{layer?: string, app?: string, reset?: boolean, reauth?: boolean, run?: string}} [x]
   */
  function onOpen(x) {
    const want = (x && x.layer) || '';
    C.consent = x && x.app ? { app: x.app } : null;
    if (x && x.reset) { o.term.run(CMD.reset); return; }
    if (x && x.run) { o.term.run(x.run); return; }
    if (x && x.reauth) { onlyReauth(); return; }
    if (Object.prototype.hasOwnProperty.call(LAYER_CMD, want)) { o.term.run(/** @type {any} */ (LAYER_CMD)[want]); return; }
    /* 首帧按登录标记 cookie 画（A18：不闪），GET /api/account 回来后校正 */
    if (!C.st) {
      let ff = /** @type {'in'|'guest'|''} */ ('');
      try { ff = firstFrameState(doc.cookie); } catch (e) {}
      C.setSt(ff);
    }
    C.layer = want === 'profile' ? 'profile' : 'home';
    C.render();
    C.loadStatus().then(function (s) {
      if (!s && !C.st) C.setSt('guest');
      if (C.st !== 'in') { o.term.run(CMD.session); return; }
      if (C.consent) { o.term.show(function () { C.askConsent(); }); return; }
      if (!C.grants) C.loadGrants();
      C.go(C.layer);
    });
  }
  /**
   * 只做再验证（[data-acct-open="reauth"]，奇趣导入书签要复验）。和「关掉即失效」（O12）一致（#327 偏离修复）：
   * 验过后先在 document 上发 `sgx-account-reauthed`（detail.waitUntil(promise)），等它的页面在这一刻把要复验的事做完
   * （奇趣：重发导入）；然后收起终端，等页面登记的事做完（最多 REAUTH_HOLD_MS）就 POST /reauth { end }。
   */
  /** @type {Promise<void>|null} */
  let holdReauth = null;
  function onlyReauth() {
    const done = function () {
      /** @type {Promise<any>[]} */
      const waits = [];
      try {
        doc.dispatchEvent(new CustomEvent('sgx-account-reauthed', { detail: { waitUntil: function (/** @type {any} */ p) { waits.push(Promise.resolve(p).catch(function () {})); } } }));
      } catch (e) {}
      if (waits.length) {
        holdReauth = Promise.race([
          Promise.all(waits).then(function () {}),
          new Promise(function (r) { window.setTimeout(r, REAUTH_HOLD_MS); }),
        ]).then(function () {});
      }
      o.term.close();
    };
    o.term.show(function () {
      C.loadStatus().then(function () {
        if (C.st === 'in') { C.echo(CMD.reauth); C.cmdReauth(done); }
        else { C.echo(CMD.session); C.verify({ withReauth: true, lead: t('session.lead'), done: done }); }
        C.focusIn();
      });
    });
  }
  function onClose() {
    C.editing = '';
    C.armed = '';
  }

  /* 首帧登录标记说登录了：问一次账号接口，终端提示符按服务端的回答（root@account / styrigx@space） */
  try { if (firstFrameState(doc.cookie) === 'in') C.loadStatus(); } catch (e) {}

  return {
    /** 终端里的账号层 */
    layer: C,
    onOpen: onOpen,
    onClose: onClose,
    _state: function () { return { st: C.st, layer: C.layer, mode: C.mode, inReset: C.inReset, resetPending: C.resetPending }; },
  };
}
