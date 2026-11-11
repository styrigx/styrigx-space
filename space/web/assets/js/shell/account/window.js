/**
 * @fileoverview 账号卡片（头像点开，S9，Gray 2026-11-11：只展示）。
 *
 * 已登录（v6 身份，非救援）：头像 · 姓名 · 昵称 · 已登录，下面几行——个人资料 › · 设备 › · 账号安全 › · 应用授权 › · 退出登录（行和外观同 v5 卡片，GUI 不改）。
 * 没登录：头像（灰）· 未登录，一行「登录 su root」（v5 卡片，命令改 su root，Gray 11-11 17:51）。
 * 卡片里没有命令行：点一行（或头像 / 编辑）= 收起卡片、打开全站终端、输入行预填对应的命令（不替人回车）：
 *   个人资料 → profile · 设备 → device · 账号安全 → passkey · 应用授权 → app · 退出登录 → exit · 登录 → su root。
 * v6 P4（定稿 v5.2 §七「访客点击预填 su 」、§十三 删旧会话）起登录状态只看终端的 v6 身份（who.v6()），不再问旧的 GET /api/account、
 * 不再读写旧登录标记 cookie sgx-account-signed-in。
 *
 * 只 import lib/、shell/（check-layers 规则 3）。文案在外壳字符串表 account.*（sgx-shell-i18n），四个站同一份。
 */
import { esc } from '../../lib/util.js';
import { readCache, effectiveProfile, profileDefaults, PROFILE_EVENT } from '../../lib/profile.js';
import { flatStrings } from '../term/core/strings.js';
import * as api from './api.js';
import { layerFromPath } from './commands.js';

/** 嵌套字符串表 → 点号键：终端统一 T1 起在 shell/term/core/strings.js，这里转出 */
export { flatStrings };

/** 页面入口给的名字 → 怎么开（commands.js；topbar-panel.js 的 accountLayer） */
export { layerFromPath };

/** 卡片的行 → 终端里预填的命令（行和外观同 v5 卡片；「登录」行 sudo root → su root，Gray 11-11 17:51，定稿 §十三 P4） */
export const CARD_CMDS = Object.freeze({ profile: 'profile', devices: 'device', keys: 'passkey', grants: 'app', exit: 'exit', login: 'su root' });

/**
 * 挂到 #sgx-acct 上。
 * @param {{
 *   dlg: HTMLDialogElement,
 *   ms: any,
 *   S: any,
 *   run: (cmd: string) => void,
 *   who?: { v6?: () => any, on?: (f: (w: string) => void) => void } | null,
 * }} o S = 外壳字符串表的 account 节（嵌套）；run = 收起卡片、打开终端预填这条命令；who = 全站终端的身份（core/who.js）
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
  /** 已授权应用数（主页「应用授权」右边，O14）；没取到 → '' */
  let grantN = '';

  /** @param {string} s */
  function setSt(s) {
    st = s;
    dlg.setAttribute('data-acct-state', s);
  }
  /** 当前 v6 身份（救援会话不算登录，同页面标记 pageStateFor） */
  function me() {
    const u = o.who && typeof o.who.v6 === 'function' ? o.who.v6() : null;
    return u && u.name && u.rescue !== true ? u : null;
  }

  /** 一行（按钮：点 = 终端预填 data-at-run 的命令） @param {{k: string, v?: string, run: string, cls?: string, chev?: boolean, attrs?: string}} r */
  function row(r) {
    return '<button type="button" class="sgx-pop-row sgx-at-r' + (r.cls ? ' ' + r.cls : '') + '" data-at-run="' + esc(r.run) + '"' + (r.attrs || '') + '>' +
      '<span class="sgx-at-k"><span class="sgx-pop-k">' + esc(r.k) + '</span></span>' +
      '<span class="sgx-pop-v">' + esc(r.v || '') + '</span>' + (r.chev ? '<span class="sgx-pop-chev" aria-hidden="true">›</span>' : '') + '</button>';
  }
  /** 卡片头：头像 · 名字 · 状态 @param {string} run 点头像 / 编辑跑哪条 */
  function head(run) {
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
      root.innerHTML = head(CARD_CMDS.login) + '<div class="sgx-pop-list">' + row({ k: t('session.signIn'), v: CARD_CMDS.login, run: CARD_CMDS.login, cls: 'sgx-pop-row--acc', attrs: ' translate="no"' }) + '</div>';
      return;
    }
    root.innerHTML = head(CARD_CMDS.profile) +
      '<div class="sgx-pop-list">' +
      row({ k: t('profile.title'), v: t('profile.hint'), run: CARD_CMDS.profile, chev: true }) +
      row({ k: t('devices.title'), v: t('devices.this'), run: CARD_CMDS.devices, chev: true }) +
      row({ k: t('keys.title'), v: t('keys.hint'), run: CARD_CMDS.keys, chev: true }) +
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
  /* 终端身份问完服务端（whoami）晚于卡片打开时（首帧、旧地址 #acct）：开着就按新身份重画（同 main 里 GET /api/account 回来后校正） */
  if (o.who && typeof o.who.on === 'function') o.who.on(function () { if (o.ms.isShown()) onOpen(); });

  /** 打开时（topbar-panel 的 onOpen）：按终端的 v6 身份画（数据源从旧 GET /api/account 改接 v6，外观不变）；root 另取已授权应用数（grants 接口是 root 档） */
  function onOpen() {
    const u = me();
    setSt(u ? 'in' : 'guest');
    render();
    if (u && u.root) loadGrants();
  }
  return { onOpen: onOpen, onClose: function () {}, _state: function () { return { st: st }; } };
}
