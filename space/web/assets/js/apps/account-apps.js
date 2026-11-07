/**
 * @fileoverview 账号 → 应用授权（/account/apps/，P3-1 第 3 件）：核查账号授权给各应用的权限。
 *
 * - 进页 POST /api/account { action:'grant-list' }（服务端先跑幂等种子）：没有账号会话（401）→ 回账号页登录，登录后回本页
 * - 搜索框（按名称，中英名都比）+ 过滤条件「全部 / 已授权 / 已取消授权」（带数量）：页内轻量过滤（只有 5 个应用）
 * - 一卡一应用：图标 + 应用名；作用域说明（敏感操作另要验证账号）；授权时间；授权时的设备（已删 → 已退出的设备）
 * - 「取消授权」→ grant-revoke（不要复验，只降权）→ 卡片变灰，按钮换成「重新授权」
 * - 「重新授权」：grant-add；回 401 reauth → 底部弹层验证账号（通行密钥 / 密码，reauth:true 换 3 分钟票，账号页现有的复验层）→ 再 grant-add
 */
import { on, delegate } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { openSheet, closeSheet } from '../shell/sheet.js';
import { createT, goAccountLogin } from './account-common.js';
import { ACCOUNT_API, postJSON, errText } from '../auth/account-api.js';
import { accountSubmitters, renderAccountMethods, visibleKinds } from '../auth/account-methods.js';
import { appIcon, appName, scopeText, sensitiveText, fmtGrantDate, deviceText, filterGrants, countGrants } from './account-grants.js';
import { i18nTable } from '../lib/i18n.js';
/** 界面文案：页面字符串表 #sgx-i18n-account（语言包化 2026-11-07；当前语言已叠在英文上） */
const tx = i18nTable('account');

(function () {
  const root = document.getElementById('acct-apps');
  if (!root) return;
  const en = document.documentElement.lang === 'en';
  const t = createT();
  const list = document.getElementById('acct-apps-list');
  const empty = document.getElementById('acct-apps-empty');
  const q = /** @type {HTMLInputElement|null} */ (document.getElementById('acct-apps-q'));
  const chips = Array.prototype.slice.call(root.querySelectorAll('[data-ga-filter]'));
  /** @type {any[]} */ let grants = [];
  let filter = 'all';

  const LABEL = { all: 'gaAll', on: 'gaOn', off: 'gaOff' };
  chips.forEach(function (/** @type {HTMLElement} */ c) {
    const l = c.querySelector('[data-ga-label]');
    if (l) l.textContent = t(LABEL[/** @type {'all'|'on'|'off'} */ (c.getAttribute('data-ga-filter'))]);
  });

  /** @param {string} key @param {string} value */
  function metaRow(key, value) {
    const row = document.createElement('div');
    row.className = 'acct-app-meta';
    const k = document.createElement('span');
    k.className = 'acct-app-meta-k';
    k.textContent = t(key);
    const v = document.createElement('span');
    v.className = 'acct-app-meta-v';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  /** @param {any} g */
  function card(g) {
    const name = appName(g, en);
    const sec = document.createElement('section');
    sec.className = 'widget bg-m-container-lowest border border-m-outline overflow-hidden acct-app-card' + (g.granted ? '' : ' is-off');
    sec.setAttribute('data-app', g.app);
    sec.setAttribute('aria-label', name);

    const body = document.createElement('div');
    body.className = 'acct-app-body';
    const head = document.createElement('div');
    head.className = 'acct-row acct-app-head';
    head.appendChild(appIcon(g.app));
    /* 别叫 tx：模块级 tx 是字符串表取文案函数，同名局部变量会把它遮住（下面 tx('gaSensSep') 报 not a function，整页 0 张卡） */
    const txt = document.createElement('span');
    txt.className = 'flex-1 min-w-0';
    const nm = document.createElement('span');
    nm.className = 'block font-medium truncate acct-app-name';
    nm.textContent = name;
    txt.appendChild(nm);
    head.appendChild(txt);
    body.appendChild(head);

    const info = document.createElement('div');
    info.className = 'acct-app-info';
    const sens = sensitiveText(t, g);
    info.appendChild(metaRow('gaScopeLabel', scopeText(t, g) + (sens ? tx('gaSensSep') + sens : '')));
    if (g.granted) {
      info.appendChild(metaRow('gaAtLabel', fmtGrantDate(g.grantedAt, en)));
      info.appendChild(metaRow('gaDevLabel', deviceText(t, g)));
    }
    body.appendChild(info);
    sec.appendChild(body);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = g.granted ? 'lockmgr-delrow acct-app-revoke' : 'lockmgr-add acct-app-regrant';
    btn.textContent = g.granted ? t('gaRevoke') : t('gaRegrant');
    btn.setAttribute('data-ga-act', g.granted ? 'revoke' : 'add');
    btn.setAttribute('data-ga-app', g.app);
    btn.setAttribute('aria-label', btn.textContent + ' ' + name);
    sec.appendChild(btn);
    return sec;
  }

  function render() {
    const n = countGrants(grants);
    chips.forEach(function (/** @type {HTMLElement} */ c) {
      const f = c.getAttribute('data-ga-filter') || 'all';
      c.setAttribute('aria-pressed', f === filter ? 'true' : 'false');
      const el = c.querySelector('[data-ga-n]');
      if (el) el.textContent = String(n[/** @type {'all'|'on'|'off'} */ (f)]);
    });
    if (!list) return;
    list.textContent = '';
    const shown = filterGrants(grants, filter, q ? q.value : '');
    shown.forEach(function (g) { list.appendChild(card(g)); });
    if (empty) empty.hidden = shown.length !== 0;
  }

  /** @param {any} res postJSON 结果 @returns {boolean} 已处理 */
  function handleList(res) {
    if (res.s === 401 && !(res.j && res.j.error === 'reauth')) { goAccountLogin(en); return true; }
    if (res.j && res.j.ok && Array.isArray(res.j.grants)) {
      grants = res.j.grants;
      render();
      root.hidden = false;
      return true;
    }
    return false;
  }

  function load() {
    postJSON(ACCOUNT_API, { action: 'grant-list' }).then(function (res) {
      if (!handleList(res)) toast(errText(t, res.j && res.j.error, res.s));
    }, function () { toast(t('errNetwork')); });
  }

  /** @param {string} app */
  function nameOf(app) {
    const g = grants.filter(function (x) { return x.app === app; })[0];
    return g ? appName(g, en) : app;
  }

  /** @param {HTMLButtonElement} btn @param {string} app */
  function revoke(btn, app) {
    btn.disabled = true;
    postJSON(ACCOUNT_API, { action: 'grant-revoke', app: app }).then(function (res) {
      if (handleList(res)) { if (res.j && res.j.ok) toast(t('gaRevoked').replace('{v}', nameOf(app))); return; }
      btn.disabled = false;
      toast(errText(t, res.j && res.j.error, res.s));
    }, function () { btn.disabled = false; toast(t('errNetwork')); });
  }

  /** 重新授权要账号复验：底部弹层里放验证行（账号通行密钥 / 密码），通过后（拿到 3 分钟复验票）再 grant-add @param {string} app */
  function askReauth(app) {
    fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .catch(function () { return null; })
      .then(function (status) {
        openSheet({ title: t('gaVerifyTitle'), html: '<div class="sgx-credential-methods acct-app-verify" id="acct-app-verify"></div>' });
        const el = document.getElementById('acct-app-verify');
        if (!el) return;
        renderAccountMethods({
          el: el,
          t: function (k) { return k === 'verifyBtn' ? t('reauthVerifyBtn') : t(k); },
          en: en,
          kinds: visibleKinds(status && status.ok ? status : null),
          submit: accountSubmitters(t, { reauth: true }),
          onSuccess: function () { closeSheet('verified'); add(app, true); },
        });
      });
  }

  /** @param {string} app @param {boolean} [verified] 刚验过（再要复验就不再弹，直接报错） */
  function add(app, verified) {
    postJSON(ACCOUNT_API, { action: 'grant-add', app: app }).then(function (res) {
      if (res.s === 401 && res.j && res.j.error === 'reauth' && !verified) { askReauth(app); return; }
      if (handleList(res)) { if (res.j && res.j.ok) toast(t('gaRegranted').replace('{v}', nameOf(app))); return; }
      toast(errText(t, res.j && res.j.error, res.s));
    }, function () { toast(t('errNetwork')); });
  }

  delegate(root, 'click', '[data-ga-act]', function (/** @type {Event} */ e, /** @type {HTMLButtonElement} */ btn) {
    const el = btn || /** @type {HTMLButtonElement} */ (/** @type {HTMLElement} */ (e.target).closest('[data-ga-act]'));
    if (!el || el.disabled) return;
    const app = el.getAttribute('data-ga-app') || '';
    if (el.getAttribute('data-ga-act') === 'revoke') revoke(el, app);
    else add(app);
  });
  chips.forEach(function (/** @type {HTMLElement} */ c) {
    on(c, 'click', function () {
      filter = c.getAttribute('data-ga-filter') || 'all';
      render();
    });
  });
  if (q) on(q, 'input', render);

  load();
})();
