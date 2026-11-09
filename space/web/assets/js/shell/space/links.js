/**
 * @fileoverview 盾牌 → 分享链接（管理页）。Q3 定稿（Gray 2026-11-09 08:00）：「新建」只要进站会话（临时钥匙、分享链接进来的人也能发，
 * 快捷面板「分享本页」不验证）；进管理页一律 reauth（reauth 只认解锁密码 / 通行密钥）——所以这一层要 reauth。原 /security/tempkeys/ 的分享链接一节删了。
 *
 * - 列表：名字 · 打开的页面 · 剩余 · 带不带会话；作废一条（两步）· 全部作废（两步）
 * - 新建：名字（可空）→ 打开哪一页（回车 = 当前页）→ 链接有效期 → 带不带会话（不超过有效期）→ 链接 + 复制
 * 后端经 api.links.*（share Worker /api/share）。
 */
import { cleanPasskeyName } from '../../auth/passkey-register.js';
import { shortLeft, copyText } from './tempkeys.js';

/** 链接有效期：[键, 请求, 显示, 毫秒] */
export const LINK_DURATIONS = Object.freeze([
  ['1', { hours: 1 }, '1h', 36e5], ['2', { hours: 24 }, '24h', 864e5], ['3', { days: 3 }, '3d', 3 * 864e5],
  ['4', { days: 7 }, '7d', 7 * 864e5], ['5', { days: 30 }, '30d', 30 * 864e5],
]);
/** 会话档位（秒；0 = 普通链接，不带会话）：同 workers/share/src/lib/links.js SESSION_OPTS */
export const LINK_SESSIONS = Object.freeze([['0', 0, 'none'], ['1', 1800, '30m'], ['2', 3600, '1h'], ['3', 12 * 3600, '12h'], ['4', 86400, '1d'], ['5', 7 * 86400, '7d']]);
const ORIGIN = 'https://styrigx.com';

/** 当前页（去掉锁屏 / 回跳 / 分享自己的参数） */
export function currentTarget() {
  try {
    const u = new URL(location.href);
    ['entry', 'lock', 'why', 'return', 'share'].forEach(function (k) { u.searchParams.delete(k); });
    return u.pathname + (u.search && u.search !== '?' ? u.search : '');
  } catch (e) { return '/'; }
}

/** @param {any} C 盾牌上下文 */
export function mountLinks(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** @type {any[]|null} */ let list = null;

  C.renderLinks = function () {
    C.subHead(t('links.title'));
    if (!C.reauthLeft()) { C.viewEl.innerHTML = ''; C.foot('reauth.ft'); return; }
    let h = '<div class="sgx-pop-list">' + C.grp(t('links.listTitle'));
    const live = (list || []).filter(function (/** @type {any} */ l) { return l.status === 'active'; });
    if (list === null) h += C.noteP(t('common.loading'));
    else if (!live.length) h += C.noteP(t('links.none'));
    else live.forEach(function (/** @type {any} */ l) {
      const a = C.armed === 'ln:' + l.id;
      const sub = [l.to, tf('links.left', { t: shortLeft(l.expiresAt - Date.now()) }), l.session ? t('links.withSession') : t('links.plain')].join(' · ');
      h += C.row({
        k: l.name || l.to,
        kHtml: '<span translate="no" data-sgx-personal>' + esc(l.name || l.to) + '</span>',
        sub: sub,
        vHtml: (l.path ? '<button type="button" class="sgx-at-acc sgx-at-del" data-sh-act="ln-copy:' + esc(l.id) + '">' + esc(t('common.copy')) + '</button> ' : '') +
          '<button type="button" class="sgx-at-acc sgx-at-del" data-sh-act="ln:' + esc(l.id) + '">' + esc(a ? t('links.revokeAsk') : t('links.revoke')) + '</button>',
        armed: a,
      });
    });
    h += C.row({ k: t('links.add'), v: 'share new', act: 'ln-new', cls: 'sgx-pop-row--acc' });
    if (live.length) {
      const aa = C.armed === 'ln-all';
      h += '</div><div class="sgx-pop-list sgx-pop-list--line">' + C.row({ k: t('links.revokeAll'), v: aa ? t('links.revokeAsk') : 'share revoke --all', act: 'ln-all', cls: 'sgx-pop-row--acc', armed: aa });
    }
    h += '</div>';
    C.viewEl.innerHTML = h;
    C.foot('links.ft');
  };
  C.enterLinks = function () { list = null; C.render(); load(); C.startTick(); };
  function load() {
    return api.links.list().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { list = res.j.links || []; if (C.layer === 'links') C.render(); return; }
      if (!C.authErr(res)) C.err(api.errText(t, res.j && res.j.error, res.s));
    }, function () { C.err(t('common.errNetwork')); });
  }

  function create() {
    C.echo('share new');
    const here = currentTarget();
    C.out(esc(t('links.nameAsk')) + ':');
    C.ask('pkname', function (/** @type {string} */ v) {
      const name = cleanPasskeyName(v).slice(0, 24);
      C.out(esc(t('links.toAsk')) + ' [' + esc(here) + ']:');
      C.ask('pkname', function (/** @type {string} */ v2) {
        const to = v2.trim() || here;
        C.out(esc(t('links.durAsk')));
        C.opts(LINK_DURATIONS.map(function (d) { return /** @type {[string, string, boolean?]} */ ([String(d[0]), String(d[2]), d[0] === '2']); }));
        /** @type {Record<string, () => void>} */ const pd = {};
        LINK_DURATIONS.forEach(function (d) {
          pd[String(d[0])] = function () {
            C.echoPick(String(d[0]));
            const ms = Number(d[3]);
            const ss = LINK_SESSIONS.filter(function (s) { return Number(s[1]) * 1000 <= ms; });
            C.out(esc(t('links.sessAsk')));
            C.opts(ss.map(function (s) { return /** @type {[string, string, boolean?]} */ ([String(s[0]), s[1] ? String(s[2]) : t('links.plain'), s[0] === '0']); }));
            /** @type {Record<string, () => void>} */ const ps = {};
            ss.forEach(function (s) {
              ps[String(s[0])] = function () {
                C.echoPick(String(s[0]));
                C.setMode('busy');
                api.links.create(Object.assign({ name: name, to: to, session: Number(s[1]) }, /** @type {any} */ (d[1]))).then(function (/** @type {any} */ res) {
                  C.toCmd();
                  if (res.j && res.j.ok && res.j.link) {
                    const url = ORIGIN + (res.j.link.path || '');
                    C.ok('✓ ' + t('links.created'));
                    C.out('<span class="sgx-at-w" translate="no">' + esc(url) + '</span>');
                    copyText(url).then(function (ok) { if (ok) C.note(t('common.copied')); });
                    list = null;
                    C.render();
                    load();
                    return;
                  }
                  if (C.authErr(res)) return;
                  C.err(api.isErr(res, api.ERR.full) ? t('links.full') : api.errText(t, res.j && res.j.error, res.s));
                }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
              };
            });
            C.pick(ps, '0');
          };
        });
        C.pick(pd, '2');
      }, { ps: '>', hint: t('links.toHint') });
    }, { ps: '>', hint: t('links.nameHint') });
  }
  /** @param {string} id */
  function revoke(id) {
    const a = 'ln:' + id;
    if (C.armed !== a) { C.armed = a; C.render(); return; }
    C.armed = '';
    api.links.revoke(id).then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.ok('✓ ' + t('links.revoked')); list = null; C.render(); load(); return; }
      if (C.authErr(res)) return;
      C.err(api.errText(t, res.j && res.j.error, res.s));
      C.render();
    }, function () { C.err(t('common.errNetwork')); });
  }
  function revokeAll() {
    if (C.armed !== 'ln-all') { C.armed = 'ln-all'; C.render(); return; }
    C.armed = '';
    const ids = (list || []).filter(function (/** @type {any} */ l) { return l.status === 'active'; }).map(function (/** @type {any} */ l) { return l.id; });
    C.echo('share revoke --all');
    C.setMode('busy');
    /** 一条一条作废（L2 加 revoke-all 动作） @param {number} i @param {number} n */
    const next = function (i, n) {
      if (i >= ids.length) { C.toCmd(); C.ok('✓ ' + tf('links.revokedAll', { n: n })); list = null; C.render(); load(); return; }
      api.links.revoke(ids[i]).then(function (/** @type {any} */ res) {
        if (res.j && res.j.ok) { next(i + 1, n + 1); return; }
        C.toCmd();
        if (C.authErr(res)) return;
        C.err(api.errText(t, res.j && res.j.error, res.s));
        list = null;
        load();
      }, function () { C.toCmd(); C.err(t('common.errNetwork')); });
    };
    next(0, 0);
  }

  /** @param {string} a @returns {boolean} */
  C.actLinks = function (a) {
    if (C.layer !== 'links') return false;
    if (a === 'ln-new') { create(); return true; }
    if (a === 'ln-all') { revokeAll(); return true; }
    if (a.indexOf('ln-copy:') === 0) {
      const l = (list || []).find(function (/** @type {any} */ x) { return x.id === a.slice(8); });
      if (l && l.path) copyText(ORIGIN + l.path).then(function (ok) { if (ok) C.ok('✓ ' + t('common.copied')); else C.err(t('common.copyFail')); });
      return true;
    }
    if (a.indexOf('ln:') === 0) { revoke(a.slice(3)); return true; }
    return false;
  };
}
