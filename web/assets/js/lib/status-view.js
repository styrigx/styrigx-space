/**
 * @fileoverview 状态页（/status/）的纯函数：北京时间格式、时长、可用率、每日色块、当前状态，以及卡片 / 故障列表的 HTML。
 * 没有 DOM、没有请求（apps/status.js 负责取 /api/status、插进页面、每 60 秒刷新），node --test 直接测
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
  space: { zh: '主站', en: 'Main site' },
  blog: { zh: '博客', en: 'Blog' },
  daymark: { zh: '日刻', en: 'Daymark' },
  curio: { zh: '奇趣', en: 'Curio' },
  'proxy-rules': { zh: '规则集', en: 'Proxy rules' },
};

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** HTML 转义 @param {any} s */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

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
 * 一张站点卡（article.st-card）。色块是 span，整条 role="img" 带可读的总结；点色块的说明由 apps/status.js 填进 .st-detail。
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
