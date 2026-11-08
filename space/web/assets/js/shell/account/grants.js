/**
 * @fileoverview 应用授权（G1–G7）+ 奇趣 / 日刻的授权同意（A17，O6）。
 *
 * - `$ grep` 按名称搜（中英文名都比）、标签：全部 / 已授权 / 已取消授权（带数量）
 * - 一个应用一行：名字 + `scope · 说明`（敏感操作另要验证）+ 授权时间和设备；开关：关 = 取消授权（不用验证），开 = 重新授权（sudo root reauth，有效期内不再问）
 * - 授权同意：登录后判授权，已授权直接回原页；没授权 → 终端 `[y] 允许 [n] 拒绝`（拒绝不写记录）
 * 设置同步（prefs）的授权留着（O9）。
 */
import { mmdd } from './keys.js';

/** 应用 → 显示顺序（同 workers/account/src/core/scopes.js） */
export const APP_IDS = Object.freeze(['curio', 'daymark', 'prefs', 'wellbeing', 'avatar', 'profile']);

/**
 * 应用授权的筛选（grep + 标签）。
 * @param {any[]} grants @param {'all'|'on'|'off'} f @param {string} q @param {(k: string) => string} t
 */
export function filterGrants(grants, f, q, t) {
  const qq = String(q || '').trim().toLowerCase();
  return grants.filter(function (g) {
    if (f === 'on' && !g.granted) return false;
    if (f === 'off' && g.granted) return false;
    if (!qq) return true;
    return [t('grants.app.' + g.app), g.name || '', g.app].some(function (s) { return String(s).toLowerCase().indexOf(qq) !== -1; });
  });
}

/** @param {any} C */
export function mountGrants(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** @type {any[]|null} */
  C.grants = null;
  let filter = /** @type {'all'|'on'|'off'} */ ('all');
  let query = '';

  /** @param {string} app */
  const appName = function (app) { return t('grants.app.' + app) || app; };
  /**
   * 应用图标（奇趣 / 日刻，#327 偏离修复）：外壳骨架 <template data-acct-app-icons> 里导航已有的 SVG；其余应用没有图标，留空位对齐
   * @param {string} app @returns {string}
   */
  const appIcon = function (app) {
    let svg = '';
    try {
      const tpl = /** @type {HTMLTemplateElement|null} */ (C.dlg.querySelector('template[data-acct-app-icons]'));
      const el = tpl && tpl.content.querySelector('[data-app="' + app + '"] svg');
      if (el) svg = el.outerHTML;
    } catch (e) {}
    return '<span class="sgx-at-appi" aria-hidden="true">' + svg + '</span>';
  };
  /** @param {any} g */
  const sensText = function (g) { return g.sensitive && g.sensitive.length && t('grants.sens.' + g.app) ? tf('grants.sensitive', { v: t('grants.sens.' + g.app) }) : ''; };

  C.renderGrants = function () {
    C.subHead(t('grants.title'), 'scopes');
    const all = C.grants || [];
    const nOn = all.filter(function (/** @type {any} */ g) { return g.granted; }).length;
    const list = filterGrants(all, filter, query, t);
    let h = '<label class="sgx-at-grep"><span class="sgx-at-p" aria-hidden="true">$</span> <span aria-hidden="true">grep</span><input data-at-grep type="search" value="' + esc(query) + '" placeholder="' + esc(t('grants.grep')) + '" aria-label="' + esc(t('grants.grep')) + '" autocomplete="off" spellcheck="false"></label>' +
      '<div class="sgx-at-chips" role="group">' +
      [['all', t('grants.all'), all.length], ['on', t('grants.on'), nOn], ['off', t('grants.off'), all.length - nOn]].map(function (c) {
        return '<button type="button" class="sgx-at-chip" data-at-act="filter:' + c[0] + '" aria-pressed="' + (filter === c[0] ? 'true' : 'false') + '">' + esc(String(c[1])) + ' ' + c[2] + '</button>';
      }).join('') + '</div>';
    if (C.grants && !list.length) h += C.noteP(t('grants.none'));
    list.forEach(function (/** @type {any} */ g) {
      const name = appName(g.app) || g.name;
      const sens = sensText(g);
      const dev = g.device ? (g.device.gone ? t('grants.deviceGone') : g.device.name || t('devices.unknown')) : '';
      const when = g.granted ? tf('grants.at', { d: mmdd(g.grantedAt) }) + (dev ? ' · ' + dev : '') : t('grants.offAt');
      h += '<div class="sgx-at-app' + (g.granted ? '' : ' is-off') + '" data-app="' + esc(g.app) + '">' + appIcon(g.app) + '<span class="sgx-at-k"><span class="sgx-pop-k">' + esc(name) + '</span>' +
        '<small><span translate="no">' + esc((g.scopes || []).join(' ')) + '</span> · ' + esc(t('grants.desc.' + g.app)) + (sens ? '<br><span class="sgx-at-warn">' + esc(sens) + '</span>' : '') + '<br>' + esc(when) + '</small></span>' +
        '<button type="button" class="sgx-at-sw" role="switch" aria-checked="' + (g.granted ? 'true' : 'false') + '" aria-label="' + esc(name) + '" data-at-act="grant:' + esc(g.app) + '"></button></div>';
    });
    C.viewEl.innerHTML = h;
    C.foot('grants.ft');
    const gi = /** @type {HTMLInputElement|null} */ (C.viewEl.querySelector('[data-at-grep]'));
    if (gi) {
      gi.addEventListener('input', function () {
        query = gi.value;
        const pos = gi.selectionStart;
        C.renderGrants();
        const g2 = /** @type {HTMLInputElement|null} */ (C.viewEl.querySelector('[data-at-grep]'));
        if (g2) { try { g2.focus({ preventScroll: true }); g2.setSelectionRange(pos, pos); } catch (e) {} }
      });
      gi.addEventListener('keydown', function (e) { if (e.key === 'Escape' && gi.value) { e.preventDefault(); e.stopPropagation(); query = ''; C.renderGrants(); } });
    }
  };
  /** @returns {Promise<any[]|null>} */
  C.loadGrants = function () {
    return api.grants.list().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) {
        C.grants = res.j.grants || [];
        const el = C.viewEl.querySelector('[data-at-v="grants"] .sgx-pop-v');
        if (el) el.textContent = C.grantCount();
        if (C.layer === 'grants' && C.st === 'in' && !C.inReset) C.renderGrants();
        return C.grants;
      }
      C.authErr(res);
      return null;
    }, function () { return null; });
  };

  /* ----- 授权同意（奇趣 / 日刻，O6） ----- */
  C.askConsent = function () {
    const app = C.consent ? C.consent.app : '';
    const finish = function () { C.consent = null; C.loginChanged = true; C.o.ms.close(); };
    (C.grants ? Promise.resolve(C.grants) : C.loadGrants()).then(function (/** @type {any} */ gs) {
      const g = (gs || []).find(function (/** @type {any} */ x) { return x.app === app; });
      if (!g || g.granted) { finish(); return; }
      const name = appName(app);
      C.out('<span class="sgx-at-w">' + esc(tf('grants.consent.ask', { v: name })) + '</span>');
      C.out(esc(tf('grants.consent.sub', { v: name })));
      C.out('<span class="sgx-at-dim">·</span> ' + esc(t('grants.desc.' + app)));
      const sens = sensText(g);
      if (sens) C.out('<span class="sgx-at-dim">·</span> <span class="sgx-at-y">' + esc(sens) + '</span>');
      C.opts([['y', t('grants.consent.allow')], ['n', t('grants.consent.deny')]]);
      C.out('# ' + esc(tf('grants.consent.hint', { v: name })), 'd');
      C.pick({
        y: function () {
          C.echoPick('y');
          const add = function () {
            C.setMode('busy');
            api.grants.add(app).then(function (/** @type {any} */ res) {
              if (res.j && res.j.ok) { C.ok('✓ ' + tf('grants.regranted', { v: name })); finish(); return; }
              if (C.api.isErr(res, api.ERR.reauth)) { C.reauthExp = 0; C.withReauth(add, t('reauth.lead.grants')); return; }
              C.apiErr(res);
              finish();
            }, function () { C.netErr(); C.toCmd(); });
          };
          add();
        },
        n: function () { C.echoPick('n'); finish(); },
      });
      C.focusIn();
    });
  };

  /** @param {string} a @returns {boolean} */
  C.actGrants = function (a) {
    if (a.indexOf('filter:') === 0) { filter = /** @type {any} */ (a.slice(7)); C.renderGrants(); return true; }
    if (a.indexOf('grant:') !== 0) return false;
    const app = a.slice(6);
    const g = (C.grants || []).find(function (/** @type {any} */ x) { return x.app === app; });
    if (!g) return true;
    const name = appName(app);
    if (g.granted) {
      api.grants.revoke(app).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { C.grants = res.j.grants || C.grants; C.out(esc(tf('grants.revoked', { v: name })), 'd'); C.renderGrants(); return; }
        if (!C.authErr(res)) C.apiErr(res);
      }, function () { C.netErr(); });
      return true;
    }
    C.withReauth(function () {
      api.grants.add(app).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { C.grants = res.j.grants || C.grants; C.out('<span class="sgx-at-ok">✓</span> ' + esc(tf('grants.regranted', { v: name }))); if (C.layer === 'grants') C.renderGrants(); return; }
        if (!C.authErr(res)) C.apiErr(res);
      }, function () { C.netErr(); });
    }, t('reauth.lead.grants'));
    return true;
  };
}

