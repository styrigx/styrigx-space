/**
 * @fileoverview 分享链接的终端命令（v5 S5，term-design-v5「分享」：原盾牌「分享链接」层搬进终端）。后端经 api.links.*（/api/share）。
 *
 * - share：还有效的链接（[n] 名字 · 页面 · 剩余 · 带不带会话；要 reauth）
 * - share add：名字（可空）→ 打开哪一页（回车 = 当前页）→ 链接有效期 → 会话档（不超过有效期）→ 链接 + 复制（只要进站会话，不要 reauth）
 * - share rm <n>：[y/N] 作废一条 · share rm --all：[y/N] 全部作废（都要 reauth）
 * 分享链接进来的会话（by=link）不能发、不能管：服务端 403 link，终端按身份先拦一句（term/cmds/keys/gate.js）。有效期档保留，不做延期（Gray 16:02–16:03）。
 */
import { cleanPasskeyName } from '../../auth/passkey-register.js';

/** 链接有效期：[键, 请求, 显示, 毫秒] */
export const LINK_DURATIONS = Object.freeze([
  ['1', { hours: 1 }, '1h', 36e5], ['2', { hours: 24 }, '24h', 864e5], ['3', { days: 3 }, '3d', 3 * 864e5],
  ['4', { days: 7 }, '7d', 7 * 864e5], ['5', { days: 30 }, '30d', 30 * 864e5],
]);
/** 会话档位（秒；0 = 普通链接，不带会话）：同 workers/space-core/src/core/share-links.js SESSION_OPTS */
export const LINK_SESSIONS = Object.freeze([['0', 0, 'none'], ['1', 1800, '30m'], ['2', 3600, '1h'], ['3', 12 * 3600, '12h'], ['4', 86400, '1d'], ['5', 7 * 86400, '7d']]);
const ORIGIN = 'https://styrigx.com';

/** 剩余时间的短写法：12d / 5h / 30m @param {number} ms */
export function shortLeft(ms) {
  if (!(ms > 0)) return '0m';
  if (ms >= 864e5) return Math.floor(ms / 864e5) + 'd';
  if (ms >= 36e5) return Math.floor(ms / 36e5) + 'h';
  return Math.max(1, Math.ceil(ms / 6e4)) + 'm';
}

/** 复制到剪贴板（失败回 false） @param {string} s @returns {Promise<boolean>} */
export function copyText(s) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return false; });
  } catch (e) {}
  return Promise.resolve(false);
}

/** 当前页（去掉锁屏 / 回跳 / 分享自己的参数） */
export function currentTarget() {
  try {
    const u = new URL(location.href);
    ['entry', 'lock', 'why', 'return', 'share'].forEach(function (k) { u.searchParams.delete(k); });
    return u.pathname + (u.search && u.search !== '?' ? u.search : '');
  } catch (e) { return '/'; }
}

/** @param {any} C 钥匙层上下文（shell/space/layer.js） */
export function mountLinks(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** 最近一次列出的有效链接（rm <n> 的编号对着它） @type {any[]} */
  let live = [];

  /** @param {any} res */
  function fail(res) {
    if (C.authErr(res)) return;
    C.err(api.isErr(res, api.ERR.full) ? t('links.full') : api.errText(t, res.j && res.j.error, res.s));
  }
  const netErr = function () { C.err(t('common.errNetwork')); C.toCmd(); };

  /** 取有效的链接（不打印） @param {(ok: boolean) => void} then */
  function load(then) {
    C.setMode('busy');
    api.links.list().then(function (/** @type {any} */ res) {
      C.toCmd();
      if (res.j && res.j.ok) {
        live = (res.j.links || []).filter(function (/** @type {any} */ l) { return l.status === 'active'; });
        then(true);
        return;
      }
      fail(res);
      then(false);
    }, function () { netErr(); then(false); });
  }

  /** share：列出 */
  C.shareList = function () {
    C.withReauth(function () {
      load(function (ok) {
        if (!ok) return;
        if (!live.length) { C.note(t('links.none')); return; }
        live.forEach(function (/** @type {any} */ l, /** @type {number} */ i) {
          const sub = [l.to, tf('links.left', { t: shortLeft(l.expiresAt - Date.now()) }), l.session ? t('links.withSession') : t('links.plain')].join(' · ');
          C.out('<span class="sgx-at-p">[' + (i + 1) + ']</span> <span translate="no" data-sgx-personal>' + esc(l.name || l.to) + '</span> <span class="sgx-at-dim">· ' + esc(sub) + '</span>' +
            (l.path ? ' <span class="sgx-at-w" translate="no">' + esc(ORIGIN + l.path) + '</span>' : ''));
        });
      });
    }, t('reauth.lead.links'));
  };

  /** share add：名字 → 页面 → 有效期 → 会话档 → 新建 */
  C.shareAdd = function () {
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
                    return;
                  }
                  fail(res);
                }, netErr);
              };
            });
            C.pick(ps, '0');
          };
        });
        C.pick(pd, '2');
      }, { ps: '>', hint: t('links.toHint') });
    }, { ps: '>', hint: t('links.nameHint') });
  };

  /** [y/N]（回车 = N） @param {string} ask @param {() => void} yes */
  function yn(ask, yes) {
    C.out(esc(ask) + ' [y/N]');
    C.pick({
      y: function () { C.echoPick('y'); yes(); },
      n: function () { C.echoPick('n'); C.toCmd(); },
    }, 'n', { ps: '[y/N]' });
  }

  /** share rm <n> @param {number} n */
  C.shareRm = function (n) {
    C.withReauth(function () {
      load(function (ok) {
        if (!ok) return;
        const l = live[n - 1];
        if (!l) { C.err(t('links.noSuch')); C.note(t('links.lsFirst'), 'share'); return; }
        yn(tf('links.rmAsk', { n: l.name || l.to }), function () {
          C.setMode('busy');
          api.links.revoke(l.id).then(function (/** @type {any} */ res) {
            if (res.j && res.j.ok) { C.ok('✓ ' + t('links.revoked')); live = []; C.toCmd(); return; }
            fail(res);
            C.toCmd();
          }, netErr);
        });
      });
    }, t('reauth.lead.links'));
  };

  /** share rm --all：一条一条作废 */
  C.shareRmAll = function () {
    C.withReauth(function () {
      load(function (ok) {
        if (!ok) return;
        if (!live.length) { C.note(t('links.none')); return; }
        const ids = live.map(function (/** @type {any} */ l) { return l.id; });
        yn(tf('links.rmAllAsk', { n: ids.length }), function () {
          C.setMode('busy');
          /** @param {number} i @param {number} k */
          const next = function (i, k) {
            if (i >= ids.length) { C.toCmd(); C.ok('✓ ' + tf('links.revokedAll', { n: k })); live = []; return; }
            api.links.revoke(ids[i]).then(function (/** @type {any} */ res) {
              if (res.j && res.j.ok) { next(i + 1, k + 1); return; }
              C.toCmd();
              fail(res);
            }, netErr);
          };
          next(0, 0);
        });
      });
    }, t('reauth.lead.links'));
  };
}
