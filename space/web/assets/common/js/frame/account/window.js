/**
 * @fileoverview 账号卡片（头像点开，S9，Gray 2026-11-11：只展示）。
 *
 * 站长与 root（v6 身份，非救援）：头像 · 姓名 · 昵称 · 已登录，下面几行——
 *   个人资料 › · 设备 › · 退出登录 lock（定稿 v5.5 §七「账号页只留个人信息卡、设备卡、一个退出按钮 lock（回访客、清整栈）……沿用现有账号页，去掉账号安全卡，
 *   原 exit 按钮改成 lock」，Gray 2026-11-11 20:10 / 20:20；行和外观同 v5 卡片；应用授权行随应用授权删除，定稿 v5.3 §十二）。
 * 普通用户（uid 1001 起，R-33 Gray 2026-11-14 22:40）：小展示卡——站点头像 · 自己的用户名 · 已登录，只一行「退出登录 lock」，没有编辑类内容（不显示编辑、个人资料、设备）。
 * 没登录（访客，R-33）：点头像弹登录小展示卡——站点头像 · 站长名片（GET /api/profile 公开，访客在卡片打开时才问，回来后经 PROFILE_EVENT 重画）· 访客，一行「登录 su 」；
 *   点了仍是收起卡片、打开终端预填命令，不做 GUI 登录页（Gray 2026-11-14 23:06）。预填同原先访客点头像的「su 」（定稿 v5.2 §七）。
 * 卡片里没有命令行：点一行（或头像 / 编辑）= 收起卡片、打开全站终端、输入行预填对应的命令（不替人回车）：
 *   个人资料 → profile · 设备 → device（站长直读，定稿 v5.5 §七）· 退出登录 → lock · 登录 → su （R-33，不强制 root）。
 *   密码与通行密钥只走终端 passwd、passkey（定稿 v5.5 §七，不做账号安全卡）。
 * v6 P4（定稿 v5.2 §七「访客点击预填 su 」、§十三 删旧会话）起登录状态只看终端的 v6 身份（who.v6()），不再问旧的 GET /api/account、
 * 不再读写旧登录标记 cookie sgx-account-signed-in。
 *
 * 只 import lib/、shell/（check-layers 规则 3）。文案在外壳字符串表 account.*（frame/i18n），四个站同一份。
 */
import { esc } from '../../core/util.js';
import { readCache, effectiveProfile, profileDefaults, fetchProfile, PROFILE_EVENT } from '../../prefs/profile.js';
import { flatStrings } from '../term/core/strings.js';
import { layerFromPath } from './commands.js';

/** 嵌套字符串表 → 点号键：终端统一 T1 起在 term/core/strings.js，这里转出 */
export { flatStrings };

/** 页面入口给的名字 → 怎么开（commands.js；topbar/panel.js 的 accountLayer） */
export { layerFromPath };

/** 卡片的行 → 终端里预填的命令（行和外观同 v5 卡片；「登录」行 sudo root → su root，Gray 11-11 17:51，定稿 §十三 P4；
 * P4-3：账号安全行删除、退出行 exit → lock，定稿 v5.5 §七） */
export const CARD_CMDS = Object.freeze({ profile: 'profile', devices: 'device', lock: 'lock', login: 'su ' });

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
  /** '' 未知 · in（站长 / root）· user（普通用户）· guest */
  let st = '';

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
  /** 卡片头：头像 · 名字 · 状态 @param {string} run 点头像 / 编辑跑哪条（'' = 只展示，不可点） */
  function head(run) {
    const p = effectiveProfile(readCache(), profileDefaults());
    const u = me();
    const navImg = /** @type {HTMLImageElement|null} */ (doc.querySelector('#site-nav .sgx-tb-avatar'));
    const src = navImg ? navImg.src.replace(/\/avatar\/\d+\.webp/, '/avatar/192.webp') : '/avatar/192.webp';
    const signed = st === 'in' || st === 'user';
    const stateTxt = signed ? '<i aria-hidden="true">✓</i> ' + esc(t('common.signedIn')) : esc(t('session.guest'));
    /* 普通用户：名字写自己的用户名（头像仍是站点头像，定稿 v5.5 §七），副行不写站长昵称 */
    const whoHtml = st === 'user' && u
      ? '<span class="sgx-pop-who"><b translate="no">' + esc(u.name) + '</b><small><span class="sgx-pop-state">' + stateTxt + '</span></small></span>'
      : '<span class="sgx-pop-who"><b translate="no" data-sgx-personal>' + esc(p.name) + '</b><small><span translate="no" data-sgx-personal>' + esc(p.nickname) + '</span><span class="sgx-pop-state"> · ' + stateTxt + '</span></small></span>';
    const img = '<img src="' + esc(src) + '" alt="" width="48" height="48" class="sgx-pop-avatar" data-sgx-avatar="192">';
    const a = run
      ? '<button type="button" class="sgx-pop-me-a" data-at-run="' + esc(run) + '">' + img + whoHtml + '</button>'
      : '<div class="sgx-pop-me-a">' + img + whoHtml + '</div>';
    return '<div class="sgx-pop-me">' + a +
      (st === 'in' ? '<button type="button" class="sgx-pop-edit" data-at-run="' + esc(run) + '">' + esc(t('common.edit')) + '</button>' : '') + '</div>';
  }

  function render() {
    root.setAttribute('data-at-layer', st === 'in' ? 'home' : st === 'user' ? 'user' : 'guest');
    if (st === 'user') {
      root.innerHTML = head('') + '<div class="sgx-pop-list">' + row({ k: t('common.signOut'), v: CARD_CMDS.lock, run: CARD_CMDS.lock, cls: 'sgx-pop-row--acc' }) + '</div>';
      return;
    }
    if (st !== 'in') {
      /* 访客：页面加载时不问公开名片，开卡时才问（同页只发一次；回来后 PROFILE_EVENT 重画） */
      fetchProfile();
      root.innerHTML = head(CARD_CMDS.login) + '<div class="sgx-pop-list">' + row({ k: t('session.signIn'), v: CARD_CMDS.login.trim(), run: CARD_CMDS.login, cls: 'sgx-pop-row--acc', attrs: ' translate="no"' }) + '</div>';
      return;
    }
    root.innerHTML = head(CARD_CMDS.profile) +
      '<div class="sgx-pop-list">' +
      row({ k: t('profile.title'), v: t('profile.hint'), run: CARD_CMDS.profile, chev: true }) +
      row({ k: t('devices.title'), v: t('devices.this'), run: CARD_CMDS.devices, chev: true }) +
      '</div><div class="sgx-pop-list sgx-pop-list--line">' + row({ k: t('common.signOut'), v: CARD_CMDS.lock, run: CARD_CMDS.lock, cls: 'sgx-pop-row--acc' }) + '</div>';
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

  /** 打开时（topbar/panel.js 的 onOpen）：按终端的 v6 身份画（数据源从旧 GET /api/account 改接 v6，外观不变） */
  function onOpen() {
    const u = me();
    setSt(!u ? 'guest' : u.root || u.webmaster === true ? 'in' : 'user');
    render();
  }
  return { onOpen: onOpen, onClose: function () {}, _state: function () { return { st: st }; } };
}
