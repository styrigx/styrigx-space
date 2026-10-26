/**
 * @fileoverview 服务状态（账号 → 服务状态 /account/status/；2026-10-24 PR4 前是顶栏「状态」页）的纯函数：北京时间格式、时长、可用率、每日色块、当前状态，以及卡片 / 故障列表的 HTML。
 * 没有 DOM、没有请求（apps/account-status.js 负责取 /api/status、插进页面、每 60 秒刷新），node --test 直接测
 * （tests/web/ui/status-view.test.mjs）。
 *
 * 数据形状 = /api/status（网关转 styrigx-status 的 /summary，见 workers/status/src/monitor.js summary）：
 *   { ok, now, today, all_up,
 *     sites: [{ site, zh, en, url, checked, up, fails, last:{at,ok,code,ms,err}|null,
 *               uptime:{h24,d30,d90}, days:[{day,total,ok,avg_ms}], recent:[[at,ok,ms]] }],
 *     incidents: [{ id, site, started_at, ended_at|null, cause }] }
 * 日期（days[].day、today）是北京时间 YYYY-MM-DD；时间戳是毫秒。页面上的时间一律按北京时间显示（和监测的日期口径一致）。
 *
 * 文案：t(key) / fmt(key, vars) 来自页面里的 #sgx-i18n-status（partials/status-i18n.html，lib/i18n.js loadI18n）。
 */
import { esc } from './util.js';

export { esc };

export const DAY_MS = 24 * 3600 * 1000;
const BJ_OFFSET_MS = 8 * 3600 * 1000; /* 北京时间，没有夏令时（同 workers/status/src/monitor.js dayOf） */
/** 连续失败几次才算故障（同 workers/status/src/targets.js FAIL_THRESHOLD）：一天里少于这么多次失败只是零星抖动 */
export const BLIP_FAILS = 3;
/** 一天的可用率低于它算「故障日」，介于中间算「部分故障」 */
export const DOWN_RATIO = 0.95;
/** 可用率条的天数 */
export const BAR_DAYS = 90;

/** 页面上的站名（2026-10-22 定：主站 / 博客 / 日刻 / 奇趣 / 规则集）；接口里的 zh / en 兜底 */
export const SITE_NAMES = {
  space: { zh: '主站', en: 'Space' },
  blog: { zh: '博客', en: 'Blog' },
  daymark: { zh: '日刻', en: 'Daymark' },
  curio: { zh: '奇趣', en: 'Curio' },
  'proxy-rules': { zh: '规则集', en: 'Proxy rules' },
};

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {number} n */
const p2 = (n) => (n < 10 ? '0' : '') + n;

/** 北京时间日期 YYYY-MM-DD @param {number} ms */
export function bjDay(ms) {
  return new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 加减天数 @param {string} day @param {number} n */
export function addDays(day, n) {
  const t = Date.parse(day + 'T00:00:00Z');
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → 「10月22日」/「Oct 22」 @param {string} day @param {boolean} en */
export function fmtDay(day, en) {
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  return en ? MONTHS_EN[m - 1] + ' ' + d : m + '月' + d + '日';
}

/**
 * 北京时间「10月22日 14:03」/「Oct 22, 14:03」；sameDayAs 是同一天（北京）就只给「14:03」。
 * @param {number} ms
 * @param {boolean} en
 * @param {string} [sameDayAs] YYYY-MM-DD
 */
export function fmtBjTime(ms, en, sameDayAs) {
  const d = new Date(ms + BJ_OFFSET_MS);
  const hm = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  const day = d.toISOString().slice(0, 10);
  if (sameDayAs && day === sameDayAs) return hm;
  return en ? fmtDay(day, true) + ', ' + hm : fmtDay(day, false) + ' ' + hm;
}

/**
 * 时长：不到 1 分钟 / 7 分钟 / 1 小时 5 分钟 / 2 天 3 小时（向下取整到分钟）。
 * @param {number} ms
 * @param {(k:string, v?:Record<string,string|number>)=>string} fmt
 */
export function fmtDur(ms, fmt) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return fmt('durLt1');
  if (min < 60) return fmt('durMin', { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? fmt('durHM', { h, m }) : fmt('durH', { h });
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? fmt('durDH', { d, h: hh }) : fmt('durD', { d });
}

/**
 * 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 1 天前。
 * @param {number} at
 * @param {number} now
 * @param {(k:string, v?:Record<string,string|number>)=>string} fmt
 */
export function fmtAgo(at, now, fmt) {
  const min = Math.floor(Math.max(0, now - at) / 60000);
  if (min < 1) return fmt('justNow');
  if (min < 60) return fmt('minAgo', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return fmt('hourAgo', { n: h });
  return fmt('dayAgo', { n: Math.floor(h / 24) });
}

/** 可用率：null → 「—」；100 → 「100%」；其余两位小数「99.95%」 @param {number|null|undefined} v */
export function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n >= 100) return '100%';
  /* 只有 99.995 及以上会被四舍五入成 100.00%；还有失败就别显示成满分 */
  return Math.min(n, 99.99).toFixed(2) + '%';
}

/** ok / total → 百分数（两位小数），total 为 0 → null @param {number} ok @param {number} total */
export function pctOf(ok, total) {
  return total ? Math.round((ok / total) * 10000) / 100 : null;
}

/**
 * 一天的色块等级：none 没数据 · ok 正常（失败少于 3 次 = 零星抖动，不会开故障）· minor 部分故障 · down 故障（可用率 < 95%）。
 * @param {{total:number, ok:number}|null|undefined} d
 * @returns {'none'|'ok'|'minor'|'down'}
 */
export function dayLevel(d) {
  const total = d ? Number(d.total) || 0 : 0;
  if (!total) return 'none';
  const ok = Number(d.ok) || 0;
  const failed = total - ok;
  if (failed < BLIP_FAILS) return 'ok';
  return ok / total < DOWN_RATIO ? 'down' : 'minor';
}

/**
 * 可用率条：固定 n 格（默认 90，旧 → 新，最后一格 = today），没有数据的日子 level = none。
 * @param {Array<{day:string,total:number,ok:number,avg_ms:number|null}>} days
 * @param {string} today YYYY-MM-DD（北京）
 * @param {number} [n]
 */
export function buildSlots(days, today, n = BAR_DAYS) {
  /** @type {Map<string, any>} */
  const by = new Map();
  for (const d of days || []) if (d && d.day) by.set(d.day, d);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const d = by.get(day);
    out.push({
      day,
      total: d ? Number(d.total) || 0 : 0,
      ok: d ? Number(d.ok) || 0 : 0,
      avg_ms: d && d.avg_ms != null ? Number(d.avg_ms) : null,
      level: dayLevel(d),
    });
  }
  return out;
}

/**
 * 每站当前状态：pending 还没检查过 · down 故障（连续失败到了阈值）· flaky 最近一次失败但还没到阈值 · up 正常。
 * @param {any} s
 * @returns {'pending'|'up'|'flaky'|'down'}
 */
export function siteState(s) {
  if (!s || !s.checked || s.up == null) return 'pending';
  if (s.up === false) return 'down';
  if (s.last && s.last.ok === false) return 'flaky';
  return 'up';
}

/** 站名 @param {any} s 站点（或只有 site 字段的故障） @param {boolean} en */
export function siteName(s, en) {
  const n = SITE_NAMES[/** @type {keyof typeof SITE_NAMES} */ (s && s.site)];
  if (n) return en ? n.en : n.zh;
  return (s && (en ? s.en || s.zh : s.zh || s.en)) || (s && s.site) || '';
}

/** 地址的域名（blog.styrigx.com） @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

/**
 * 故障原因：timeout → 超时，network → 连不上，HTTP 502 原样。
 * @param {string|null|undefined} cause
 * @param {(k:string)=>string} t
 */
export function causeText(cause, t) {
  if (cause === 'timeout') return t('causeTimeout');
  if (cause === 'network') return t('causeNetwork');
  return cause ? String(cause) : t('causeUnknown');
}

/**
 * 最近一次检查：成功 → 「延迟 123 ms」；失败 → 原因（HTTP 502 / 超时 / 连不上）。
 * @param {{ok:boolean, code:number, ms:number, err:string|null}|null} last
 * @param {(k:string)=>string} t
 * @param {(k:string, v?:Record<string,string|number>)=>string} fmt
 */
export function lastText(last, t, fmt) {
  if (!last) return '';
  if (last.ok) return fmt('latency', { ms: Math.round(Number(last.ms) || 0) });
  if (last.err === 'status') return 'HTTP ' + last.code;
  return causeText(last.err, t);
}

/** 接口里还没有任何检查结果（Worker 刚上线 / 库是空的） @param {any} data */
export function isEmptySummary(data) {
  const sites = (data && data.sites) || [];
  return !sites.length || sites.every((s) => !s || !s.checked);
}

/**
 * 横幅：全部正常 / 有 N 个故障（N = 当前故障的站数）。
 * @param {any} data
 * @param {{t:(k:string)=>string, fmt:(k:string, v?:Record<string,string|number>)=>string, en:boolean}} ctx
 * @returns {{state:'up'|'down', title:string, sub:string, down:number}}
 */
export function bannerInfo(data, ctx) {
  const sites = (data && data.sites) || [];
  const downSites = sites.filter((s) => siteState(s) === 'down');
  const n = downSites.length;
  if (!n) {
    const live = sites.filter((s) => siteState(s) !== 'pending').length;
    return { state: 'up', title: ctx.t('allUp'), sub: ctx.fmt('allUpSub', { n: live }), down: 0 };
  }
  const sep = ctx.en ? ', ' : '、';
  return {
    state: 'down',
    title: ctx.fmt(n === 1 ? 'someDown1' : 'someDown', { n }),
    sub: ctx.fmt('someDownSub', { names: downSites.map((s) => siteName(s, ctx.en)).join(sep) }),
    down: n,
  };
}

/** 故障排序：进行中的在前，然后按开始时间新 → 旧 @param {any[]} list */
export function sortIncidents(list) {
  return (list || []).slice().sort((a, b) => {
    const ao = a.ended_at == null ? 1 : 0;
    const bo = b.ended_at == null ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return Number(b.started_at) - Number(a.started_at);
  });
}

/**
 * 某一格的说明（点色块时显示）：「10月21日 · 可用率 99.93% · 1440 次检查 · 平均 123 ms」，没数据 → 「10月21日 · 无数据」。
 * @param {{day:string,total:number,ok:number,avg_ms:number|null}} slot
 * @param {{t:(k:string)=>string, fmt:(k:string, v?:Record<string,string|number>)=>string, en:boolean}} ctx
 */
export function slotText(slot, ctx) {
  const day = fmtDay(slot.day, ctx.en);
  if (!slot.total) return ctx.fmt('dayNoData', { day });
  let s = ctx.fmt('dayDetail', { day, pct: fmtPct(pctOf(slot.ok, slot.total)), total: slot.total });
  if (slot.avg_ms != null) s += ctx.fmt('dayAvg', { ms: slot.avg_ms });
  return s;
}

/**
 * 近 90 天可用率：用接口算好的 uptime.d90（= 有数据的那些天，最多 90 天）；没有就按 days 自己算。
 * @param {any} s
 */
export function uptime90(s) {
  if (s && s.uptime && s.uptime.d90 != null) return Number(s.uptime.d90);
  const [ok, total] = ((s && s.days) || []).reduce((a, d) => [a[0] + (Number(d.ok) || 0), a[1] + (Number(d.total) || 0)], [0, 0]);
  return pctOf(ok, total);
}

/**
 * 一张站点卡（article.st-card）。色块是 span，整条 role="img" 带可读的总结；点色块的说明由 apps/account-status.js 填进 .st-detail。
 * @param {any} s
 * @param {{t:(k:string)=>string, fmt:(k:string, v?:Record<string,string|number>)=>string, en:boolean, now:number, today:string}} ctx
 */
export function renderSite(s, ctx) {
  const state = siteState(s);
  const name = siteName(s, ctx.en);
  const chip = { up: 'stUp', flaky: 'stFlaky', down: 'stDown', pending: 'stPending' }[state];
  const meta = [];
  if (s.last) {
    meta.push('<span class="st-meta-last" data-ok="' + (s.last.ok ? '1' : '0') + '">' + esc(lastText(s.last, ctx.t, ctx.fmt)) + '</span>');
    meta.push('<span class="st-meta-at">' + esc(ctx.fmt('checkedAgo', { ago: fmtAgo(s.last.at, ctx.now, ctx.fmt) })) + '</span>');
  } else {
    meta.push('<span class="st-meta-at">' + esc(ctx.t('notChecked')) + '</span>');
  }
  const slots = buildSlots(s.days, ctx.today);
  const pct = fmtPct(uptime90(s));
  const cells = slots.map((x, i) => '<span class="st-cell" data-level="' + x.level + '" data-i="' + i + '"></span>').join('');
  return (
    '<article class="widget bg-m-container-lowest st-card" data-site="' + esc(s.site) + '" data-state="' + state + '">' +
      '<div class="st-card-head">' +
        '<div class="st-card-id"><h2 class="st-name">' + esc(name) + '</h2><p class="st-host">' + esc(hostOf(s.url)) + '</p></div>' +
        '<span class="st-chip" data-state="' + state + '"><span class="st-dot" aria-hidden="true"></span>' + esc(ctx.t(chip)) + '</span>' +
      '</div>' +
      '<p class="st-meta">' + meta.join('<span class="st-sep" aria-hidden="true">·</span>') + '</p>' +
      '<div class="st-bar" role="img" aria-label="' + esc(ctx.fmt('barLabel', { name, pct })) + '">' + cells + '</div>' +
      '<div class="st-bar-foot"><span>' + esc(ctx.t('daysAgo90')) + '</span><span class="st-pct">' + esc(ctx.fmt('uptime', { pct })) + '</span><span>' + esc(ctx.t('today')) + '</span></div>' +
      '<p class="st-detail" hidden></p>' +
    '</article>'
  );
}

/**
 * 故障列表（ul.st-inc-list）；没有故障 → 一行空状态。
 * @param {any[]} incidents
 * @param {{t:(k:string)=>string, fmt:(k:string, v?:Record<string,string|number>)=>string, en:boolean, now:number, today:string}} ctx
 */
export function renderIncidents(incidents, ctx) {
  const list = sortIncidents(incidents);
  if (!list.length) return '<p class="st-inc-none">' + esc(ctx.t('incNone')) + '</p>';
  const items = list.map((x) => {
    const open = x.ended_at == null;
    const start = Number(x.started_at);
    const startDay = bjDay(start);
    const parts = [ctx.fmt('incStart', { time: fmtBjTime(start, ctx.en) })];
    if (open) {
      parts.push(ctx.fmt('incDurOngoing', { dur: fmtDur(ctx.now - start, ctx.fmt) }));
    } else {
      const end = Number(x.ended_at);
      parts.push(ctx.fmt('incEnd', { time: fmtBjTime(end, ctx.en, startDay) }));
      parts.push(ctx.fmt('incDur', { dur: fmtDur(end - start, ctx.fmt) }));
    }
    return (
      '<li class="st-inc" data-open="' + (open ? '1' : '0') + '" data-site="' + esc(x.site) + '">' +
        '<div class="st-inc-head">' +
          '<span class="st-inc-site">' + esc(siteName(x, ctx.en)) + '</span>' +
          '<span class="st-chip" data-state="' + (open ? 'down' : 'resolved') + '"><span class="st-dot" aria-hidden="true"></span>' + esc(ctx.t(open ? 'incOngoing' : 'incResolved')) + '</span>' +
        '</div>' +
        '<p class="st-inc-cause">' + esc(causeText(x.cause, ctx.t)) + '</p>' +
        '<p class="st-inc-time">' + parts.map(esc).join('<span class="st-sep" aria-hidden="true">·</span>') + '</p>' +
      '</li>'
    );
  });
  return '<ul class="st-inc-list">' + items.join('') + '</ul>';
}

/* ===== 根凭证使用记录（GET /api/root-audit；账号 → 服务状态页底部的折叠区，展开才请求）=====
 * 接口给 { ok, items: [{ ts, ipPrefix, ok }] }，已按新到旧排好、最多 AUDIT_MAX 条，记录保留 7 天。 */

/** 接口一次最多给几条（同 workers/auth-gateway/functions/api/root-audit.js AUDIT_SHOW） */
export const AUDIT_MAX = 50;

/**
 * 根凭证使用记录：一行合计（共 N 条、失败 M 条；满 50 条时注明只显示最近 50 条）+ 每条一行（结果、北京时间、IP 前缀）；
 * 没有记录 → 一行「最近 7 天没有使用记录」。坏数据（没有时间戳）跳过。
 * @param {any} items
 * @param {{t:(k:string)=>string, fmt:(k:string, v?:Record<string,string|number>)=>string, en:boolean, now:number}} ctx
 */
export function renderAudit(items, ctx) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && Number.isFinite(Number(x.ts)));
  if (!list.length) return '<p class="st-audit-none">' + esc(ctx.t('auditNone')) + '</p>';
  const today = bjDay(ctx.now);
  const fail = list.filter((x) => x.ok !== true).length;
  let meta = ctx.fmt('auditCount', { n: list.length, fail });
  if (list.length >= AUDIT_MAX) meta += ctx.t('auditCap');
  const rows = list.map((x) => {
    const ok = x.ok === true;
    return (
      '<li class="st-audit-item" data-ok="' + (ok ? '1' : '0') + '">' +
        '<span class="st-chip" data-state="' + (ok ? 'up' : 'down') + '"><span class="st-dot" aria-hidden="true"></span>' + esc(ctx.t(ok ? 'auditOk' : 'auditFail')) + '</span>' +
        '<span class="st-audit-time">' + esc(fmtBjTime(Number(x.ts), ctx.en, today)) + '</span>' +
        '<span class="st-audit-ip">' + esc(x.ipPrefix || ctx.t('auditIpUnknown')) + '</span>' +
      '</li>'
    );
  });
  return '<p class="st-audit-meta">' + esc(meta) + '</p><ul class="st-audit-list">' + rows.join('') + '</ul>';
}

/* ===== 用量（2026-10-22 PR3）=====
 * 数据 = /api/status 的 usage / usage_reason（workers/status/src/usage.js readUsage）：
 *   usage: { fetched_at, stale?, last_error?,
 *            workers: { requests, limit, day } | null,
 *            d1: { total_bytes, limit_bytes, per_db_limit_bytes, databases: [{ name, bytes }] } | null,
 *            r2: { bytes, objects, buckets, limit_bytes } | null,
 *            kv: { bytes|null, keys|null, namespaces|null, limit_bytes, error? } | null,
 *            errors: { [part]: code } } | null
 *   usage_reason: null | 'not-configured' | 'secret-missing' | 'not-collected' | 'api-error' | 'db'（secret-missing 也显示「用量未配置」）
 * 进度条：> 70% 琥珀（warn），> 90% 红（crit）。字节按十进制（1 GB = 10^9 B），和 Cloudflare 文档的额度写法一致。 */

/** 琥珀 / 红的门槛（百分比，严格大于） */
export const USAGE_WARN = 70;
export const USAGE_CRIT = 90;

/** 千分位（不依赖运行环境的 locale） @param {number} n */
export function fmtCount(n) {
  const v = Math.round(Number(n) || 0);
  return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, v < 0 ? '-' : '');
}

/** 字节 → 「512 B」「5.3 MB」「392 MB」「2 GB」（十进制；< 10 留一位小数，去掉 .0） @param {number|null|undefined} b */
export function fmtBytes(b) {
  if (b == null || !Number.isFinite(Number(b))) return '—';
  let v = Math.max(0, Number(b));
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  if (i === 0) return Math.round(v) + ' B';
  let s = v < 10 ? v.toFixed(1) : String(Math.round(v));
  if (s.endsWith('.0')) s = s.slice(0, -2);
  /* 999.6 MB 四舍五入成 1000 MB：进一位 */
  if (s === '1000' && i < units.length - 1) return '1 ' + units[i + 1];
  return s + ' ' + units[i];
}

/** 用了多少（百分比，0–∞，不封顶；limit 不对 → null） @param {number|null|undefined} value @param {number} limit */
export function usagePct(value, limit) {
  if (value == null || !Number.isFinite(Number(value)) || !(Number(limit) > 0)) return null;
  return (Math.max(0, Number(value)) / Number(limit)) * 100;
}

/** 百分比文字：「73.5%」「<0.1%」「0%」 @param {number|null} p */
export function fmtUsagePct(p) {
  if (p == null) return '—';
  if (p === 0) return '0%';
  if (p < 0.1) return '<0.1%';
  return (p < 10 ? p.toFixed(1) : p >= 100 ? String(Math.round(p)) : p.toFixed(1)).replace(/\.0$/, '') + '%';
}

/** 进度条等级：ok · warn（> 70%）· crit（> 90%）· none（没数据） @param {number|null} p */
export function usageLevel(p) {
  if (p == null) return 'none';
  if (p > USAGE_CRIT) return 'crit';
  if (p > USAGE_WARN) return 'warn';
  return 'ok';
}

/**
 * 用量条目（渲染前的纯数据，单测直接看它）。顺序：Workers 请求 → D1 合计 → 每个 D1 库（缩进）→ R2 → KV。
 * 某一项拿不到（null）→ 一行「暂时拿不到」，没有进度条。
 * @param {any} usage
 * @param {{t:(k:string)=>string, fmt:(k:string, v?:Record<string,string|number>)=>string, en:boolean}} ctx
 * @returns {Array<{key:string, label:string, value:string, limit:string, pct:number|null, level:string, sub:string, child:boolean}>}
 */
export function usageItems(usage, ctx) {
  const out = [];
  const u = usage || {};
  /** @param {string} key @param {string} label @param {number|null} val @param {number} lim @param {(n:number)=>string} f @param {string} sub @param {boolean} [child] */
  const add = (key, label, val, lim, f, sub, child = false) => {
    const pct = usagePct(val, lim);
    out.push({ key, label, value: val == null ? '—' : f(val), limit: f(lim), pct, level: usageLevel(pct), sub, child });
  };
  const missing = (/** @type {string} */ key, /** @type {string} */ label) =>
    out.push({ key, label, value: '—', limit: '', pct: null, level: 'none', sub: ctx.t('uUnavailable'), child: false });

  if (u.workers) add('workers', ctx.t('uWorkers'), Number(u.workers.requests) || 0, Number(u.workers.limit) || 100000, fmtCount, ctx.t('uWorkersSub'));
  else missing('workers', ctx.t('uWorkers'));

  if (u.d1) {
    const dbs = Array.isArray(u.d1.databases) ? u.d1.databases : [];
    add('d1', ctx.t('uD1'), Number(u.d1.total_bytes) || 0, Number(u.d1.limit_bytes) || 5e9, fmtBytes,
      ctx.fmt('uD1Sub', { n: dbs.length, per: fmtBytes(Number(u.d1.per_db_limit_bytes) || 5e8) }));
    for (const d of dbs) add('d1db', String(d.name || ''), Number(d.bytes) || 0, Number(u.d1.per_db_limit_bytes) || 5e8, fmtBytes, '', true);
  } else missing('d1', ctx.t('uD1'));

  if (u.r2) add('r2', ctx.t('uR2'), Number(u.r2.bytes) || 0, Number(u.r2.limit_bytes) || 1e10, fmtBytes,
    ctx.fmt('uR2Sub', { buckets: fmtCount(u.r2.buckets), objects: fmtCount(u.r2.objects) }));
  else missing('r2', ctx.t('uR2'));

  if (u.kv) {
    const lim = Number(u.kv.limit_bytes) || 1e9;
    if (u.kv.bytes == null) {
      add('kv', ctx.t('uKV'), null, lim, fmtBytes,
        u.kv.namespaces == null ? ctx.t('uUnavailable') : ctx.fmt('uKVSubNoBytes', { n: fmtCount(u.kv.namespaces) }));
    } else {
      add('kv', ctx.t('uKV'), Number(u.kv.bytes) || 0, lim, fmtBytes,
        ctx.fmt('uKVSub', { n: fmtCount(u.kv.namespaces || 0), keys: fmtCount(u.kv.keys || 0) }));
    }
  } else missing('kv', ctx.t('uKV'));
  return out;
}

/**
 * 「用量」区块里卡片的 HTML（标题 h3 在模板里）：
 *   有数据 → div.st-usage（每项：名字 · 值 / 上限 · 百分比 · 进度条 · 说明）+ 页脚「更新于 N 分钟前（北京时间 hh:mm）」
 *   usage = null → 一行提示（not-configured「用量未配置」；not-collected 还没收过；其他 暂时拿不到）
 * @param {any} usage
 * @param {string|null|undefined} reason
 * @param {{t:(k:string)=>string, fmt:(k:string, v?:Record<string,string|number>)=>string, en:boolean, now:number}} ctx
 */
export function renderUsage(usage, reason, ctx) {
  if (!usage) {
    const r = reason || 'not-configured';
    const k = r === 'not-configured' || r === 'secret-missing' ? 'uNotConfigured' : r === 'not-collected' ? 'uNotCollected' : 'uError';
    return (
      '<div class="st-usage-none" data-reason="' + esc(r) + '">' +
        '<p class="st-usage-none-title">' + esc(ctx.t(k)) + '</p>' +
        '<p class="st-usage-none-sub">' + esc(ctx.t(k + 'Sub')) + '</p>' +
      '</div>'
    );
  }
  const rows = usageItems(usage, ctx).map((x) => {
    const pctTxt = fmtUsagePct(x.pct);
    const val = x.limit ? ctx.fmt('uOf', { value: x.value, limit: x.limit }) : x.value;
    const bar = x.pct == null
      ? ''
      : '<div class="st-u-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.min(100, Math.round(x.pct)) +
        '" aria-label="' + esc(ctx.fmt('uBarLabel', { name: x.label, pct: pctTxt })) + '">' +
        '<span class="st-u-fill" data-level="' + x.level + '" style="width:' + (x.pct > 0 ? Math.min(100, Math.max(1, x.pct)).toFixed(1) : '0') + '%"></span></div>';
    return (
      '<li class="st-u" data-key="' + esc(x.key) + '" data-level="' + x.level + '"' + (x.child ? ' data-child="1"' : '') + '>' +
        '<div class="st-u-head">' +
          '<span class="st-u-name">' + esc(x.label) + '</span>' +
          '<span class="st-u-val">' + esc(val) + (x.pct == null ? '' : '<span class="st-u-pct">' + esc(pctTxt) + '</span>') + '</span>' +
        '</div>' +
        bar +
        (x.sub ? '<p class="st-u-sub">' + esc(x.sub) + '</p>' : '') +
      '</li>'
    );
  });
  const at = Number(usage.fetched_at) || 0;
  const foot = at
    ? ctx.fmt('uUpdated', { ago: fmtAgo(at, ctx.now, ctx.fmt), time: fmtBjTime(at, ctx.en, bjDay(ctx.now)) }) + (usage.stale ? ctx.t('uStale') : '')
    : '';
  return '<ul class="st-usage">' + rows.join('') + '</ul>' + (foot ? '<p class="st-usage-foot"' + (usage.stale ? ' data-stale="1"' : '') + '>' + esc(foot) + '</p>' : '');
}
