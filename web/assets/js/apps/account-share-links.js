/**
 * @fileoverview 账号 → 临时钥匙页里的「分享短链」（https://styrigx.com/s/<码>，2026-10-24）。
 *
 * 接口：POST /api/share（分享短链 Worker styrigx-share，workers/share）{ action:'list' | 'create' | 'revoke' }。
 * - 进页 list → 列表：名字 + 类型（带会话 / 普通）+ 状态（有效 / 已过期 / 已作废）、打开的页面、到期时间和剩余、
 *   带会话的：点开后能看多久、最近一次发出的访客会话还剩多久；有效的才有「复制」「作废」（两步确认）
 * - 「新建分享短链」→ 弹层：名字（可空）+ 链接有效期（1–24 小时 / 3 / 7 / 15 / 30 天）+ 打开的页面（站内路径或 styrigx.com / 子站链接，默认首页）
 *   +「带临时会话」开关（默认开）+ 点开后能看多久（30 分钟–7 天，比链接有效期长的档位禁用）
 *   → create → 弹层原地换成链接 + 复制；关掉开关 = 普通短链（session 0），服务端不签钥匙、不发会话
 * - 码不在页面地址里出现；复制的是 location.origin + /s/<码>
 * 账号会话 / lock 会话失效的处理与临时钥匙列表一致（apps/account-tempkeys.js）。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { onDialogBackdrop, onDialogCancel, recordDialogClose } from '../lib/dialog-behavior.js';
import { postJSON, errText } from '../lib/account-api.js';
import { accountUrl, createT } from './account-common.js';
import { leftText, durationParam } from './account-tempkeys.js';

/** 分享短链管理接口（styrigx-share） */
export const SHARE_API = '/api/share';

/** 访客会话时长档位（秒），与服务端 SHARE_SESSION_OPTS 一致 */
export const SESSION_OPTS = [1800, 3600, 10800, 43200, 86400, 259200, 604800];

/**
 * 有效期参数 → 毫秒。
 * @param {{hours?:number, days?:number}|null} d
 */
export function durMs(d) {
  if (!d) return 0;
  return d.hours ? d.hours * 3600e3 : (d.days || 0) * 86400e3;
}

/** 目标能指向的站（同服务端 workers/share/src/lib/links.js TARGET_HOSTS） */
export const TARGET_HOSTS = ['styrigx.com', 'blog.styrigx.com', 'daymark.styrigx.com', 'curio.styrigx.com'];

/**
 * 目标输入 → 提交值：空 = '/'；站内路径（/ 开头，不能 // 或 /\）或 https://（styrigx.com / 三个子站）地址，
 * 不带端口 / 用户名；不含空白和反斜杠。服务端再严格校验并规范化一次。不合法返回 null。
 * @param {string} v
 */
export function targetParam(v) {
  const s = String(v || '').trim();
  if (!s) return '/';
  if (s.length > 512 || /[\s\\]/.test(s)) return null;
  if (s.charAt(0) === '/') return s.charAt(1) === '/' ? null : s;
  const m = /^https:\/\/([a-z0-9.-]+)(?=[/?#]|$)/i.exec(s);
  if (!m || TARGET_HOSTS.indexOf(m[1].toLowerCase()) < 0) return null;
  return s;
}

/**
 * 会话时长文案（秒 → 「3 小时」/「3 hours」）。
 * @param {boolean} en
 * @param {number} sec
 */
export function sessLabel(en, sec) {
  if (sec < 3600) return en ? Math.round(sec / 60) + ' minutes' : Math.round(sec / 60) + ' 分钟';
  if (sec < 86400) {
    const h = Math.round(sec / 3600);
    return en ? h + (h === 1 ? ' hour' : ' hours') : h + ' 小时';
  }
  const d = Math.round(sec / 86400);
  return en ? d + (d === 1 ? ' day' : ' days') : d + ' 天';
}

/**
 * 到期 / 作废时间：本地时间「10月25日 16:00」/「Oct 25, 16:00」。
 * @param {boolean} en
 * @param {number} ms
 */
export function whenText(en, ms) {
  const d = new Date(ms);
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (en) return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getDate() + ', ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

/**
 * 列表里一条的说明行（纯文案，单测直接测）。
 * @param {(k:string)=>string} t
 * @param {boolean} en
 * @param {{to:string, session:number, expiresAt:number, revokedAt:number, status:string, opens:number, lastOpenAt:number, openFor:number, sessionLeft:number}} l
 * @param {number} [now]
 * @returns {string[]} 第一行 = 打开的页面；第二行 = 到期；第三行 = 会话（普通短链没有）
 */
export function metaLines(t, en, l, now) {
  const n = now || Date.now();
  const out = [t('slTo').replace('{v}', l.to && l.to !== '/' ? l.to : t('slHome') + ' /')];
  if (l.status === 'revoked') out.push(t('slRevokedAt').replace('{t}', whenText(en, l.revokedAt || n)));
  else if (l.status === 'expired' || l.expiresAt <= n) out.push(t('slExpiredAt').replace('{t}', whenText(en, l.expiresAt)));
  else out.push(t('slExpAt').replace('{t}', whenText(en, l.expiresAt)) + ' · ' + leftText(t, l.expiresAt, n));
  if (l.session) {
    const alive = l.status === 'active' && l.expiresAt > n;
    if (!alive) out.push(t('slSessFor').replace('{v}', sessLabel(en, l.session)));
    else {
      const left = l.lastOpenAt ? Math.max(0, Math.min(l.lastOpenAt + l.session * 1000, l.expiresAt) - n) : 0;
      const openFor = Math.max(0, Math.min(l.session * 1000, l.expiresAt - n));
      out.push(t('slOpenFor').replace('{v}', sessLabel(en, Math.max(60, Math.round(openFor / 1000)))) + ' · ' +
        (!l.lastOpenAt ? t('slNotOpened') : left > 0 ? t('slLastLeft').replace('{v}', leftText(t, n + left, n)) : t('slLastEnded')));
    }
  }
  return out;
}

(function () {
  const root = document.getElementById('acct-tk');
  const list = document.getElementById('acct-sl-list');
  if (!root || !list) return;
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  const $ = function (/** @type {string} */ id) { return document.getElementById(id); };
  const empty = $('acct-sl-empty');
  const dlg = /** @type {any} */ ($('sl-dlg'));
  const form = $('sl-form');
  const done = $('sl-done');
  const nameIn = /** @type {HTMLInputElement|null} */ ($('sl-name'));
  const durIn = /** @type {HTMLSelectElement|null} */ ($('sl-dur'));
  const toIn = /** @type {HTMLInputElement|null} */ ($('sl-to'));
  const swRow = $('sl-sess-row');
  const sw = $('sl-sess-sw');
  const swSub = $('sl-sess-sub');
  const sessBox = $('sl-sess-box');
  const sessIn = /** @type {HTMLSelectElement|null} */ ($('sl-sess'));
  const err = $('sl-err');
  const go = /** @type {HTMLButtonElement|null} */ ($('sl-go'));
  const urlEl = $('sl-url');
  const doneSub = $('sl-done-sub');
  const doneWarn = $('sl-done-warn');
  const copyBtn = $('sl-copy');
  /** @type {Array<{id:string, name:string, createdAt:number, expiresAt:number, to:string, session:number, path:string}>} */
  let links = [];

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

  /** @param {string} path */
  function fullUrl(path) {
    return location.origin + path;
  }

  /** @param {string} text */
  function copyText(text) {
    const fail = function () { toast(t('tkCopyFail')); };
    try {
      navigator.clipboard.writeText(text).then(function () { toast(t('tkCopied')); }, fail);
    } catch (e) {
      fail();
    }
  }

  /** @param {any} l */
  function item(l) {
    const live = l.status === 'active' && l.expiresAt > Date.now();
    const li = document.createElement('div');
    li.className = 'acct-row acct-dev-item sl-item' + (live ? '' : ' is-dead');
    li.setAttribute('data-sl', l.id);
    const ic = document.createElement('span');
    ic.className = 'acct-ic bg-m-tertiary-container text-m-on-tertiary-container';
    ic.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>';
    const wrap = document.createElement('span');
    wrap.className = 'flex-1 min-w-0';
    const nm = document.createElement('span');
    nm.className = 'sl-name font-medium';
    const nmT = document.createElement('span');
    nmT.className = 'sl-name-t';
    nmT.textContent = l.name || t('tkUnnamed');
    const badge = document.createElement('span');
    badge.className = 'sl-badge' + (l.session ? ' is-sess' : '');
    badge.textContent = l.session ? t('slSess') : t('slPlain');
    nm.appendChild(nmT);
    nm.appendChild(badge);
    if (!live) {
      const st = document.createElement('span');
      st.className = 'sl-badge is-dead';
      st.textContent = l.status === 'revoked' ? t('slStRevoked') : t('slStExpired');
      nm.appendChild(st);
    }
    wrap.appendChild(nm);
    metaLines(t, en, l).forEach(function (line, i) {
      const meta = document.createElement('span');
      /* 第一行（打开的页面）太长就截断；到期、会话两行在窄屏上换行，不截断 */
      meta.className = 'block text-xs text-m-on-surface-variant mt-0.5 sl-meta' + (i === 0 ? ' truncate' : '');
      meta.setAttribute('data-i', String(i));
      meta.textContent = line;
      wrap.appendChild(meta);
    });
    li.appendChild(ic);
    li.appendChild(wrap);
    if (!live) return li;

    const cp = document.createElement('button');
    cp.type = 'button';
    cp.className = 'sl-copy';
    cp.textContent = t('slCopy');
    cp.setAttribute('aria-label', t('slCopy') + ' ' + (l.name || t('tkUnnamed')));
    on(cp, 'click', function () { copyText(fullUrl(l.path)); });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lockmgr-pkdel';
    btn.textContent = t('tkRevoke');
    btn.setAttribute('aria-label', t('tkRevoke') + ' ' + (l.name || t('tkUnnamed')));
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
      postJSON(SHARE_API, { action: 'revoke', id: l.id }).then(function (res) {
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
    li.appendChild(cp);
    li.appendChild(btn);
    return li;
  }

  function render() {
    list.textContent = '';
    links.forEach(function (l) { list.appendChild(item(l)); });
    list.hidden = links.length === 0;
    if (empty) empty.hidden = links.length !== 0;
  }

  /* 每分钟刷新剩余时间；有效的刚过期 → 重画（变成「已过期」、去掉按钮） */
  window.setInterval(function () {
    let gone = false;
    const now = Date.now();
    links.forEach(function (l) {
      const row = list.querySelector('[data-sl="' + l.id + '"]');
      if (!row) return;
      if (l.status === 'active' && l.expiresAt <= now) { l.status = 'expired'; gone = true; return; }
      const lines = metaLines(t, en, l, now);
      row.querySelectorAll('.sl-meta').forEach(function (el, i) { if (lines[i] !== undefined) el.textContent = lines[i]; });
    });
    if (gone) render();
  }, 60000);

  function load() {
    postJSON(SHARE_API, { action: 'list' }).then(function (res) {
      if (authFail(res)) return;
      if (!(res.j && res.j.ok)) {
        toast(errText(t, res.j && res.j.error, res.s));
        return;
      }
      links = Array.isArray(res.j.links) ? res.j.links : [];
      render();
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

  function sessOn() {
    return !!sw && sw.getAttribute('aria-checked') === 'true';
  }

  /** 会话时长：比链接有效期长的档位禁用；当前选中的超了就换成能选的最长一档 */
  function clampSess() {
    if (!sessIn) return;
    const ms = durMs(durationParam(durIn ? durIn.value : ''));
    let best = '';
    Array.prototype.forEach.call(sessIn.options, function (/** @type {HTMLOptionElement} */ o) {
      const ok = parseInt(o.value, 10) * 1000 <= ms;
      o.disabled = !ok;
      if (ok) best = o.value;
    });
    const cur = sessIn.selectedOptions && sessIn.selectedOptions[0];
    if ((!cur || cur.disabled) && best) sessIn.value = best;
  }

  /** @param {boolean} v */
  function paintSwitch(v) {
    if (sw) sw.setAttribute('aria-checked', v ? 'true' : 'false');
    if (swSub) swSub.textContent = v ? t('slSessOn') : t('slSessOff');
    if (sessBox) sessBox.hidden = !v;
  }

  function openDlg() {
    if (!dlg) return;
    if (form) form.hidden = false;
    if (done) done.hidden = true;
    if (err) err.hidden = true;
    if (nameIn) nameIn.value = '';
    if (toIn) toIn.value = '';
    if (durIn) durIn.value = 'h24';
    if (sessIn) sessIn.value = '43200';
    paintSwitch(true);
    clampSess();
    if (go) go.disabled = false;
    const title = $('sl-title');
    if (title) title.textContent = t('slNew');
    try { dlg.showModal(); } catch (e) {}
  }

  /** @param {string} [reason] */
  function closeDlg(reason) {
    recordDialogClose('share-link', reason || 'unknown');
    try { if (dlg && dlg.open) dlg.close(); } catch (e) {}
  }

  function create() {
    if (!go || go.disabled) return;
    if (err) err.hidden = true;
    const name = nameIn ? nameIn.value.trim() : '';
    if ([...name].length > 24) {
      showErr(t('tkNameLong'));
      return;
    }
    const dur = durationParam(durIn ? durIn.value : '');
    if (!dur) return;
    const to = targetParam(toIn ? toIn.value : '');
    if (to === null) {
      showErr(t('slTarget'));
      return;
    }
    const withSess = sessOn();
    const session = withSess && sessIn ? parseInt(sessIn.value, 10) : 0;
    if (withSess && (SESSION_OPTS.indexOf(session) < 0 || session * 1000 > durMs(dur))) {
      showErr(t('slSessLong'));
      return;
    }
    go.disabled = true;
    postJSON(SHARE_API, Object.assign({ action: 'create', name: name, to: to, session: session }, dur)).then(function (res) {
      go.disabled = false;
      if (authFail(res)) { closeDlg('auth'); return; }
      if (!(res.j && res.j.ok)) {
        const e = res.j && res.j.error;
        showErr(e === 'full' ? t('slFull') : e === 'name' ? t('tkNameLong') : e === 'target' ? t('slTarget') : e === 'session' ? t('slSessLong') : errText(t, e, res.s));
        return;
      }
      const link = res.j.link;
      const vLabel = durIn && durIn.selectedOptions && durIn.selectedOptions[0] ? (durIn.selectedOptions[0].textContent || '').trim() : '';
      if (urlEl) urlEl.textContent = fullUrl(link.path);
      if (doneSub) {
        doneSub.textContent = (name ? name + ' · ' : '') + (link.session
          ? t('slDoneSess').replace('{s}', sessLabel(en, link.session)).replace('{v}', vLabel)
          : t('slDonePlain').replace('{v}', vLabel));
      }
      if (doneWarn) doneWarn.textContent = link.session ? t('slWarnSess') : t('slWarnPlain');
      const title = $('sl-title');
      if (title) title.textContent = t('slTitle');
      if (form) form.hidden = true;
      if (done) done.hidden = false;
      load();
    }, function () {
      go.disabled = false;
      showErr(t('errNetwork'));
    });
  }

  const newRow = $('acct-sl-new');
  if (newRow) {
    on(newRow, 'click', openDlg);
    on(newRow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDlg();
      }
    });
  }
  if (swRow) {
    on(swRow, 'click', function () { paintSwitch(!sessOn()); });
    on(swRow, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        paintSwitch(!sessOn());
      }
    });
  }
  if (durIn) on(durIn, 'change', clampSess);
  if (go) on(go, 'click', create);
  [nameIn, toIn].forEach(function (inp) {
    if (inp) on(inp, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter') { e.preventDefault(); create(); }
    });
  });
  if (copyBtn) on(copyBtn, 'click', function () {
    const u = urlEl ? urlEl.textContent || '' : '';
    if (u) copyText(u);
  });
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
