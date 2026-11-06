/**
 * @fileoverview 应用授权（P3-1）共用：授权卡页（/account/apps/，apps/account-apps.js）和登录后的同意卡片（apps/account.js）。
 *
 * - 数据：POST /api/account grant-list / grant-revoke / grant-add 回的 grants（服务端 workers/account/src/api/account.js grantListView）：
 *   [{ app, name:{zh,en}, scopes, sensitive, granted, grantedAt, by, device:{name, gone}|null }]，按作用域表顺序。
 * - 文案在 #sgx-i18n-account（partials/account-i18n.html 的 ga* 键）；应用图标在 partials/account-app-icons.html 的 <template>。
 * - appReturn：同意流程的回跳（应用内点登录 → /account/?return=<应用页>）认出是奇趣还是日刻；回跳地址的校验交给网关
 *   （/api/lock-session-check?return=，core/return.js safeReturn）。主站内功能（设置同步、数字健康、头像）的授权走管理页 /account/apps/，不走同意流程。
 *
 * 只 import lib/ 和本目录。
 */
import { langPath } from '../lib/lang-path.js';

/** 授权卡页地址 @param {boolean} en */
export function appsUrl(en) {
  return langPath('/account/apps/', en ? 'en' : 'zh');
}

/* 应用站的路径前缀（站内路径或 https://styrigx.com/ 下）：只用来认出是哪个应用。回跳地址本身不在这里校验，
   由网关 /api/lock-session-check?return= 的 safeReturn 校验（现有登录跳转，apps/account.js goBack） */
const APP_PATH_RE = /^(?:https:\/\/styrigx\.com)?\/(curio|daymark)(?:[/?#]|$)/;

/**
 * 同意流程的回跳：?return= 指向奇趣 / 日刻 → { app, ret }（ret 原样交给网关校验）；否则 null。
 * @param {unknown} ret ?return= 的值（URLSearchParams 已解一层码）
 * @returns {{app: string, ret: string}|null}
 */
export function appReturn(ret) {
  if (typeof ret !== 'string' || !ret || ret.length > 2048) return null;
  const m = APP_PATH_RE.exec(ret);
  return m ? { app: m[1], ret: ret } : null;
}

/**
 * 应用名（当前语言）。
 * @param {any} g grants 的一项
 * @param {boolean} en
 */
export function appName(g, en) {
  const n = g && g.name;
  return (n && (en ? n.en : n.zh)) || (g && g.app) || '';
}

/**
 * 作用域说明（可以做什么）。敏感操作另起一句。
 * @param {function(string): string} t
 * @param {any} g
 */
export function scopeText(t, g) {
  return t('gaDesc-' + g.app);
}

/**
 * 敏感操作说明（只有奇趣的批量导入）；没有 → ''。
 * @param {function(string): string} t
 * @param {any} g
 */
export function sensitiveText(t, g) {
  if (!g || !Array.isArray(g.sensitive) || g.sensitive.length === 0) return '';
  return t('gaSensitive').replace('{v}', t('gaSens-' + g.app));
}

/**
 * 授权时间：年月日（本地时区）。
 * @param {number} ts 毫秒
 * @param {boolean} en
 */
export function fmtGrantDate(ts, en) {
  if (!ts) return '';
  const d = new Date(ts);
  if (en) {
    try {
      return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
    } catch (e) {}
  }
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/**
 * 授权时的设备：设备行还在 → 设备名（没名字 → 未知设备）；已退出 / 已删 → 已退出的设备。
 * @param {function(string): string} t
 * @param {any} g
 */
export function deviceText(t, g) {
  const d = g && g.device;
  if (!d || d.gone) return t('gaDevGone');
  return d.name || t('gaDevUnknown');
}

/**
 * 应用图标（克隆 partials/account-app-icons.html 的 <template>）；没有 → 空圆。
 * @param {string} app
 * @returns {HTMLElement}
 */
export function appIcon(app) {
  const tpl = /** @type {HTMLTemplateElement|null} */ (document.getElementById('acct-app-ic-' + app));
  const el = tpl && tpl.content && tpl.content.firstElementChild ? /** @type {HTMLElement} */ (tpl.content.firstElementChild.cloneNode(true)) : null;
  if (el) return el;
  const s = document.createElement('span');
  s.className = 'acct-ic bg-m-container-high';
  return s;
}

/**
 * 过滤 + 搜索（页内轻量）：filter = all | on | off；q 按应用名（中英都比，忽略大小写）。
 * @param {any[]} grants
 * @param {string} filter
 * @param {string} q
 */
export function filterGrants(grants, filter, q) {
  const k = String(q || '').trim().toLowerCase();
  return (grants || []).filter(function (g) {
    if (filter === 'on' && !g.granted) return false;
    if (filter === 'off' && g.granted) return false;
    if (!k) return true;
    const n = g.name || {};
    return [n.zh, n.en, g.app].some(function (s) { return typeof s === 'string' && s.toLowerCase().indexOf(k) !== -1; });
  });
}

/**
 * 过滤条件的数量。
 * @param {any[]} grants
 * @returns {{all:number, on:number, off:number}}
 */
export function countGrants(grants) {
  const all = (grants || []).length;
  const on = (grants || []).filter(function (g) { return g.granted; }).length;
  return { all: all, on: on, off: all - on };
}
