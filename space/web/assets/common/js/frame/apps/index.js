/**
 * @fileoverview 主页（/，中文 /zh/）四节和首屏里要运行时取数的部分（2026-11 对齐 PR-B，设计稿 tb4.html；2026-11-21 重排 博客 / 日刻 / 音乐 / 奇趣）：
 * - [02] 日刻 今日一句（apps/daymark-today.js，/daymark/api/today 公开只读）
 * - [03] 音乐 最新 4 张专辑（/music/api/music，只有元数据；封面 /music/api/music-cover 公开）
 * - [04] 奇趣 三个目录卡：计数 + 最近收藏 / 在用 / 在玩（/curio/api/links、/curio/api/items，进门即可读，私密的服务端不给）
 * - 首屏状态胶囊：接外壳 topbar/panel.js mountStatus 发的 sgx:status-cells（同一份 /api/status，不另取）
 * - hero：$ 行标语打字轮播（apps/home-typer.js）；# 行签名 motto 空值时整行隐藏（跟 sgx-profile-changed）
 * mountHome() 由 apps/entries/entry-space.js 在加载时调一次（先于 initCore，事件监听在外壳取数之前挂好）。
 */
import { mountDaymarkToday, mountDaymarkCounts } from './daymark-today.js';
import { i18nTable } from '../../i18n/i18n.js';
import { PROFILE_EVENT } from '../../prefs/profile.js';
import { mountTyper } from './home-typer.js';

/** 界面文案：页面字符串表 #sgx-i18n-space */
const tx = i18nTable('space');

/**
 * 奇趣三个目录的计数与那一条（纯函数，单测看它）。
 * finds = 所有分类的链接数，最近收藏 = id 最大的那条；devices = 设备数，在用 = 没退役（retired_at 空）的第一台（按接口顺序 = 排序位）；
 * games = 游戏数，在玩 = status 为 playing 的第一个。拿不到的部分给 null。
 * @param {any} links /curio/api/links 的结果（{ok, cats:[{links:[{id,name:{zh,en},url}]}]}）或 null
 * @param {any} items /curio/api/items 的结果（{ok, devices:[...], games:[...]}）或 null
 * @param {string} lang 页面语言（名字取 name[lang]，缺了回退另一种 / 域名）
 * @returns {{finds: {n:number, latest:string}|null, devices: {n:number, latest:string}|null, games: {n:number, latest:string}|null}}
 */
export function curioSummary(links, items, lang) {
  const nm = function (/** @type {any} */ o, /** @type {string} */ url) {
    const n = o && typeof o === 'object' ? (o[lang] || o.zh || o.en || '') : String(o || '');
    if (n) return String(n);
    try { return new URL(url).host; } catch (e) { return ''; }
  };
  let finds = null;
  if (links && links.ok && Array.isArray(links.cats)) {
    /** @type {any[]} */
    const all = [];
    links.cats.forEach(function (/** @type {any} */ c) { (c && Array.isArray(c.links) ? c.links : []).forEach(function (/** @type {any} */ l) { if (l) all.push(l); }); });
    const top = all.reduce(function (/** @type {any} */ a, /** @type {any} */ b) { return !a || Number(b.id) > Number(a.id) ? b : a; }, null);
    finds = { n: all.length, latest: top ? nm(top.name, top.url) : '' };
  }
  let devices = null;
  let games = null;
  if (items && items.ok) {
    const ds = Array.isArray(items.devices) ? items.devices : [];
    const inUse = ds.find(function (/** @type {any} */ d) { return d && !d.retired_at; });
    devices = { n: ds.length, latest: inUse ? String(inUse.name || '') : '' };
    const gs = Array.isArray(items.games) ? items.games : [];
    const playing = gs.find(function (/** @type {any} */ g) { return g && g.status === 'playing'; });
    games = { n: gs.length, latest: playing ? String(playing.title || '') : '' };
  }
  return { finds: finds, devices: devices, games: games };
}

/** 主页 [03] 音乐放几张 */
export const MUSIC_LATEST_N = 4;
/**
 * 最新几张专辑（纯函数，单测看它）：/music/api/music 的结果 → 按记录 id 从新到旧的前 n 张专辑（kind 不是 single；单曲不进这一行）。
 * 链接 = 音乐页直达这张专辑（?album=<专辑记录 id>，2026-11-21 起；之前链歌手页 ?artist=）；封面有才给 /music/api/music-cover?album=<id>。
 * @param {any} j GET /music/api/music 的回答（{ok, albums:[{id, kind, title, artist, artist_id, cover}]}）或 null
 * @param {string} musicHref 当前语言的音乐页地址（/music/、/music/zh/）
 * @param {number} [n]
 * @returns {Array<{id:number, title:string, artist:string, cover:string, href:string}>|null} 拿不到（不是 ok / 没列表）给 null
 */
export function musicLatest(j, musicHref, n) {
  if (!j || !j.ok || !Array.isArray(j.albums)) return null;
  const base = String(musicHref || '/music/');
  return j.albums
    .filter(function (/** @type {any} */ a) { return a && a.kind !== 'single' && Number(a.id) > 0; })
    .sort(function (/** @type {any} */ a, /** @type {any} */ b) { return Number(b.id) - Number(a.id); })
    .slice(0, n || MUSIC_LATEST_N)
    .map(function (/** @type {any} */ a) {
      return {
        id: Number(a.id),
        title: String(a.title || ''),
        artist: String(a.artist || ''),
        cover: a.cover ? '/music/api/music-cover?album=' + Number(a.id) : '',
        href: base + '?album=' + Number(a.id),
      };
    });
}

/**
 * 外壳的六格状态 → 摘要（纯函数；首屏胶囊用 up / n）：up / n、平均延迟（有数的格子取平均，四舍五入）、检查时间（北京时间 HH:MM）。
 * @param {{t:number, cells: Record<string, {up:boolean, ms:number|null}>}} v
 */
export function statusSummary(v) {
  const ids = Object.keys((v && v.cells) || {});
  let up = 0;
  /** @type {number[]} */
  const ms = [];
  ids.forEach(function (id) {
    const c = v.cells[id];
    if (c && c.up) up++;
    if (c && typeof c.ms === 'number') ms.push(c.ms);
  });
  const avg = ms.length ? Math.round(ms.reduce(function (a, b) { return a + b; }, 0) / ms.length) : null;
  let at = '';
  if (v && v.t) {
    const d = new Date(Number(v.t) + 8 * 3600 * 1000);
    at = ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
  }
  return { up: up, n: ids.length, avg: avg, at: at };
}

/** @param {string} url */
function getJSON(url) {
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });
}

/**
 * 挂主页（每块主页 DOM 只调一次）。不在主页（没有 #home-hero）返回 null。
 * @param {{direct?: boolean}} [o] direct：直接打开 / 刷新的那页（回到顶部）
 * @returns {{activate: () => void, deactivate: () => void}|null}
 */
export function mountHome(o) {
  if (!document.getElementById('home-hero')) return null;
  if (o && o.direct) {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);
  }
  const lang = (document.documentElement.lang || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';

  /* hero：$ 行标语打字轮播；# 行签名（个人资料 motto，prefs/profile.js 用 textContent 覆盖）空了就藏整行，账号页改了跟着变 */
  mountTyper(document.querySelector('[data-home-typer]'));
  const motto = /** @type {HTMLElement|null} */ (document.querySelector('[data-home-motto-line]'));
  if (motto) {
    const syncMotto = function () {
      const v = motto.querySelector('[data-sgx-profile="motto"]');
      motto.hidden = !(v && (v.textContent || '').trim());
    };
    syncMotto();
    window.addEventListener(PROFILE_EVENT, syncMotto);
  }

  /* [02] 日刻 · 今日一句：先画本地缓存（同一天才用），再静默拉新；拉失败且没缓存 → 保持隐藏 */
  const dm = document.getElementById('w-daymark');
  /* 等的时候那行「› fetching daymark…」：有结论（缓存画上 / 拉到 / 拉失败）就收起 */
  const dmWait = /** @type {HTMLElement|null} */ (document.querySelector('[data-dm-wait]'));
  /* 等日刻时顶栏头像外圈的弧转快一档，有结论就恢复（只发一次 false；topbar/panel.js mountAvBusy） */
  let dmBusy = false;
  if (dm && dmWait && !dmWait.hidden) { dmBusy = true; document.dispatchEvent(new CustomEvent('sgx-busy', { detail: true })); }
  if (dm) mountDaymarkToday(dm, { en: lang === 'en', onSettled: function () {
    if (dmWait) dmWait.hidden = true;
    if (dmBusy) { dmBusy = false; document.dispatchEvent(new CustomEvent('sgx-busy', { detail: false })); }
  } });
  else if (dmWait) dmWait.hidden = true;
  /* 日刻小字「 · 拾录 N · 百味 N」（R-05）：和今日一句各拉各的，失败只是不显示计数 */
  if (dm) mountDaymarkCounts(dm);

  /* 首屏胶囊：外壳每次画 NAVIGATE STATUS 时发 sgx:status-cells（旧 [04] 旷野 status 小卡 2026-11-12 随旷野删除） */
  const pill = document.querySelector('[data-home-status]');
  const pillDot = document.querySelector('[data-home-status-dot]');
  document.addEventListener('sgx:status-cells', function (/** @type {any} */ e) {
    const s = statusSummary(e && e.detail);
    if (!s.n) return;
    const ok = s.up === s.n;
    if (pill) pill.textContent = tx(ok ? 'homeStatusUp' : 'homeStatusDown', { up: s.up, n: s.n });
    if (pillDot) pillDot.setAttribute('data-up', ok ? '1' : '0');
  });

  /* [03] 音乐：最新几张专辑。测试构建（SGX_TEST_NO_WB）同奇趣不问接口（e2e 要测时先设 window.__sgxMusicApi = true）；
     等的时候「› fetching music…」，有结论就收起；拿不到 / 没专辑保持「—」占位 */
  const mu = /** @type {HTMLElement|null} */ (document.querySelector('[data-home-music]'));
  const muWait = /** @type {HTMLElement|null} */ (document.querySelector('[data-mu-wait]'));
  const noMuApi = typeof SGX_TEST_NO_WB !== 'undefined' && SGX_TEST_NO_WB && !(/** @type {any} */ (window).__sgxMusicApi);
  if (mu && !noMuApi && typeof fetch === 'function') {
    getJSON('/music/api/music').then(function (j) {
      if (muWait) muWait.hidden = true;
      const list = musicLatest(j, mu.getAttribute('data-music-href') || '/music/');
      if (!list || !list.length) return;
      const slots = Array.from(mu.querySelectorAll('[data-mu-slot]'));
      slots.forEach(function (el, i) {
        const a = /** @type {HTMLAnchorElement} */ (el);
        const it = list[i];
        if (!it) { const li = a.closest('li'); if (li) li.remove(); return; }
        a.href = it.href;
        const t = a.querySelector('[data-mu-title]');
        const ar = a.querySelector('[data-mu-artist]');
        if (t) t.textContent = it.title || '—';
        if (ar) ar.textContent = it.artist;
        if (it.cover) {
          const c = a.querySelector('.home-alb-c');
          const img = document.createElement('img');
          img.alt = '';
          img.decoding = 'async';
          img.loading = 'lazy';
          img.addEventListener('error', function () { img.remove(); });
          img.src = it.cover;
          if (c) c.appendChild(img);
        }
      });
    });
  } else if (muWait) muWait.hidden = true;

  /* [04] 奇趣：CI 静态测试构建（SGX_TEST_NO_WB）没有接口，加载时不问（404 会进控制台，Lighthouse errors-in-console）；
     e2e 要测时先设 window.__sgxCurioApi = true（只在测试构建里有这个分支，生产构建整段按常量摇掉） */
  const cu = document.querySelector('[data-home-curio]');
  const noApi = typeof SGX_TEST_NO_WB !== 'undefined' && SGX_TEST_NO_WB && !(/** @type {any} */ (window).__sgxCurioApi);
  if (cu && !noApi && typeof fetch === 'function') {
    Promise.all([getJSON('/curio/api/links'), getJSON('/curio/api/items')]).then(function (r) {
      const sum = /** @type {Record<string, {n:number, latest:string}|null>} */ (curioSummary(r[0], r[1], lang));
      ['finds', 'devices', 'games'].forEach(function (k) {
        const a = cu.querySelector('[data-curio="' + k + '"]');
        const v = sum[k];
        if (!a || !v) return;
        const c = a.querySelector('[data-curio-count]');
        const l = a.querySelector('[data-curio-latest]');
        if (c) c.textContent = String(v.n);
        if (l) l.textContent = v.latest || '—';
      });
    });
  }
  return {
    activate() {},
    deactivate() {},
  };
}
