/**
 * @fileoverview 账号卡片（头像点开，S9，Gray 2026-11-11：只展示）。
 *
 * 已登录：头像 · 姓名 · 昵称 · 已登录，下面几行——个人资料 › · 设备 › · 账号安全 › · 应用授权 › · 退出登录。
 * 没登录账号：头像（灰）· 账号未登录，一行「登录 sudo root」。
 * 卡片里没有命令行：点一行（或头像 / 编辑）= 收起卡片、打开全站终端、输入行预填对应的命令（不替人回车）：
 *   个人资料 → profile · 设备 → device · 账号安全 → passkey · 应用授权 → app · 退出登录 → exit · 登录 → sudo root。
 * 所有要输入、选择、验证的事都在终端的账号层里（shell/account/cmd/layer.js）；页面入口（[data-acct-open]、旧地址 #acct=…）也交给终端（topbar-panel.js）。
 *
 * 只 import lib/、shell/（check-layers 规则 3）。文案在外壳字符串表 account.*（sgx-shell-i18n），四个站同一份。
 */
import { esc } from '../../lib/util.js';
import { readCache, effectiveProfile, profileDefaults, PROFILE_EVENT } from '../../lib/profile.js';
import { flatStrings } from '../term/core/strings.js';
import * as api from './api.js';
import { CMD, layerFromPath } from './commands.js';

/** 嵌套字符串表 → 点号键：终端统一 T1 起在 shell/term/core/strings.js，这里转出 */
export { flatStrings };

/** 页面入口给的名字 → 怎么开（commands.js；topbar-panel.js 的 accountLayer） */
export { layerFromPath };

/** 登录标记 cookie（账号 Worker 随 session 签发 / 清除，workers/account/src/core/config.js SIGNED_IN_MARKER）：只给首帧画状态，鉴权只认 HttpOnly 的 session */
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

/** 卡片的行 → 终端里预填的命令 */
export const CARD_CMDS = Object.freeze({ profile: 'profile', devices: 'device', keys: 'passkey', grants: 'app', exit: 'exit', login: CMD.session });

/**
 * 挂到 #sgx-acct 上。
 * @param {{
 *   dlg: HTMLDialogElement,
 *   ms: any,
 *   S: any,
 *   run: (cmd: string) => void,
 *   who?: { setAccount: (on: boolean) => void } | null,
 * }} o S = 外壳字符串表的 account 节（嵌套）；run = 收起卡片、打开终端预填这条命令；who = 全站终端的身份（登录状态同步提示符）
 */
export function mountAccountWindow(o) {
  const dlg = o.dlg;
  const doc = dlg.ownerDocument || document;
  const S = flatStrings(o.S || {});
  /** @param {string} k */
  const t = function (k) { return S[k] || ''; };
  const sheet = /** @type {HTMLElement} */ (dlg.querySelector('.sgx-qp-sheet'));
  sheet.innerHTML = '';
  const root = doc.createElement('div');
  root.className = 'sgx-at';
  sheet.appendChild(root);
  /** '' 未知 · in · guest */
  let st = '';
  /** api.status() 的结果 @type {any} */
  let status = null;
  /** 已授权应用数（主页「应用授权」右边，O14）；没取到 → '' */
  let grantN = '';

  /** @param {string} s */
  function setSt(s) {
    st = s;
    dlg.setAttribute('data-acct-state', s);
    try { doc.documentElement.setAttribute('data-sgx-account-session', s === 'in' ? 'in' : 'out'); } catch (e) {}
    if (s && o.who) o.who.setAccount(s === 'in');
  }

  /** 一行（按钮：点 = 终端预填 data-at-run 的命令） @param {{k: string, v?: string, run: string, cls?: string, chev?: boolean, attrs?: string}} r */
  function row(r) {
    return '<button type="button" class="sgx-pop-row sgx-at-r' + (r.cls ? ' ' + r.cls : '') + '" data-at-run="' + esc(r.run) + '"' + (r.attrs || '') + '>' +
      '<span class="sgx-at-k"><span class="sgx-pop-k">' + esc(r.k) + '</span></span>' +
      '<span class="sgx-pop-v">' + esc(r.v || '') + '</span>' + (r.chev ? '<span class="sgx-pop-chev" aria-hidden="true">›</span>' : '') + '</button>';
  }
  /** 卡片头：头像 · 名字 · 状态 @param {string} run 点头像 / 编辑跑哪条 */
  function me(run) {
    const p = effectiveProfile(readCache(), profileDefaults());
    const navImg = /** @type {HTMLImageElement|null} */ (doc.querySelector('#site-nav .sgx-tb-avatar'));
    const src = navImg ? navImg.src.replace(/\/avatar\/\d+\.webp/, '/avatar/192.webp') : '/avatar/192.webp';
    const stateTxt = st === 'in' ? '<i aria-hidden="true">✓</i> ' + esc(t('common.signedIn')) : esc(t('session.guest'));
    return '<div class="sgx-pop-me"><button type="button" class="sgx-pop-me-a" data-at-run="' + esc(run) + '"><img src="' + esc(src) + '" alt="" width="48" height="48" class="sgx-pop-avatar" data-sgx-avatar="192">' +
      '<span class="sgx-pop-who"><b translate="no" data-sgx-personal>' + esc(p.name) + '</b><small><span translate="no" data-sgx-personal>' + esc(p.nickname) + '</span><span class="sgx-pop-state"> · ' + stateTxt + '</span></small></span></button>' +
      (st === 'in' ? '<button type="button" class="sgx-pop-edit" data-at-run="' + esc(run) + '">' + esc(t('common.edit')) + '</button>' : '') + '</div>';
  }

  function render() {
    root.setAttribute('data-at-layer', st === 'in' ? 'home' : 'guest');
    if (st !== 'in') {
      root.innerHTML = me(CARD_CMDS.login) + '<div class="sgx-pop-list">' + row({ k: t('session.signIn'), v: CARD_CMDS.login, run: CARD_CMDS.login, cls: 'sgx-pop-row--acc', attrs: ' translate="no"' }) + '</div>';
      return;
    }
    const s = status;
    const dev = (s && s.session && s.session.device) || t('devices.this');
    const sec = s && (s.configured.password || s.configured.passkey) ? t('keys.hint') : t('keys.unprotected');
    root.innerHTML = me(CARD_CMDS.profile) +
      '<div class="sgx-pop-list">' +
      row({ k: t('profile.title'), v: t('profile.hint'), run: CARD_CMDS.profile, chev: true }) +
      row({ k: t('devices.title'), v: dev, run: CARD_CMDS.devices, chev: true }) +
      row({ k: t('keys.title'), v: sec, run: CARD_CMDS.keys, chev: true }) +
      row({ k: t('grants.title'), v: grantN, run: CARD_CMDS.grants, chev: true, attrs: ' data-at-v="grants"' }) +
      '</div><div class="sgx-pop-list sgx-pop-list--line">' + row({ k: t('common.signOut'), v: CARD_CMDS.exit, run: CARD_CMDS.exit, cls: 'sgx-pop-row--acc' }) + '</div>';
  }

  function loadGrants() {
    api.grants.list().then(function (/** @type {any} */ res) {
      if (!(res.j && res.j.ok)) return;
      grantN = String((res.j.grants || []).filter(function (/** @type {any} */ g) { return g.granted; }).length);
      const el = root.querySelector('[data-at-v="grants"] .sgx-pop-v');
      if (el) el.textContent = grantN;
    }, function () {});
  }

  root.addEventListener('click', function (e) {
    const tg = /** @type {Element|null} */ (e.target);
    const a = tg && /** @type {HTMLElement|null} */ (tg.closest('[data-at-run]'));
    if (!a) return;
    e.preventDefault();
    o.run(a.getAttribute('data-at-run') || '');
  });
  try {
    window.addEventListener(PROFILE_EVENT, function () { if (o.ms.isShown()) render(); });
  } catch (e) {}

  /** 打开时（topbar-panel 的 onOpen）：首帧按登录标记画，GET /api/account 回来后校正 */
  function onOpen() {
    if (!st) {
      let ff = /** @type {'in'|'guest'|''} */ ('');
      try { ff = firstFrameState(doc.cookie); } catch (e) {}
      setSt(ff);
    }
    render();
    api.status().then(function (s) {
      if (!s) { if (!st) setSt('guest'); render(); return; }
      status = s;
      correctSignedInMarker(doc, s);
      setSt(s.session ? 'in' : 'guest');
      render();
      if (st === 'in') loadGrants();
    }, function () { if (!st) setSt('guest'); render(); });
  }
  return { onOpen: onOpen, onClose: function () {}, _state: function () { return { st: st }; } };
}
