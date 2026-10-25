/**
 * @fileoverview 账号 → 临时钥匙（/account/tempkeys/）：给访客的临时 LockKey。
 *
 * - 进页 POST /api/lock-tempkey { action:'list' }：没有账号会话（401 account）→ 回账号页登录，登录后回本页；
 *   lock 会话失效（401 session）→ 提示回锁屏
 * - 「新建临时钥匙」→ 弹层：名字（可空，最多 24 字，只有站长看得到）+ 有效期（1–24 小时 / 3 / 7 / 15 / 30 天）
 *   → create → 弹层原地换成临时码（只显示这一次）+ 复制
 * - 列表：名字 + 剩余时间（每分钟刷新一次）；「作废」两步确认 → revoke
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose } from '../lib/dialog-behavior.js';
import { postJSON, errText } from '../lib/account-api.js';
import { accountUrl, createT } from './account-common.js';

export const TEMPKEY_API = '/api/lock-tempkey';

/**
 * 剩余时间文案。
 * @param {function(string): string} t
 * @param {number} expiresAt 毫秒
 * @param {number} [now]
 */
export function leftText(t, expiresAt, now) {
  const ms = Math.max(0, expiresAt - (now || Date.now()));
  const min = Math.max(1, Math.ceil(ms / 60000));
  if (min < 60) return t('tkLeftMin').replace('{m}', String(min));
  const h = Math.floor(min / 60);
  if (h < 24) return t('tkLeftHour').replace('{h}', String(h)).replace('{m}', String(min % 60));
  return t('tkLeftDay').replace('{d}', String(Math.floor(h / 24))).replace('{h}', String(h % 24));
}

/**
 * 有效期下拉值 → 请求参数：'h6' → { hours: 6 }，'d7' → { days: 7 }；不合法返回 null。
 * @param {string} v
 */
export function durationParam(v) {
  const m = /^([hd])(\d{1,2})$/.exec(String(v || ''));
  if (!m) return null;
  const n = parseInt(m[2], 10);
  if (m[1] === 'h') return n >= 1 && n <= 24 ? { hours: n } : null;
  return [3, 7, 15, 30].indexOf(n) >= 0 ? { days: n } : null;
}

(function () {
  const root = document.getElementById('acct-tk');
  if (!root) return;
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  const $ = function (/** @type {string} */ id) { return document.getElementById(id); };
  const list = $('acct-tk-list');
  const empty = $('acct-tk-empty');
  const dlg = /** @type {any} */ ($('tk-dlg'));
  const form = $('tk-form');
  const done = $('tk-done');
  const nameIn = /** @type {HTMLInputElement|null} */ ($('tk-name'));
  const durIn = /** @type {HTMLSelectElement|null} */ ($('tk-dur'));
  const err = $('tk-err');
  const go = /** @type {HTMLButtonElement|null} */ ($('tk-go'));
  const codeEl = $('tk-code');
  const doneSub = $('tk-done-sub');
  const copyBtn = $('tk-copy');
  /** @type {Array<{id:string, name:string, createdAt:number, expiresAt:number}>} */
  let keys = [];

  function goLogin() {
    sgxReplace(accountUrl(en) + '?return=' + encodeURIComponent(location.pathname));
  }

  /** @param {{s:number, j:any}} res @returns {boolean} 已处理 */
  function authFail(res) {
    if (res.s !== 401) return false;
    if (res.j && res.j.error === 'session') toast(t('sessExp'));
    else goLogin();
    return true;
  }

  /** @param {{id:string, name:string, expiresAt:number}} k */
  function item(k) {
    const li = document.createElement('div');
    li.className = 'acct-row acct-dev-item';
    li.setAttribute('data-tk', k.id);
    const ic = document.createElement('span');
    ic.className = 'acct-ic bg-m-secondary-container text-m-on-secondary-container';
    ic.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path stroke-linecap="round" stroke-linejoin="round" d="M10.8 12.2 20 3m-4 4 3 3m-1-5 2 2"/></svg>';
    const wrap = document.createElement('span');
    wrap.className = 'flex-1 min-w-0';
    const nm = document.createElement('span');
    nm.className = 'block font-medium truncate';
    nm.textContent = k.name || t('tkUnnamed');
    const meta = document.createElement('span');
    meta.className = 'block text-xs text-m-on-surface-variant mt-0.5 truncate tk-left';
    meta.textContent = leftText(t, k.expiresAt);
    wrap.appendChild(nm);
    wrap.appendChild(meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lockmgr-pkdel';
    btn.textContent = t('tkRevoke');
    btn.setAttribute('aria-label', t('tkRevoke') + ' ' + (k.name || t('tkUnnamed')));
    let armed = false;
    let timer = 0;
    const disarm = function () {
      armed = false;
      btn.textContent = t('tkRevoke');
      btn.classList.remove('armed');
    };
    on(btn, 'click', function () {
      if (!armed) {
        armed = true;
        btn.textContent = t('tkRevokeAsk');
        btn.classList.add('armed');
        timer = window.setTimeout(disarm, 3000);
        return;
      }
      window.clearTimeout(timer);
      btn.disabled = true;
      postJSON(TEMPKEY_API, { action: 'revoke', id: k.id }).then(function (res) {
        if (authFail(res)) return;
        if ((res.j && res.j.ok) || (res.j && res.j.error === 'not-found')) {
          toast(t('tkRevoked'));
          load();
          return;
        }
        btn.disabled = false;
        disarm();
        toast(errText(t, res.j && res.j.error, res.s));
      }, function () {
        btn.disabled = false;
        disarm();
        toast(t('errNetwork'));
      });
    });
    li.appendChild(ic);
    li.appendChild(wrap);
    li.appendChild(btn);
    return li;
  }

  function render() {
    const now = Date.now();
    keys = keys.filter(function (k) { return k.expiresAt > now; });
    if (list) {
      list.textContent = '';
      keys.forEach(function (k) { list.appendChild(item(k)); });
      list.hidden = keys.length === 0;
    }
    if (empty) empty.hidden = keys.length !== 0;
  }

  /* 剩余时间每分钟刷新（只改文字，不重画，作废按钮的两步状态不丢） */
  window.setInterval(function () {
    if (!list) return;
    let gone = false;
    keys.forEach(function (k) {
      const row = list.querySelector('[data-tk="' + k.id + '"] .tk-left');
      if (k.expiresAt <= Date.now()) gone = true;
      else if (row) row.textContent = leftText(t, k.expiresAt);
    });
    if (gone) render();
  }, 60000);

  function load() {
    postJSON(TEMPKEY_API, { action: 'list' }).then(function (res) {
      if (authFail(res)) return;
      if (!(res.j && res.j.ok)) {
        toast(errText(t, res.j && res.j.error, res.s));
        return;
      }
      keys = Array.isArray(res.j.keys) ? res.j.keys : [];
      render();
      root.hidden = false;
    }, function () {
      toast(t('errNetwork'));
    });
  }

  /* ---------- 新建弹层 ---------- */
  function showErr(/** @type {string} */ msg) {
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
  }

  function openDlg() {
    if (!dlg) return;
    if (form) form.hidden = false;
    if (done) done.hidden = true;
    if (err) err.hidden = true;
    if (nameIn) nameIn.value = '';
    if (durIn) durIn.value = 'h24';
    if (go) go.disabled = false;
    const title = $('tk-title');
    if (title) title.textContent = en ? 'New temporary key' : '新建临时钥匙';
    try { dlg.showModal(); } catch (e) {}
  }

  /** @param {string} [reason] */
  function closeDlg(reason) {
    recordDialogClose('temp-key', reason || 'unknown');
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
  }

  function create() {
    if (!go || go.disabled) return;
    const name = nameIn ? nameIn.value.trim() : '';
    if ([...name].length > 24) {
      showErr(t('tkNameLong'));
      return;
    }
    const dur = durationParam(durIn ? durIn.value : '');
    if (!dur) return;
    go.disabled = true;
    postJSON(TEMPKEY_API, Object.assign({ action: 'create', name: name }, dur)).then(function (res) {
      go.disabled = false;
      if (authFail(res)) { closeDlg('auth'); return; }
      if (!(res.j && res.j.ok)) {
        const e = res.j && res.j.error;
        showErr(e === 'full' ? t('tkFull') : e === 'name' ? t('tkNameLong') : errText(t, e, res.s));
        return;
      }
      const label = durIn && durIn.selectedOptions && durIn.selectedOptions[0] ? durIn.selectedOptions[0].textContent || '' : '';
      if (codeEl) codeEl.textContent = res.j.code;
      if (doneSub) doneSub.textContent = (name ? name + ' · ' : '') + t('tkValidFor').replace('{v}', label.trim());
      const title = $('tk-title');
      if (title) title.textContent = en ? 'Temporary key' : '临时钥匙';
      if (form) form.hidden = true;
      if (done) done.hidden = false;
      load();
    }, function () {
      go.disabled = false;
      showErr(t('errNetwork'));
    });
  }

  function copy() {
    const code = codeEl ? codeEl.textContent || '' : '';
    if (!code) return;
    const fail = function () { toast(t('tkCopyFail')); };
    try {
      navigator.clipboard.writeText(code).then(function () { toast(t('tkCopied')); }, fail);
    } catch (e) {
      fail();
    }
  }

  const newRow = $('acct-tk-new');
  if (newRow) {
    on(newRow, 'click', openDlg);
    on(newRow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDlg();
      }
    });
  }
  if (go) on(go, 'click', create);
  if (nameIn) on(nameIn, 'keydown', function (/** @type {KeyboardEvent} */ e) {
    if (e.key === 'Enter') { e.preventDefault(); create(); }
  });
  if (copyBtn) on(copyBtn, 'click', copy);
  if (dlg) {
    on(dlg, 'click', function (/** @type {MouseEvent} */ e) { onDialogBackdrop(e, dlg); });
    on(dlg, 'cancel', function (/** @type {Event} */ e) {
      onDialogCancel(e, dlg, function (reason) { closeDlg(reason); });
    });
    const x = dlg.querySelector('[data-dlg-close]');
    if (x) on(x, 'click', function () { closeDlg('close-btn'); });
  }

  load();
})();
