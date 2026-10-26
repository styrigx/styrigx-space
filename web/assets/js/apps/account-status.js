/**
 * @fileoverview 账号 → 服务状态（/account/status/）：取 GET /api/status、渲染横幅 / 站点卡 / 近期故障，页面可见时每 60 秒刷新。
 * 2026-10-24 PR4：原来是顶栏三栏的「状态」页（/status/，apps/status.js），整页挪进账号页成为子页，旧页面删除；数据和行为不变。
 *
 * - 账号区子页：GET /api/account 明确说没有账号会话 → 回账号页登录，登录后回本页（account-common.js requireAccountSession）。
 *   读不到（网络 / 访客）不跳；访客本来就进不了账号区（网关 302 回首页）。数据本身仍只要锁屏会话（/api/status 不变）。
 * - 同源 cookie（credentials: 'same-origin'），no-store；网关验锁屏会话（admin / visitor 都行），没会话 401。
 * - 首帧（2026-10-24 PR3）：本机存着上次成功拿到的数据（localStorage sgx-status-cache，24 小时内）就先直接画出来，
 *   页脚是那份数据的「更新于 hh:mm」，同时照常请求，回来再换成新数据；没有缓存才出骨架。401 时清掉缓存。
 * - 第一次就失败 → 错误卡（401 = 会话过期，按钮重新载入页面走锁屏；其他 = 重试）；
 *   已经有数据后刷新失败 → 保留旧数据，页脚说「刷新失败，显示的是 hh:mm 的数据」。
 * - 接口通了但所有站都还没检查过 → 空状态卡。
 * - 点可用率条上的某一天 → 卡片底部显示那天的可用率 / 检查次数 / 平均延迟。
 * - 站点卡下面是「用量」（PR3）：data.usage 有 → 每项值 / 上限 / 进度条 + 「更新于 N 分钟前」；null → 「用量未配置」等一行提示。
 * - 页底「根凭证使用记录」折叠区（<details id="st-audit">）：默认收起，第一次展开才请求 GET /api/root-audit（KV list + 最多 50 次 get，
 *   所以不随页面加载、也不随 60 秒刷新）；成功后本页不再重复取，失败可点「重试」，401 只提示重新解锁。
 *   页面不做角色判断（访客进不了账号区，网关 302），接口服务端照样只认 admin 锁屏会话。
 * 渲染全在 lib/status-view.js（纯函数，单测覆盖）；这里只管 DOM 和请求。
 */
import { on } from '../lib/events.js';
import { loadI18n } from '../lib/i18n.js';
import { isEn } from '../lib/util.js';
import { visibleInterval } from '../lib/scheduler.js';
import { requireAccountSession } from './account-common.js';
import { bannerInfo, bjDay, buildSlots, esc, fmtBjTime, isEmptySummary, renderAudit, renderIncidents, renderSite, renderUsage, slotText } from '../lib/status-view.js';

export const STATUS_API = '/api/status';
export const AUDIT_API = '/api/root-audit';
export const REFRESH_MS = 60 * 1000;
export const CACHE_KEY = 'sgx-status-cache';
export const CACHE_MAX_MS = 24 * 3600 * 1000;

/**
 * 读本机缓存的上次数据；没有 / 坏了 / 太旧 / 是空汇总 → null。
 * @param {number} now
 * @returns {{at:number, data:any}|null}
 */
export function readCache(now) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c || typeof c.at !== 'number' || !c.data || c.data.ok !== true || !Array.isArray(c.data.sites)) return null;
    if (c.at > now + 60 * 1000 || now - c.at > CACHE_MAX_MS || isEmptySummary(c.data)) return null;
    return c;
  } catch (e) {
    return null;
  }
}

/** @param {any} data @param {number} at */
function writeCache(data, at) {
  try {
    if (isEmptySummary(data)) localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, JSON.stringify({ at, data }));
  } catch (e) {}
}

function dropCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

const ICON_OK = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>';

function init() {
  const root = document.getElementById('st-root');
  if (!root) return;
  const en = isEn();
  const { t, fmt } = loadI18n('sgx-i18n-status');
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const banner = $('st-banner');
  const sitesEl = $('st-sites');
  const incWrap = $('st-inc-wrap');
  const usageWrap = $('st-usage-wrap');
  const usageEl = $('st-usage');
  const incEl = $('st-inc');
  const errEl = $('st-error');
  const emptyEl = $('st-empty');
  const foot = $('st-foot');
  /** @type {any} */
  let data = null;
  /** 上次成功拿到数据的时间（客户端时钟，页脚「更新于」用） */
  let gotAt = 0;
  let busy = false;
  /** 会话过期（401）：不再自动重试，等用户点「重新解锁」 */
  let authErr = false;
  /** @type {'loading'|'ready'|'empty'|'error'} */
  let state = 'loading';

  /** @param {'loading'|'ready'|'empty'|'error'} s */
  function setState(s) {
    state = s;
    root.setAttribute('data-state', s);
    root.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false');
    errEl.hidden = s !== 'error';
    emptyEl.hidden = s !== 'empty';
    banner.hidden = s === 'error' || s === 'empty';
    sitesEl.hidden = s === 'error' || s === 'empty';
    incWrap.hidden = s !== 'ready';
    usageWrap.hidden = s !== 'ready';
    if (s === 'error' || s === 'empty') foot.textContent = '';
  }

  function render() {
    const now = Date.now();
    const ctx = { t, fmt, en, now, today: (data && data.today) || bjDay(now) };
    const b = bannerInfo(data, ctx);
    banner.setAttribute('data-state', b.state);
    /** @type {HTMLElement} */ (banner.querySelector('.st-banner-ic')).innerHTML = b.state === 'up' ? ICON_OK : ICON_DOWN;
    /** @type {HTMLElement} */ (banner.querySelector('[data-st="title"]')).textContent = b.title;
    /** @type {HTMLElement} */ (banner.querySelector('[data-st="sub"]')).textContent = b.sub;
    sitesEl.innerHTML = (data.sites || []).map((s) => renderSite(s, ctx)).join('');
    incEl.innerHTML = renderIncidents(data.incidents || [], ctx);
    /* 旧版监测 Worker 没有 usage 字段 → 按没配处理 */
    usageEl.innerHTML = renderUsage(data.usage || null, data.usage_reason || (data.usage === undefined ? 'not-configured' : null), ctx);
    foot.textContent = fmt('updated', { time: fmtBjTime(gotAt, en, bjDay(now)) });
  }

  /** @param {number} status */
  function showError(status) {
    const auth = status === 401;
    authErr = auth;
    /** @type {HTMLElement} */ (errEl.querySelector('[data-st="err-title"]')).textContent = t(auth ? 'errAuth' : 'errTitle');
    /** @type {HTMLElement} */ (errEl.querySelector('[data-st="err-sub"]')).textContent = t(auth ? 'errAuthSub' : 'errSub');
    const btn = /** @type {HTMLElement} */ (errEl.querySelector('[data-st="err-btn"]'));
    btn.textContent = t(auth ? 'unlock' : 'retry');
    btn.setAttribute('data-action', auth ? 'reload' : 'retry');
    setState('error');
  }

  async function load() {
    if (busy) return;
    busy = true;
    let status = 0;
    try {
      const r = await fetch(STATUS_API, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      status = r.status;
      const j = r.ok ? await r.json() : null;
      if (!j || j.ok !== true || !Array.isArray(j.sites)) throw new Error('bad');
      data = j;
      gotAt = Date.now();
      writeCache(j, gotAt);
      if (isEmptySummary(j)) setState('empty');
      else {
        setState('ready');
        render();
      }
    } catch (e) {
      if (status === 401) dropCache();
      if (data && !isEmptySummary(data) && status !== 401) {
        /* 已经有数据：保留，页脚提示 */
        foot.textContent = fmt('stale', { time: fmtBjTime(gotAt, en, bjDay(Date.now())) });
      } else {
        showError(status);
      }
    } finally {
      busy = false;
    }
  }

  on(errEl, 'click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
    if (!btn) return;
    if (btn.getAttribute('data-action') === 'reload') {
      location.reload();
      return;
    }
    authErr = false;
    setState('loading');
    load();
  });

  /* 点色块：卡片底部显示那一天的说明；再点同一格收起 */
  on(sitesEl, 'click', (e) => {
    const cell = /** @type {HTMLElement} */ (e.target).closest('.st-cell');
    if (!cell || !data) return;
    const card = /** @type {HTMLElement} */ (cell.closest('.st-card'));
    const site = (data.sites || []).find((/** @type {any} */ s) => s.site === card.getAttribute('data-site'));
    const detail = /** @type {HTMLElement} */ (card.querySelector('.st-detail'));
    if (!site || !detail) return;
    const i = Number(cell.getAttribute('data-i'));
    const prev = card.querySelector('.st-cell[data-picked]');
    if (prev) prev.removeAttribute('data-picked');
    if (prev === cell) {
      detail.hidden = true;
      return;
    }
    const now = Date.now();
    const slot = buildSlots(site.days, data.today || bjDay(now))[i];
    if (!slot) return;
    cell.setAttribute('data-picked', '1');
    detail.textContent = slotText(slot, { t, fmt, en });
    detail.hidden = false;
  });

  /* 根凭证使用记录：展开才取（见文件头） */
  const auditEl = /** @type {HTMLDetailsElement|null} */ (document.getElementById('st-audit'));
  const auditBody = document.getElementById('st-audit-body');
  /** @type {'idle'|'loading'|'done'|'error'} */
  let auditState = 'idle';

  async function loadAudit() {
    if (!auditBody || auditState === 'loading' || auditState === 'done') return;
    auditState = 'loading';
    auditBody.setAttribute('aria-busy', 'true');
    auditBody.innerHTML = '<p class="st-audit-msg">' + esc(t('auditLoading')) + '</p>';
    let status = 0;
    try {
      const r = await fetch(AUDIT_API, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      status = r.status;
      const j = r.ok ? await r.json() : null;
      if (!j || j.ok !== true || !Array.isArray(j.items)) throw new Error('bad');
      auditBody.innerHTML = renderAudit(j.items, { t, fmt, en, now: Date.now() });
      auditState = 'done';
    } catch (e) {
      auditState = 'error';
      const auth = status === 401;
      auditBody.innerHTML = '<p class="st-audit-msg">' + esc(t(auth ? 'auditErrAuth' : 'auditErr')) + '</p>' +
        (auth ? '' : '<button type="button" class="st-btn st-audit-retry" data-audit-retry>' + esc(t('retry')) + '</button>');
    } finally {
      auditBody.setAttribute('aria-busy', 'false');
    }
  }

  if (auditEl && auditBody) {
    on(auditEl, 'toggle', () => {
      if (auditEl.open) loadAudit();
    });
    on(auditBody, 'click', (e) => {
      if (!(/** @type {HTMLElement} */ (e.target).closest('[data-audit-retry]'))) return;
      auditState = 'idle';
      loadAudit();
    });
  }

  /* 账号区：没有账号会话 → 回账号页登录（不挡首帧，和下面的状态请求同时发） */
  requireAccountSession(en);

  /* 首帧：有上次的数据就先画（不等网络），下面的第一次请求回来再换新 */
  const cached = readCache(Date.now());
  if (cached) {
    data = cached.data;
    gotAt = cached.at;
    setState('ready');
    render();
  }

  /* 可见时每 60 秒刷新（切到后台停，回到前台立即刷一次）；第一次失败后的错误卡也照样每分钟自动再试，只有会话过期不试 */
  visibleInterval(() => {
    if (!authErr) load();
  }, REFRESH_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
