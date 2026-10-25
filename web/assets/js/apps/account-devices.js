/**
 * @fileoverview 账号 → 设备（/account/devices/）：此设备 + 其他登录的设备，可单独退出。
 *
 * - 进页 POST /api/account { action:'device-list' }：没有账号会话（401）→ 回账号页登录，登录后回本页
 * - 此设备一张卡在最上面（服务端标 current 并排第一）：设备行 +「登录方式」（这台设备记录的 by；旧记录没有就看 GET /api/account 的 session.by）
 *   + 「退出账号」（POST logout，清账号会话和门票 → 回账号页登录区）。2026-10-24 PR4 从删掉的「账号信息」子页挪来。
 * - 其他设备：名字（型号 / 平台）+ 浏览器 · 地点 · 上次活动；「退出」两步确认 → device-revoke
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { sgxReplace } from '../lib/diag-jumptrace.js';
import { accountUrl, createT, goAccountLogin } from './account-common.js';
import { ACCOUNT_API, postJSON, errText } from '../lib/account-api.js';
import { clearPullStamp } from '../lib/cloud-sync.js';

const ICONS = {
  phone: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path stroke-linecap="round" d="M10.5 18.5h3"/></svg>',
  tablet: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3" width="17" height="18" rx="2.5"/><path stroke-linecap="round" d="M10.5 18h3"/></svg>',
  laptop: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="10.5" rx="1.5"/><path stroke-linecap="round" d="M2.5 19h19"/></svg>',
};

/**
 * 设备图标：平板（Tab / iPad）、手机（Android / iOS）、其他按电脑。
 * @param {{name?:string, model?:string, platform?:string}} d
 */
export function deviceKind(d) {
  const n = ((d.name || '') + ' ' + (d.model || '')).toLowerCase();
  if (/\btab\b|ipad|sm-x\d/.test(n)) return 'tablet';
  if (d.platform === 'Android' || d.platform === 'iOS') return 'phone';
  return 'laptop';
}

/**
 * 「上次活动」的相对时间。
 * @param {function(string): string} t
 * @param {number} ts 毫秒
 * @param {number} [now]
 */
export function agoText(t, ts, now) {
  const diff = Math.max(0, (now || Date.now()) - (ts || 0));
  const min = Math.floor(diff / 60000);
  if (min < 2) return t('devJustNow');
  if (min < 60) return t('devMinAgo').replace('{n}', String(min));
  const h = Math.floor(min / 60);
  if (h < 24) return t('devHourAgo').replace('{n}', String(h));
  return t('devDayAgo').replace('{n}', String(Math.floor(h / 24)));
}

/**
 * 副标题：上次活动 · 浏览器 · 国家（此设备是「当前在线」）。时间放最前，窄屏截断时也看得到。
 * @param {function(string): string} t
 * @param {any} d
 * @param {boolean} en
 */
export function deviceSub(t, d, en) {
  const parts = [d.current ? t('devActiveNow') : agoText(t, d.lastSeen)];
  if (d.browser) parts.push(d.browser);
  else if (d.platform && d.name !== d.platform) parts.push(d.platform);
  /* 地点只显示国家（城市名 Cloudflare 只给英文，和中文混排太长） */
  let place = '';
  if (d.country) {
    place = d.country;
    try {
      const dn = new Intl.DisplayNames([en ? 'en' : 'zh-CN'], { type: 'region' });
      place = dn.of(d.country) || d.country;
    } catch (e) {}
  }
  if (place) parts.push(place);
  return parts.join(' · ');
}

(function () {
  const root = document.getElementById('acct-devices');
  if (!root) return;
  const en = document.documentElement.lang === 'en';
  const t = createT(en);
  const thisRow = document.getElementById('acct-dev-this');
  const list = document.getElementById('acct-dev-list');
  const empty = document.getElementById('acct-dev-empty');

  const byEl = document.getElementById('acct-by');
  const logout = document.getElementById('acct-logout');

  function goLogin() {
    goAccountLogin(en);
  }

  /** 登录方式的文字 @param {string} by */
  function byText(by) {
    return by === 'root' ? t('byRoot') : by === 'passkey' ? t('byPasskey') : t('byPassword');
  }
  /** @param {string} by 空 = 设备记录里没有（旧记录）→ 读一次 GET /api/account */
  function fillBy(by) {
    if (!byEl) return;
    if (by) { byEl.textContent = byText(by); return; }
    fetch(ACCOUNT_API, { method: 'GET', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok && j.session) byEl.textContent = byText(j.session.by || ''); })
      .catch(function () {});
  }

  if (logout) {
    on(logout, 'click', function () {
      postJSON(ACCOUNT_API, { action: 'logout' }).then(function () {
        /* 云同步节流时刻跟着账号走：退出就清掉，重新登录后第一次一定拉 */
        clearPullStamp();
        toast(t('loggedOut'));
        sgxReplace(accountUrl(en));
      }, function () {
        toast(t('errNetwork'));
      });
    });
  }

  /** @param {any} d */
  function fillThis(d) {
    if (!thisRow) return;
    thisRow.textContent = '';
    const ic = document.createElement('span');
    ic.className = 'acct-ic bg-m-primary-container text-m-on-primary-container';
    ic.innerHTML = ICONS[deviceKind(d || {})];
    const tx = document.createElement('span');
    tx.className = 'flex-1 min-w-0';
    const nm = document.createElement('span');
    nm.className = 'block font-medium truncate';
    nm.textContent = (d && d.name) || t('devThis');
    const sub = document.createElement('span');
    sub.className = 'block text-xs text-m-on-surface-variant mt-0.5 truncate';
    sub.textContent = d ? deviceSub(t, d, en) : t('devActiveNow');
    tx.appendChild(nm);
    tx.appendChild(sub);
    thisRow.appendChild(ic);
    thisRow.appendChild(tx);
  }

  /** @param {any} d */
  function otherItem(d) {
    const li = document.createElement('div');
    li.className = 'acct-row acct-dev-item';
    const ic = document.createElement('span');
    ic.className = 'acct-ic bg-m-accent-container text-m-on-accent-container';
    ic.innerHTML = ICONS[deviceKind(d)];
    const wrap = document.createElement('span');
    wrap.className = 'flex-1 min-w-0';
    const nm = document.createElement('span');
    nm.className = 'block font-medium truncate';
    nm.textContent = d.name || t('devUnknown');
    const meta = document.createElement('span');
    meta.className = 'block text-xs text-m-on-surface-variant mt-0.5 truncate';
    meta.textContent = deviceSub(t, d, en);
    wrap.appendChild(nm);
    wrap.appendChild(meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lockmgr-pkdel';
    btn.textContent = t('devSignOut');
    btn.setAttribute('aria-label', t('devSignOut') + ' ' + (d.name || t('devUnknown')));
    let armed = false;
    let timer = 0;
    on(btn, 'click', function () {
      if (!armed) {
        armed = true;
        btn.textContent = t('devSignOutAsk');
        btn.classList.add('armed');
        timer = window.setTimeout(function () {
          armed = false;
          btn.textContent = t('devSignOut');
          btn.classList.remove('armed');
        }, 3000);
        return;
      }
      window.clearTimeout(timer);
      armed = false;
      btn.disabled = true;
      postJSON(ACCOUNT_API, { action: 'device-revoke', deviceId: d.deviceId }).then(function (res) {
        if (res.s === 401) { goLogin(); return; }
        /* not-found：那台设备已经不在了（别处退出过），照样刷新 */
        if ((res.j && res.j.ok) || (res.j && res.j.error === 'not-found')) {
          toast(t('devSignedOut'));
          load();
          return;
        }
        btn.disabled = false;
        btn.textContent = t('devSignOut');
        btn.classList.remove('armed');
        toast(errText(t, res.j && res.j.error, res.s));
      }, function () {
        btn.disabled = false;
        btn.textContent = t('devSignOut');
        btn.classList.remove('armed');
        toast(t('errNetwork'));
      });
    });
    li.appendChild(ic);
    li.appendChild(wrap);
    li.appendChild(btn);
    return li;
  }

  function load() {
    postJSON(ACCOUNT_API, { action: 'device-list' }).then(function (res) {
      if (res.s === 401 || !(res.j && res.j.ok)) {
        if (res.s === 401) { goLogin(); return; }
        toast(errText(t, res.j && res.j.error, res.s));
        return;
      }
      const all = Array.isArray(res.j.devices) ? res.j.devices : [];
      const cur = all.filter(function (d) { return d.current; })[0] || null;
      const others = all.filter(function (d) { return !d.current; });
      fillThis(cur);
      fillBy((cur && cur.by) || '');
      if (list) {
        list.textContent = '';
        others.forEach(function (d) { list.appendChild(otherItem(d)); });
        list.hidden = others.length === 0;
      }
      if (empty) empty.hidden = others.length !== 0;
      root.hidden = false;
    }, function () {
      toast(t('errNetwork'));
    });
  }

  load();
})();
