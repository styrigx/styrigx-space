/**
 * @fileoverview 账号窗口（头像下拉，2026-11-08 账号 UI 改版，设计稿 acct-sec-redraw mock v3 / OPEN.md O1–O22 / acct-naming PROPOSAL §1.1）。
 * v5 S5（终端合一）不动这个窗口：外观、各层、自带的命令行都照旧；全站终端里另有同一套账号命令（cmd/layer.js，共用 session / reauth / reset / api），
 * 两边的登录状态经 who（终端身份）同步。
 *
 * 没有 /account/ 整页了（O1）：账号总览、登录、重置、个人资料、设备、账号安全、应用授权、奇趣 / 日刻的授权同意，都在这一张下拉里一层层进（O2，‹ 返回）。
 * 每一层底下是同一个终端：一行真输入框 + 输出区（同锁屏的写法：输入不回显、可粘贴，没有显示密码的小眼睛，O10）。
 *
 * 这个文件只管外壳：骨架、输出、输入行（模式 / 选项 / 秘密输入）、头部 / 页脚、层的切换、命令分发、开 / 关。
 * 各功能在同目录：session.js（sudo root）、reauth.js（sudo root reauth）、reset.js（sudo root reset）、keys.js（账号安全）、
 * devices.js、grants.js（应用授权 + 奇趣 / 日刻授权同意）、profile.js（个人资料 + 头像）。命令字在 commands.js，后端只在 api.js。
 * 功能模块都拿同一个上下文 C（状态 + 外壳函数），把自己的函数挂回 C 上。
 *
 * 只 import lib/、auth/、shell/（check-layers 规则 3）。文案在外壳字符串表 account.*（sgx-shell-i18n），四个站同一份。
 */
import { esc } from '../../lib/util.js';
import { toast } from '../../lib/toast.js';
import { suggest } from '../suggest.js';
import { flatStrings } from '../term/core/strings.js';
import { createInputLine } from '../term/view/input-line.js';
import { completerOf } from '../term/core/complete.js';
import * as api from './api.js';
import { CMD, PS_GUEST, PS_ROOT, PS_RESET, LAYERS, LAYER_PATH, WINDOW_TABLE, normCmd, parseCmd, layerFromPath } from './commands.js';
import { mountSession } from './session.js';
import { mountReauth } from './reauth.js';
import { mountReset } from './reset.js';
import { mountKeys } from './keys.js';
import { mountDevices } from './devices.js';
import { mountGrants } from './grants.js';
import { mountProfile } from './profile.js';
import { mountProxy, parseSub } from './proxy.js';

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

/**
 * 挂到 #sgx-acct 上。
 * @param {{
 *   dlg: HTMLDialogElement,
 *   ms: any,
 *   S: any,
 *   replace: (href: string) => void,
 *   reload?: () => void,
 *   who?: { setAccount: (on: boolean) => void } | null,
 * }} o S = 外壳字符串表的 account 节（嵌套）；who = 全站终端的身份（登录状态变了同步提示符，没有终端的页面不传）
 */
export function mountAccountWindow(o) {
  const dlg = o.dlg;
  const doc = dlg.ownerDocument || document;
  const S = flatStrings(o.S || {});
  /** @param {string} k */
  const t = function (k) { return S[k] || ''; };
  /** @param {string} k @param {Record<string, string|number>} v */
  const tf = function (k, v) { let s = t(k); for (const n in v) s = s.split('{' + n + '}').join(String(v[n])); return s; };
  /** auth/post-json.js errText 用的是旧的平铺键名：这里接到新表上 @param {string} k */
  const errT = function (k) { return k === 'reauthExpired' ? t('reauth.expired') : k === 'devCurrent' ? t('devices.currentHint') : t('common.' + k); };
  const sheet = /** @type {HTMLElement} */ (dlg.querySelector('.sgx-qp-sheet'));
  const reload = o.reload || function () { try { location.reload(); } catch (e) {} };

  /* ---------- 骨架 ---------- */
  sheet.innerHTML = '';
  const root = doc.createElement('div');
  root.className = 'sgx-at';
  root.innerHTML =
    '<div class="sgx-at-head" data-at-head></div>' +
    '<div class="sgx-at-view" data-at-view></div>' +
    '<div class="sgx-at-term" data-at-term>' +
    '<div class="sgx-at-log" data-at-log aria-hidden="true"></div>' +
    '<form class="sgx-at-line" data-at-form autocomplete="off" novalidate>' +
    '<input type="text" class="sgx-at-pmu" data-at-pmu autocomplete="username" tabindex="-1" aria-hidden="true" value="' + esc(api.PM_USER.password) + '">' +
    '<label class="sgx-at-ps" for="sgx-at-in" data-at-ps translate="no"></label>' +
    '<input id="sgx-at-in" class="sgx-at-in" data-at-in type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">' +
    '</form>' +
    '<p class="sgx-at-hint" data-at-hint hidden></p>' +
    '<p class="sgx-kh sgx-at-kh" data-at-kh hidden></p>' +
    '<div class="sgx-at-live" data-at-live role="status" aria-live="polite"></div>' +
    '</div>' +
    '<div class="sgx-at-ft" data-at-ft></div>';
  sheet.appendChild(root);
  /** @param {string} a */
  const q = function (a) { return /** @type {HTMLElement} */ (root.querySelector('[' + a + ']')); };
  const headEl = q('data-at-head');
  const viewEl = q('data-at-view');
  const logEl = q('data-at-log');
  const form = /** @type {HTMLFormElement} */ (q('data-at-form'));
  const psEl = q('data-at-ps');
  const input = /** @type {HTMLInputElement} */ (q('data-at-in'));
  const pmu = /** @type {HTMLInputElement} */ (q('data-at-pmu'));
  const hintEl = q('data-at-hint');
  const liveEl = q('data-at-live');
  const ftEl = q('data-at-ft');

  /**
   * 共享上下文：状态 + 外壳函数。功能模块读写它，并把自己的函数挂上来。
   * @type {any}
   */
  const C = {
    o: o, doc: doc, dlg: dlg, root: root, viewEl: viewEl, headEl: headEl, input: input,
    t: t, tf: tf, errT: errT, esc: esc, api: api, toast: toast, reload: reload,
    /** '' 未知 · in · guest */ st: '',
    /** api.status() 的结果 */ status: null,
    layer: 'home',
    /** reauth / reset 票到期（毫秒；0 = 没有） */ reauthExp: 0, resetExp: 0,
    /** reset 票下已改过凭证，还没选登出方式 */ resetPending: false,
    /** 当前在 sudo root reset 里 */ inReset: false,
    /** 奇趣 / 日刻要授权：{ app } */ consent: null,
    /** @type {'cmd'|'pick'|'pw'|'rkey'|'newpw'|'newpw2'|'pkname'|'busy'} */ mode: 'cmd',
    /** 当前一轮的输错次数 */ tries: 0,
    /** 秘密输入（密码 / 恢复密钥 / 新密码 / 通行密钥名字）的提交函数 */ onSecret: null,
    onCancel: null,
    /** 等待中（busy）也能 ^C 的那件事（通行密钥）：^C 时调它 */ busyCancel: null,
    /** 进 busy 时输入行有焦点：回命令行要把焦点还回来（触屏键盘收起后命令行像死了，Gray 22:12） */ refocus: false,
    armed: '', editing: '',
    /** 这次打开期间登录状态变了：关下拉时重新载入 */ loginChanged: false,
  };
  C.ps = function () { return C.inReset ? PS_RESET : C.st === 'in' ? PS_ROOT : PS_GUEST; };

  /**
   * 新行滚进下拉自己的滚动区。不用 scrollIntoView：它连可视视口一起滚，三星「桌面版网站」放大时整页会平移到面板那边
   * （popover-no-zoom.spec.js，同 modal-sheet.js showDialog 的 preventScroll）。
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

  /* ---------- 按键提示行（Gray 2026-11-09 细节 1；shell/keyhint.js） ---------- */
  /** esc / 触屏「‹ 返回」的同一条路：先退出当前命令，再撤编辑 / 两步确认，再回首层；最外层回 false（交给下拉关掉） */
  function escBack() {
    if (C.interrupt()) return true;
    if (C.editing) { C.editing = ''; C.render(); return true; }
    if (C.armed) { C.armed = ''; C.render(); return true; }
    if (C.st === 'in' && !C.inReset && C.layer !== 'home') { C.go('home'); return true; }
    return false;
  }

  /* ---------- 输入行 + 输出（终端统一 T2：shell/term/view/input-line.js，和锁屏 / 盾牌同一份；这里的参数保留账号下拉原有的细节） ---------- */
  const BACK_RE = /^cd\s*(\.\.|\/)\s*$/;
  createInputLine({
    ctx: C,
    dom: { root: root, log: logEl, form: form, input: input, ps: psEl, pmu: pmu, hint: hintEl, live: liveEl, kh: q('data-at-kh') },
    p: 'sgx-at',
    attr: 'at',
    t: t,
    ps: function () { return C.ps(); },
    onCmd: function (v) { C.runCmd(v); },
    isShown: function () { return o.ms.isShown(); },
    onReveal: reveal,
    onMode: function (m) { root.setAttribute('data-at-mode', m); },
    /* reset 层的命令行：^C / esc = 离开 reset（同关掉下拉：没选登出方式 = [3] 不登出），回 login@account / root@account */
    onCmdInterrupt: function () { if (C.inReset) { C.out('^C', 'd'); C.leaveReset(); return true; } return false; },
    /* 首层 esc 关下拉、下一层和 reset 里 esc 回去；触屏一直有「‹ 返回」（最外层 = 关下拉） */
    kh: {
      cmdKey: function () { return C.inReset || (C.st === 'in' && C.layer && C.layer !== 'home') ? 'cmdLayer' : 'cmd'; },
      canBackCmd: function () { return true; },
      onBack: function () { C.refocus = true; if (!escBack()) o.ms.close(); },
    },
    secretModes: ['pw', 'rkey', 'newpw', 'newpw2', 'suburl'],
    /* tty5：Tab 补全 + 历史落 sessionStorage（终端统一 T4；以前没有历史） */
    complete: completerOf(WINDOW_TABLE),
    histKey: 'sgx-term-hist-5',
    ctrlL: false,
    inputmode: false,
    aria: function (m, secret) { return secret ? (m === 'rkey' ? t('reset.recoveryKeyAria') : t('common.passwordAria')) : m === 'pkname' ? t('keys.passkey.nameAria') : t('common.termAria'); },
    pmDefault: api.PM_USER.password,
    /* 输入不显示的那几行和等通行密钥：提示行末尾一个能点的 ^C（触屏没有 Ctrl+C / esc，Gray 22:12）；reset 层的命令行也有 */
    ccCmd: function () { return C.inReset; },
    ccEcho: 'plain',
    echoSecret: function (m) { return m === 'pw' || m === 'rkey' ? 'plain' : ''; },
    secretBack: BACK_RE,
    pknameEmptyToCmd: true,
    /* 选项里没有的编号：说一声、接着选；是条命令就回命令行跑它（Gray 22:13） */
    pickMiss: function (key, v) {
      if (/^\[?\d+\]?$/.test(key)) { C.echoPick(key); C.err(t('common.noOption')); return; }
      if (key && parseCmd(key).cmd !== 'unknown') { C.toCmd(); C.runCmd(v); }
    },
    ctrlC: 'at',
    pickFocus: false,
    pickClickRefocus: false,
    focusZone: '[data-at-term]',
    focusForce: false,
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
    dlg.setAttribute('data-acct-state', s);
    try { doc.documentElement.setAttribute('data-sgx-account-session', s === 'in' ? 'in' : 'out'); } catch (e) {}
    if (s && o.who) o.who.setAccount(s === 'in');
    if (C.mode === 'cmd') psEl.textContent = C.ps();
  };
  C.reauthLeft = function () { return C.reauthExp > Date.now() ? C.reauthExp - Date.now() : 0; };
  C.resetLeft = function () { return C.resetExp > Date.now() ? C.resetExp - Date.now() : 0; };
  /** @param {number} ms */
  C.mmss = function (ms) { const s = Math.ceil(ms / 1000); return (s < 600 ? '0' : '') + Math.floor(s / 60) + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); };

  /* ---------- 头部 / 页脚 / 行 ---------- */
  /** @param {string} title @param {string} right @param {boolean} [cd] */
  C.subHead = function (title, right, cd) {
    headEl.innerHTML = '<button type="button" class="sgx-at-bk" data-at-back aria-label="' + esc(t('common.backAria')) + '">‹</button><h2 class="sgx-at-h">' + esc(title) + '</h2>' +
      '<span class="sgx-at-hv"' + (cd ? ' data-at-cd data-live' : '') + ' translate="no">' + esc(right) + '</span>';
  };
  /** @param {string} right */
  C.barHead = function (right) {
    headEl.innerHTML = '<div class="sgx-nav-h sgx-at-bar"><span translate="no"><b aria-hidden="true">$</b> ACCOUNT</span><span translate="no" class="sgx-at-hv" data-at-cd>' + esc(right) + '</span></div>';
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
  /** @param {string} txt @param {boolean} [line] */
  C.grp = function (txt, line) { return '<p class="sgx-pop-g' + (line ? ' sgx-pop-g--line' : '') + '">' + esc(txt) + '</p>'; };
  /** @param {string} txt */
  C.noteP = function (txt) { return '<p class="sgx-at-note">' + esc(txt) + '</p>'; };
  /** 层的路径（头部右边） @param {string} layer */
  C.path = function (layer) { return /** @type {any} */ (LAYER_PATH)[layer] || ''; };
  /** 已授权应用数（主页「应用授权」右边，O14） */
  C.grantCount = function () { return C.grants ? String(C.grants.filter(function (/** @type {any} */ g) { return g.granted; }).length) : ''; };

  /* ---------- 功能模块 ---------- */
  mountSession(C);
  mountReauth(C);
  mountReset(C);
  mountKeys(C);
  mountDevices(C);
  mountGrants(C);
  mountProfile(C);
  mountProxy(C);

  C.render = function () {
    root.setAttribute('data-at-layer', C.inReset ? 'reset' : C.consent && C.st !== 'in' ? 'consent' : C.st === 'in' ? C.layer : 'guest');
    if (C.inReset) return C.renderReset();
    if (C.st !== 'in') return C.renderGuest();
    if (C.layer === 'profile') return C.renderProfile();
    if (C.layer === 'devices') return C.renderDevices();
    if (C.layer === 'keys') return C.renderKeys();
    if (C.layer === 'grants') return C.renderGrants();
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
      C.row({ k: t('devices.title'), v: dev, act: 'devices', chev: true }) +
      C.row({ k: t('keys.title'), v: sec, act: 'keys', chev: true }) +
      C.row({ k: t('grants.title'), v: C.grantCount(), act: 'grants', chev: true, attrs: ' data-at-v="grants"' }) +
      '</div><div class="sgx-pop-list sgx-pop-list--line">' + C.row({ k: t('common.signOut'), v: 'exit', act: 'exit', cls: 'sgx-pop-row--acc' }) + '</div>';
    C.foot('');
    if (!logEl.childNodes.length) C.note('common.typeHelp', 'man');
  };

  /** 服务端说没会话 / 票过期：401 account → 回登录；401 reset → 结束 reset；403 reauth → 回门口；401 session → 锁屏 @param {{s:number, j:any}} res @returns {boolean} */
  C.authErr = function (res) {
    if (api.isErr(res, api.ERR.lock)) { C.err(t('common.sessExp')); return true; }
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
      C.render();
      return true;
    }
    return false;
  };

  /* ---------- 命令 ---------- */
  function help() {
    C.out('<span class="sgx-at-w">' + CMD.session + '</span> — ' + esc(t('help.session')) + ' · <span class="sgx-at-dim">passkey / password</span>');
    C.out('<span class="sgx-at-w">' + CMD.reauth + '</span> — ' + esc(t('help.reauth')) + ' · <span class="sgx-at-dim">passkey / password</span>');
    C.out('<span class="sgx-at-w">' + CMD.reset + '</span> — ' + esc(t('help.reset')) + ' · <span class="sgx-at-dim">recovery key</span>');
    C.out('<span class="sgx-at-w">exit</span> — ' + esc(t('help.exit')) + ' · <span class="sgx-at-w">clear</span> — ' + esc(t('help.clear')));
    C.note('help.keyMap');
    C.out('# ' + esc(t('help.note')), 'd');
  }
  /** @param {string} raw */
  C.runCmd = function (raw) {
    const line = normCmd(raw);
    if (!line) return;
    C.echo(raw.trim());
    /* sub（代理订阅 v3.1）：来源名大小写敏感，拿原样的一行 */
    if (parseSub(raw)) { C.cmdSub(raw); return; }
    const c = parseCmd(line);
    switch (c.cmd) {
      case 'help': help(); return;
      case 'clear': C.clearLog(); return;
      case 'session': C.cmdSession(); return;
      case 'reauth': C.cmdReauth(); return;
      case 'reset': C.cmdReset(); return;
      case 'exit': if (C.inReset) { C.leaveReset(); return; } C.cmdExit(); return;
      case 'passwd': C.cmdPasswd(true); return;
      case 'passkey-add': C.cmdPasskeyAdd(true); return;
      case 'cd': if (C.st === 'in' && !C.inReset) C.go(c.arg || 'home'); return;
      default: {
        /* 打错了：给最近的真命令（Gray 2026-11-09） */
        const sg = suggest(line, ['man', 'clear', CMD.session, CMD.reauth, CMD.reset, 'exit', 'passwd', 'passkey add', 'cd profile', 'cd devices', 'cd security', 'cd apps']);
        if (sg) C.err(tf('common.didYouMean', { c: raw.trim().split(' ')[0] }), sg);
        else C.err(tf('common.notFound', { x: raw.trim().split(' ')[0] }));
      }
    }
  };

  /* ---------- 层 ---------- */
  /** @param {string} to */
  C.go = function (to) {
    if (LAYERS.indexOf(to) === -1) to = 'home';
    C.layer = to;
    C.editing = '';
    C.clearLog();
    C.toCmd();
    C.render();
    if (to === 'devices') C.loadDevices();
    if (to === 'grants') C.loadGrants();
    if (to === 'profile') C.enterProfile();
    if (to === 'keys') C.enterKeys();
    C.keepFocus();
  };
  /** 重画后焦点别丢到 body（不然 esc / 键盘都到不了下拉）：能聚焦输入行就聚焦，不能（触屏不弹键盘）就聚焦面板 */
  C.keepFocus = function () {
    const ae = doc.activeElement;
    if (ae && ae !== doc.body && dlg.contains(ae) && ae.isConnected) return;
    C.focusIn();
    if (!dlg.contains(doc.activeElement)) { try { sheet.focus({ preventScroll: true }); } catch (e) {} }
  };

  /* ---------- 事件 ---------- */
  /* esc：先退出当前命令，再回上一层，最外层才交给下拉关掉（modalSheet 的 Esc 看 defaultPrevented） */
  /* 等通行密钥（busy）时输入行藏着、禁用，焦点掉到 body，键盘事件到不了下拉：在 document 上接 Ctrl+C / esc（2026-11-09），只中断等待、不关下拉；别的模式照旧 */
  doc.addEventListener('keydown', function (e) {
    if (C.mode !== 'busy' || !C.busyCancel || !o.ms.isShown() || e.defaultPrevented) return;
    const ctrlC = e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'c' || e.key === 'C');
    if (!ctrlC && e.key !== 'Escape') return;
    e.preventDefault();
    C.refocus = true;
    C.interrupt();
  }, true); /* 捕获阶段：先于 modal-sheet 在 document 上的 Esc 关闭（它看 defaultPrevented） */
  dlg.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (escBack()) e.preventDefault();
  });
  /* 选项 / ^C / 点空白处聚焦输入行在 input-line.js 里接；这里只接头部返回和行上的动作 */
  root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    if (!tg) return;
    if (tg.closest('[data-at-back]')) { C.go('home'); return; }
    const a = /** @type {HTMLElement|null} */ (tg.closest('[data-at-act]'));
    if (!a) return;
    e.preventDefault();
    act(a.getAttribute('data-at-act') || '');
    C.keepFocus();
  });
  /** 行上的动作：层名 = 进那一层；其余交给各模块的 act（认得就回 true） @param {string} a */
  function act(a) {
    if (LAYERS.indexOf(a) !== -1) { C.go(a); return; }
    if (a === 'exit') { C.echo('exit'); C.cmdExit(); return; }
    if (a === 'ed-cancel') { C.editing = ''; C.render(); return; }
    if (C.actKeys(a) || C.actDevices(a) || C.actGrants(a) || C.actProfile(a) || C.actProxy(a)) return;
  }
  try {
    /* 离开页面：reauth 结束（O12） */
    window.addEventListener('pagehide', function () { C.endReauth(); });
  } catch (e) {}

  /* ---------- 开 / 关 ---------- */
  /**
   * 打开时（topbar-panel 的 onOpen）。x.layer：旧地址跳来（O1）或站内入口要直接进的那一层；x.app：奇趣 / 日刻的授权同意；x.reset：sudo root reset；x.reauth：只再验证。
   * x.run：别的终端转来的一条命令（sub，v3.1）：登录了就在这里跑；没登录先 sudo root。
   * @param {{layer?: string, app?: string, reset?: boolean, reauth?: boolean, run?: string}} [x]
   */
  function onOpen(x) {
    const want = (x && x.layer) || '';
    C.consent = x && x.app ? { app: x.app } : null;
    C.clearLog();
    C.toCmd();
    /* 首帧按登录标记 cookie 画提示符（A18：不闪；网关命名 v2 起不再注入登录态），GET /api/account 回来后校正 */
    if (!C.st) {
      let ff = /** @type {'in'|'guest'|''} */ ('');
      try { ff = firstFrameState(doc.cookie); } catch (e) {}
      C.setSt(ff);
    }
    C.layer = LAYERS.indexOf(want) !== -1 ? want : 'home';
    C.render();
    C.loadStatus().then(function (s) {
      if (!s && !C.st) C.setSt('guest');
      if (C.inReset && !C.resetLeft()) { C.inReset = false; C.resetPending = false; }
      if (x && x.reset) { C.echo(CMD.reset); C.cmdReset(); C.render(); C.focusIn(); return; }
      if (x && x.reauth) { onlyReauth(); return; }
      if (C.st === 'in') {
        if (C.consent) { C.render(); C.askConsent(); return; }
        if (!C.grants) C.loadGrants();
        C.go(C.layer);
        if (x && x.run) { C.runCmd(x.run); C.focusIn(); }
        return;
      }
      C.render();
      C.echo(CMD.session);
      C.cmdSession();
      C.focusIn();
    });
  }
  /**
   * 只做再验证（[data-acct-open="reauth"]，奇趣导入书签要复验）。和「关下拉 reauth 即失效」（O12）一致（#327 偏离修复）：
   * 验过后先在 document 上发 `sgx-account-reauthed`（detail.waitUntil(promise)），等它的页面在这一刻把要复验的事做完
   * （奇趣：重发导入）；然后关面板，等页面登记的事做完（最多 REAUTH_HOLD_MS）就 POST /reauth { end }。
   * 没人登记就关面板时立刻结束。离开页面（pagehide）照旧立刻结束。
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
      o.ms.close();
    };
    C.render();
    if (C.st === 'in') { C.echo(CMD.reauth); C.cmdReauth(done); }
    else { C.echo(CMD.session); C.verify({ withReauth: true, lead: t('session.lead'), done: done }); }
    C.focusIn();
  }
  function onClose() {
    const h = holdReauth;
    holdReauth = null;
    if (C.resetPending) C.toast(t('reset.signOut.pending'));
    if (C.loginChanged) {
      C.loginChanged = false;
      /* 只做再验证时顺带登录了：等页面把复验的事做完再重新载入，不然重载会打断它 */
      if (h) h.then(function () { window.setTimeout(reload, 0); });
      else window.setTimeout(reload, 0);
    }
    C.stopTick();
    if (C.inReset) { C.inReset = false; C.resetPending = false; C.resetExp = 0; }
    C.editing = '';
    C.armed = '';
    C.forgetProxy();
    if (!h) { C.endReauth(); return; }
    /* 页面还在用这张 reauth（奇趣导入）：做完再结束（离开页面时 pagehide 照旧立刻结束）；这期间又打开了面板就交给那一次的关闭去结束 */
    h.then(function () { if (!o.ms.isShown()) C.endReauth(); });
  }
  return { onOpen: onOpen, onClose: onClose, _state: function () { return { st: C.st, layer: C.layer, mode: C.mode, inReset: C.inReset, resetPending: C.resetPending }; } };
}
