/**
 * @fileoverview 旷野 › status 窗（/wild/#status，systemctl status space.target）：取 GET /api/status、渲染 space.target 两行 / 六个 unit / 可用率行 / 额度 / 用量 / 近期故障，
 * 页面可见时每 60 秒刷新。2026-11 对齐 PR-B：原 /status/ 页（卡片形式）并进旷野页，改成设计稿的终端窗；数据和行为不变（旧地址 301 到 /wild/#status）。
 * 2026-10-24 PR4 前是顶栏三栏的「状态」页，之后挪进账号页、再搬到设置。
 *
 * - v5 S3：旷野页对所有人公开，这张卡是三处上锁之一。/api/status 要进站会话（网关访问表 entry）；进站凭证使用记录（/api/space-audit）另要账号会话。
 * - 同源 cookie（credentials: 'same-origin'），no-store；没进站 401 → 锁卡（data-state=locked，#st-locked：Permission denied + 一行说明 +
 *   su 按钮（v6 割接），点了发 sgx:sudo，顶栏终端预填 su ）。锁了就不再自动重试；进站后页面会重新取（guard.js proceed）。
 * - 首帧（2026-10-24 PR3）：本机存着上次成功拿到的数据（localStorage sgx-status-cache，24 小时内）就先直接画出来，
 *   页脚是那份数据的「更新于 hh:mm」，同时照常请求，回来再换成新数据；没有缓存才出骨架。401 时清掉缓存。
 * - 第一次就失败（非 401）→ 错误卡，按钮重试；
 *   已经有数据后刷新失败 → 保留旧数据，页脚说「刷新失败，显示的是 hh:mm 的数据」。
 * - 接口通了但所有站都还没检查过 → 空状态卡。
 * - 点可用率条上的某一天 → 卡片底部显示那天的可用率 / 检查次数 / 平均延迟。
 * - 站点卡下面是「免费额度」（2026-10-27）：data.quota 有 → 今天的操作次数 / 上限 / 进度条（≥ 80% 琥珀、≥ 95% 红）；
 *   null → 「额度未配置 / 暂时拿不到」一行提示；没有 quota 字段（旧版监测 Worker）→ 整块不显示。额度卡有 Workers 请求时，用量卡不再重复那一行。
 * - 再下面是「用量」（PR3）：data.usage 有 → 每项值 / 上限 / 进度条 + 「更新于 N 分钟前」；null → 「用量未配置」等一行提示。
 * - 页底「进站凭证使用记录」折叠区（<details id="st-audit">）：默认收起，第一次展开才请求 GET /api/space-audit（KV list + 最多 50 次 get，
 *   所以不随页面加载、也不随 60 秒刷新）；成功后本页不再重复取，失败可点「重试」，401 只提示重新解锁，403（v6 身份不是 root，2b）提示 su root。
 *   页面不做角色判断（进门二值，没有角色）；接口照样由服务端判断。
 * 渲染全在 lib/status-view.js（纯函数，单测覆盖）；这里只管 DOM 和请求。
 */
import { on } from '../lib/events.js';
import { askSudo } from '../lib/sudo.js';
import { loadI18n, pageLang } from '../lib/i18n.js';
import { visibleInterval } from '../lib/scheduler.js';
import { bannerInfo, bjDay, buildSlots, esc, fmtBjTime, isEmptySummary, renderAudit, renderIncidents, renderQuota, renderSite, renderUnits, renderUsage, slotText, unitList } from '../lib/status-view.js';

export const STATUS_API = '/api/status';
export const AUDIT_API = '/api/space-audit';
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

function init() {
  const root = document.getElementById('st-root');
  if (!root) return;
  const lang = pageLang();
  const { t, fmt } = loadI18n('sgx-i18n-status');
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const banner = $('st-banner');
  const sitesEl = $('st-sites');
  const unitsEl = $('st-units');
  const uptimeEl = $('st-uptime');
  const checkedEl = $('st-checked');
  const incWrap = $('st-inc-wrap');
  const usageWrap = $('st-usage-wrap');
  const usageEl = $('st-usage');
  const quotaWrap = $('st-quota-wrap');
  const quotaEl = $('st-quota');
  const incEl = $('st-inc');
  const errEl = $('st-error');
  const lockedEl = $('st-locked');
  const emptyEl = $('st-empty');
  const foot = $('st-foot');
  /** @type {any} */
  let data = null;
  /** 上次成功拿到数据的时间（客户端时钟，页脚「更新于」用） */
  let gotAt = 0;
  /** 上次成功那一问的往返毫秒（auth unit 的延迟）；从缓存画首帧时没有 */
  /** @type {number|null} */
  let rtt = null;
  let busy = false;
  /** @type {'loading'|'ready'|'empty'|'error'|'locked'} */
  let state = 'loading';

  /** @param {'loading'|'ready'|'empty'|'error'|'locked'} s */
  function setState(s) {
    state = s;
    const none = s === 'error' || s === 'empty' || s === 'locked';
    root.setAttribute('data-state', s);
    root.setAttribute('aria-busy', s === 'loading' ? 'true' : 'false');
    errEl.hidden = s !== 'error';
    emptyEl.hidden = s !== 'empty';
    if (lockedEl) lockedEl.hidden = s !== 'locked';
    banner.hidden = none;
    sitesEl.hidden = none;
    if (uptimeEl) uptimeEl.hidden = none;
    if (unitsEl) unitsEl.hidden = none || s === 'loading';
    incWrap.hidden = s !== 'ready';
    usageWrap.hidden = s !== 'ready';
    quotaWrap.hidden = s !== 'ready' || !data || data.quota === undefined;
    if (none) {
      foot.textContent = '';
      if (checkedEl) checkedEl.textContent = '';
    }
  }

  function render() {
    const now = Date.now();
    const ctx = { t, fmt, lang, now, today: (data && data.today) || bjDay(now) };
    const b = bannerInfo(data, ctx);
    banner.setAttribute('data-state', b.state);
    /** @type {HTMLElement} */ (banner.querySelector('[data-st="active"]')).textContent = t(b.state === 'up' ? 'activeUp' : 'activeDown');
    /** @type {HTMLElement} */ (banner.querySelector('[data-st="title"]')).textContent = b.title;
    /** @type {HTMLElement} */ (banner.querySelector('[data-st="sub"]')).textContent = b.sub;
    if (unitsEl) unitsEl.innerHTML = renderUnits(unitList(data, rtt), ctx);
    if (checkedEl) checkedEl.textContent = fmt('checkedAt', { time: fmtBjTime(gotAt, lang, bjDay(now)) });
    sitesEl.innerHTML = (data.sites || []).map((s) => renderSite(s, ctx)).join('');
    incEl.innerHTML = renderIncidents(data.incidents || [], ctx);
    /* 旧版监测 Worker 没有 usage 字段 → 按没配处理 */
    /* 旧版监测 Worker 没有 quota 字段 → 额度块不显示 */
    const hasQuota = data.quota !== undefined;
    quotaWrap.hidden = state !== 'ready' || !hasQuota;
    if (hasQuota) quotaEl.innerHTML = renderQuota(data.quota || null, data.quota_reason || null, ctx);
    /* 旧版监测 Worker 没有 usage 字段 → 按没配处理 */
    usageEl.innerHTML = renderUsage(data.usage || null, data.usage_reason || (data.usage === undefined ? 'not-configured' : null), ctx,
      { skipWorkers: !!(data.quota && data.quota.workers) });
    foot.textContent = fmt('updated', { time: fmtBjTime(gotAt, lang, bjDay(now)) });
  }

  function showError() {
    /** @type {HTMLElement} */ (errEl.querySelector('[data-st="err-title"]')).textContent = t('errTitle');
    /** @type {HTMLElement} */ (errEl.querySelector('[data-st="err-sub"]')).textContent = t('errSub');
    const btn = /** @type {HTMLElement} */ (errEl.querySelector('[data-st="err-btn"]'));
    btn.textContent = t('retry');
    btn.setAttribute('data-action', 'retry');
    setState('error');
  }

  async function load() {
    if (busy) return;
    busy = true;
    let status = 0;
    const t0 = Date.now();
    try {
      const r = await fetch(STATUS_API, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      status = r.status;
      const j = r.ok ? await r.json() : null;
      if (!j || j.ok !== true || !Array.isArray(j.sites)) throw new Error('bad');
      data = j;
      gotAt = Date.now();
      rtt = gotAt - t0;
      writeCache(j, gotAt);
      /* 外壳（NAVIGATE STATUS 六格 / tmux 页脚）在本页不另取，用这一份 */
      try { document.dispatchEvent(new CustomEvent('sgx:status', { detail: j })); } catch (e) { /* 老浏览器没有 CustomEvent 构造：外壳维持缓存 / 灰 */ }
      if (isEmptySummary(j)) setState('empty');
      else {
        setState('ready');
        render();
      }
    } catch (e) {
      if (status === 401 || status === 403) {
        /* 没进站（401），或 v6 身份不在 status 组（2b：网关 403 forbidden）：清缓存、只剩锁卡（服务端说了算；缓存里的旧数据也不再显示） */
        dropCache();
        data = null;
        setState('locked');
      } else if (data && !isEmptySummary(data)) {
        /* 已经有数据：保留，页脚提示 */
        foot.textContent = fmt('stale', { time: fmtBjTime(gotAt, lang, bjDay(Date.now())) });
      } else {
        showError();
      }
    } finally {
      busy = false;
    }
  }

  on(errEl, 'click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-action]');
    if (!btn) return;
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
    detail.textContent = slotText(slot, { t, fmt, lang });
    detail.hidden = false;
  });

  /* 进站凭证使用记录：展开才取（见文件头） */
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
      auditBody.innerHTML = renderAudit(j.items, { t, fmt, lang, now: Date.now() });
      auditState = 'done';
    } catch (e) {
      auditState = 'error';
      const auth = status === 401;
      /* 2b：403 = 已登录但不是 root（v6 styrigx 等，网关 403 forbidden）：提示 su root，不说「会话过期」 */
      const perm = status === 403;
      auditBody.innerHTML = '<p class="st-audit-msg">' + esc(t(perm ? 'auditErrPerm' : auth ? 'auditErrAuth' : 'auditErr')) + '</p>' +
        (auth || perm ? '' : '<button type="button" class="st-btn st-audit-retry" data-audit-retry>' + esc(t('retry')) + '</button>');
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

  /* 首帧：有上次的数据就先画（不等网络），下面的第一次请求回来再换新 */
  const cached = readCache(Date.now());
  if (cached) {
    data = cached.data;
    gotAt = cached.at;
    setState('ready');
    render();
  }

  if (lockedEl) on(lockedEl, 'click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest('[data-st="sudo"]')) askSudo(document);
  });

  /* 2c：v6 su / exit / lock 之后页面标记就地切（window 'sgx:session'，detail.live）：登录了当场重取（锁卡换成数据），
     回访客当场换锁卡、清缓存；凭据记录作废上次的结论（展开着就重取）。守卫首帧那次没有 live，不管 */
  window.addEventListener('sgx:session', (/** @type {any} */ e) => {
    const d = e && e.detail;
    if (!d || !d.live) return;
    auditState = 'idle';
    if (auditEl && auditEl.open) loadAudit();
    if (d.ok) { load(); return; }
    dropCache();
    data = null;
    setState('locked');
  });

  /* 可见时每 60 秒刷新（切到后台停，回到前台立即刷一次）；第一次失败后的错误卡也照样每分钟自动再试，锁了不试 */
  visibleInterval(() => {
    if (state !== 'locked') load();
  }, REFRESH_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
