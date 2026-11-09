/**
 * @fileoverview 盾牌 → 临时钥匙（给别人进站用，锁屏上 `sudo styrigx tempkey`）。新建 / 列表 / 作废都要 reauth（Q3 定稿 08:00、Q4：
 * 钥匙是明文码，层一打开就能新建，进层就验一次）。原 /security/tempkeys/ 整页删了。
 *
 * - 列表：名字 · 剩余；作废两步（拿它进站的人下一个请求就回锁屏）
 * - 新建：名字（可空）→ 有效期（1 / 12 / 24 小时，3 / 7 / 30 天）→ 明文码 XXXX-XXXX-XXXX 只显示这一次 + 复制；关下拉 / reauth 到期就收掉
 * 同时有效最多 20 把（409 full）。后端经 api.tempkeys.*。
 */
import { cleanPasskeyName } from '../../auth/passkey-register.js';

/** 有效期选项：[键, 请求, 显示] */
export const TEMPKEY_DURATIONS = Object.freeze([
  ['1', { hours: 1 }, '1h'], ['2', { hours: 12 }, '12h'], ['3', { hours: 24 }, '24h'],
  ['4', { days: 3 }, '3d'], ['5', { days: 7 }, '7d'], ['6', { days: 30 }, '30d'],
]);

/** 剩余时间的短写（≥ 1 天 Nd，≥ 1 小时 Nh，其余 Nm） @param {number} ms */
export function shortLeft(ms) {
  if (!(ms > 0)) return '0m';
  if (ms >= 864e5) return Math.floor(ms / 864e5) + 'd';
  if (ms >= 36e5) return Math.floor(ms / 36e5) + 'h';
  return Math.max(1, Math.ceil(ms / 6e4)) + 'm';
}

/**
 * 复制到剪贴板（失败回 false）
 * @param {string} s @returns {Promise<boolean>}
 */
export function copyText(s) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return false; });
  } catch (e) {}
  return Promise.resolve(false);
}

/** @param {any} C 盾牌上下文 */
export function mountTempkeys(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;
  const api = C.api;
  /** @type {any[]|null} */ let list = null;
  /** 刚发的明文码（只显示这一次） */ let fresh = '';

  /** 关下拉 / reauth 到期：明文码不留在页面上（链接层也挂在这里） */
  const prevDrop = C.dropSecrets;
  C.dropSecrets = function () {
    fresh = '';
    if (prevDrop) prevDrop();
  };

  C.renderTempkeys = function () {
    C.subHead(t('tempkeys.title'));
    if (!C.reauthLeft()) { C.viewEl.innerHTML = ''; C.foot('reauth.ft'); return; }
    let h = '<div class="sgx-pop-list">';
    if (fresh) {
      h += C.row({ k: fresh, kHtml: '<b class="sgx-sh-code" translate="no">' + esc(fresh) + '</b>', sub: t('tempkeys.once'), vHtml: '<button type="button" class="sgx-at-acc sgx-at-del" data-sh-act="tk-copy">' + esc(t('common.copy')) + '</button>' });
    }
    h += C.grp(t('tempkeys.listTitle'));
    if (list === null) h += C.noteP(t('common.loading'));
    else if (!list.length) h += C.noteP(t('tempkeys.none'));
    else list.forEach(function (/** @type {any} */ k) {
      const a = C.armed === 'tk:' + k.id;
      h += C.row({
        k: k.name || t('tempkeys.unnamed'),
        kHtml: '<span translate="no" data-sgx-personal>' + esc(k.name || t('tempkeys.unnamed')) + '</span>',
        sub: tf('tempkeys.left', { t: shortLeft(k.expiresAt - Date.now()) }),
        vHtml: '<button type="button" class="sgx-at-acc sgx-at-del" data-sh-act="tk:' + esc(k.id) + '">' + esc(a ? t('tempkeys.revokeAsk') : t('tempkeys.revoke')) + '</button>',
        armed: a,
      });
    });
    h += C.row({ k: t('tempkeys.add'), v: 'tempkey new', act: 'tk-new', cls: 'sgx-pop-row--acc' });
    h += '</div>';
    C.viewEl.innerHTML = h;
    C.foot('tempkeys.ft');
  };
  C.enterTempkeys = function () { list = null; C.render(); load(); C.startTick(); };
  function load() {
    return api.tempkeys.list().then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { list = res.j.keys || []; if (C.layer === 'tempkeys') C.render(); return; }
      if (!C.authErr(res)) C.err(api.errText(t, res.j && res.j.error, res.s));
    }, function () { C.err(t('common.errNetwork')); });
  }

  function create() {
    C.echo('tempkey new');
    C.out(esc(t('tempkeys.nameAsk')) + ':');
    C.ask('pkname', function (/** @type {string} */ v) {
      const name = cleanPasskeyName(v).slice(0, 24);
      C.out(esc(t('tempkeys.durAsk')));
      C.opts(TEMPKEY_DURATIONS.map(function (d) { return /** @type {[string, string, boolean?]} */ ([d[0], String(d[2]), d[0] === '3']); }));
      /** @type {Record<string, () => void>} */ const picks = {};
      TEMPKEY_DURATIONS.forEach(function (d) {
        picks[String(d[0])] = function () {
          C.echoPick(String(d[0]));
          C.setMode('busy');
          api.tempkeys.create(name, /** @type {any} */ (d[1])).then(function (/** @type {any} */ res) {
            C.toCmd();
            if (res.j && res.j.ok && res.j.code) {
              fresh = String(res.j.code);
              C.ok('✓ ' + t('tempkeys.created'), t('tempkeys.once'));
              C.out('<b class="sgx-sh-code" translate="no">' + esc(fresh) + '</b>');
              list = null;
              C.render();
              load();
              return;
            }
            if (C.authErr(res)) return;
            C.err(api.isErr(res, api.ERR.full) ? t('tempkeys.full') : api.errText(t, res.j && res.j.error, res.s));
          }, function () { C.err(t('common.errNetwork')); C.toCmd(); });
        };
      });
      C.pick(picks, '3');
    }, { ps: '>', hint: t('tempkeys.nameHint') });
  }
  /** @param {string} id */
  function revoke(id) {
    const a = 'tk:' + id;
    if (C.armed !== a) { C.armed = a; C.render(); return; }
    C.armed = '';
    api.tempkeys.revoke(id).then(function (/** @type {any} */ res) {
      if (res.j && res.j.ok) { C.ok('✓ ' + t('tempkeys.revoked')); if (list) list = list.filter(function (/** @type {any} */ k) { return k.id !== id; }); C.render(); return; }
      if (C.authErr(res)) return;
      C.err(api.errText(t, res.j && res.j.error, res.s));
      C.render();
    }, function () { C.err(t('common.errNetwork')); });
  }

  /** @param {string} a @returns {boolean} */
  C.actTempkeys = function (a) {
    if (C.layer !== 'tempkeys') return false;
    if (a === 'tk-new') { create(); return true; }
    if (a === 'tk-copy') {
      copyText(fresh).then(function (ok) { if (ok) C.ok('✓ ' + t('common.copied')); else C.err(t('common.copyFail')); });
      return true;
    }
    if (a.indexOf('tk:') === 0) { revoke(a.slice(3)); return true; }
    return false;
  };
}
