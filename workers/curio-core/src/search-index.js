/**
 * @fileoverview 全站搜索索引：奇趣自己把收藏、设备、游戏、电影、音乐（元数据）写进 KV styrigx-space-gateway（2026-11 前 styrigx-search-index）的 site:curio。
 * 这份索引只给 AI 用（站内没有搜索界面）：styrigx-ai 关键词召回直接读它，每小时 Cron 再切段写进 Vectorize 做语义召回（2026-11 AI 语义召回）。
 *
 * 值的格式（与 styrigx-space 仓库 workers/ai/src/core/rank.js 一致）：
 *   { site: 'curio', generated: ISO 时间, items: Item[] }
 *   Item = { id, type: 'item', lang: 'zh'|'en', title, subtitle?, text?, url, private?: true }
 *
 * 每条出两条：中文条目（lang zh，链到 /curio/zh/）和英文条目（lang en，链到 /curio/）。
 *   - 发现（links）：title = 名字（缺这种语言就用另一种）；subtitle =「发现 · 分类名」/ "Finds · <cat>"；
 *     text = 简介（两种语言）+ 网址；url = 发现子页 finds/ + 所在分类 #c/<分类 id>（本站没有单条收藏的深链）
 *   - 设备（devices）：title = 名字；subtitle =「设备 · 类型 · 系统」；text = 系统、参数、配件、体验；url = 设备子页 devices/
 *   - 游戏（games）：title = 名字；subtitle =「游戏 · 平台 · 状态」；text = 版本、评价；url = 游戏子页 games/
 *   - 电影（movies）：title = 片名；subtitle =「电影 · 年份 · 导演」；text = 原名、导演、年份、评分、观看日期、短评；url = 电影子页 movies/
 *   - 音乐（music_albums + music_tracks，元数据）：一张专辑一条，title = 专辑名；subtitle =「音乐 · 歌手 · 年份」；text = 歌手 + 曲目表（曲序. 曲名）；
 *     url = 音乐子页 music/。音频 / 封面 / 歌词不进。2026-11 AI 语义召回起电影、音乐都进（Gray 2026-11-07：除账号数据外全部放开，
 *     站有门锁、音乐已付费，不按版权敏感处理）；两者都没有私密列，不标 private（进门即可问）
 *   - text 最多 2000 字，只参与匹配，搜索 Worker 不回给前端
 *   - private：账号未登录看不到的标 private:true，只给账号已登录的人搜到。规则同 _store.js 的 listAll、_items.js 的 listItems：
 *     收藏是「分类或收藏任一私密」，设备 / 游戏看自己的 private
 *
 * 什么时候写：
 *   - 每次改内容的写接口（/api/links、/api/items、/api/import）成功后由 index.js 用 ctx.waitUntil 重建
 *   - Cron 每小时兜底重建一次（wrangler.toml [triggers]），首次部署后也靠它填上。
 *     兜底时先读 KV 里那份的 metadata.sha（内容指纹，不含 generated 时间），一样就不写：一次读换一次写，
 *     省下账号共享的 KV 写额度（免费版每天 1000 次）。写接口触发的重建照常写。
 * 出错只打日志，不抛给调用方，绝不影响接口本身。
 */
import { ensureSchema } from './api/_store.js';
import { ensureItemSchema } from './api/_items.js';
import { ensureMovieSchema } from './api/_movies.js';
import { ensureMusicSchema } from './api/_music.js';

export const SITE = 'curio';
export const KEY = 'site:' + SITE;
/** 本站在图志下的地址（不带结尾斜杠）：条目链接 = SITE_URL + /（英文）或 /zh/（中文）+ hash */
export const SITE_URL = 'https://styrigx.com/curio';
const TITLE_MAX = 80;
const TEXT_MAX = 2000;
/* KV 单值上限 25 MiB；留余量，超了就去掉 text（标题、副标题还能搜） */
const VALUE_MAX = 24 * 1024 * 1024;

/* 页签名、设备类型、游戏状态：和页面上一样（字符串表 atlas/web/curio/data/i18n/<语言>.yaml 的 entries / js.curioItems）。
   语言包化第二部分（2026-11-07）：英文是底（EN），其他语言是覆盖层（LAYERS），缺的键回退英文；加语言 = LAYERS 加一份 */
const EN = {
  finds: 'Finds', devices: 'Devices', games: 'Games', movies: 'Movies', music: 'Music', rating: 'Rating', watched: 'Watched', artist: 'Artist', director: 'Director', original: 'Original title',
  kinds: { phone: 'Phone', tablet: 'Tablet', laptop: 'Laptop', desktop: 'Desktop', watch: 'Watch', audio: 'Audio', console: 'Console', camera: 'Camera', other: 'Other' },
  status: { want: 'Want to play', playing: 'Playing', done: 'Finished', shelved: 'On hold' },
};
/** @type {Record<string, any>} */
const LAYERS = {
  zh: {
    finds: '发现', devices: '设备', games: '游戏', movies: '电影', music: '音乐', rating: '评分', watched: '观看日期', artist: '歌手', director: '导演', original: '原名',
    kinds: { phone: '手机', tablet: '平板', laptop: '笔记本', desktop: '台式机', watch: '手表', audio: '耳机音箱', console: '游戏机', camera: '相机', other: '其他' },
    status: { want: '想玩', playing: '在玩', done: '通关', shelved: '搁置' },
  },
};
/**
 * 某种语言的标签：英文底 ← 该语言覆盖层（两层深合并，缺键回退英文）。
 * @param {string} lang
 */
export function labels(lang) {
  const o = LAYERS[lang] || {};
  return {
    finds: o.finds || EN.finds, devices: o.devices || EN.devices, games: o.games || EN.games,
    movies: o.movies || EN.movies, music: o.music || EN.music, rating: o.rating || EN.rating, watched: o.watched || EN.watched,
    artist: o.artist || EN.artist, director: o.director || EN.director, original: o.original || EN.original,
    kinds: Object.assign({}, EN.kinds, o.kinds), status: Object.assign({}, EN.status, o.status),
  };
}
/** 本站语言（同 atlas/web/curio/hugo.yaml languages）；默认语言英文，不带前缀。加语言：这里加一项 + 字符串表（索引里的条目顺序沿用 zh、en） */
export const LANGS = Object.freeze(['zh', 'en']);
export const DEFAULT_LANG = 'en';

/** 截断到 n 个字（按码点，不切坏表情），超了加省略号；换行压成空格 */
export function clip(s, n) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : flat;
}

/** 双语字段取一种：这种语言空着就用另一种（同前端） */
function pick(zh, en, lang) {
  const a = String((lang === 'en' ? en : zh) || '').trim();
  return a || String((lang === 'en' ? zh : en) || '').trim();
}

/**
 * 子页地址（P4-3 奇趣拆页：发现 / 设备 / 游戏各是一页 /curio/<分区>/；PR-4c：英文无前缀，中文 /curio/zh/<分区>/；
 * 同主站 lib/lang-path.js 的规则，Worker 不能 import 前端文件）+ hash
 * @param {'zh'|'en'} lang @param {string} section finds / devices / games / movies / music（空 = 首页） @param {string} [hash]
 */
export function pageUrl(lang, section, hash) {
  return SITE_URL + (lang && lang !== DEFAULT_LANG ? '/' + lang + '/' : '/') + (section ? section + '/' : '') + (hash || '');
}

/** @param {Record<string, any>} it @param {string} subtitle @param {string[]} parts @param {boolean} priv */
function finish(it, subtitle, parts, priv) {
  if (subtitle) it.subtitle = subtitle;
  const text = parts.map((p) => String(p || '').trim()).filter(Boolean).join('\n').slice(0, TEXT_MAX);
  if (text) it.text = text;
  if (priv) it.private = true;
  return it;
}

/**
 * 一条收藏 → 两条索引。r 是 links 表的行，cat 是 cats 表的行（可能 undefined：分类已不在）。
 * @param {Record<string, any>} r @param {Record<string, any>|undefined} cat
 */
export function linkItems(r, cat) {
  const priv = !!r.private || !cat || !!cat.private;
  const out = [];
  for (const lang of LANGS) {
    const title = clip(pick(r.name_zh, r.name_en, lang), TITLE_MAX);
    if (!title) continue;
    const catName = cat ? pick(cat.name_zh, cat.name_en, lang) : '';
    const it = { id: 'link:' + r.id + (lang === 'en' ? ':en' : ''), type: 'item', lang, title, url: pageUrl(lang, 'finds', cat ? '#c/' + cat.id : '') };
    const descMain = pick(r.desc_zh, r.desc_en, lang);
    const descOther = lang === 'en' ? r.desc_zh : r.desc_en;
    out.push(finish(it, [labels(lang).finds, catName].filter(Boolean).join(' · '), [descMain, descOther !== descMain ? descOther : '', r.url], priv));
  }
  return out;
}

/** 一台设备 → 两条索引 @param {Record<string, any>} r */
export function deviceItems(r) {
  const out = [];
  for (const lang of LANGS) {
    const title = clip(r.name, TITLE_MAX);
    if (!title) continue;
    const T = labels(lang);
    const it = { id: 'device:' + r.id + (lang === 'en' ? ':en' : ''), type: 'item', lang, title, url: pageUrl(lang, 'devices') };
    const sub = [T.devices, T.kinds[r.kind] || T.kinds.other, r.os].filter(Boolean).join(' · ');
    out.push(finish(it, sub, [r.os, r.specs, r.accessories, r.notes], !!r.private));
  }
  return out;
}

/** 一个游戏 → 两条索引 @param {Record<string, any>} r */
export function gameItems(r) {
  const out = [];
  for (const lang of LANGS) {
    const title = clip(r.title, TITLE_MAX);
    if (!title) continue;
    const T = labels(lang);
    const it = { id: 'game:' + r.id + (lang === 'en' ? ':en' : ''), type: 'item', lang, title, url: pageUrl(lang, 'games') };
    const sub = [T.games, r.platform, T.status[r.status] || ''].filter(Boolean).join(' · ');
    out.push(finish(it, sub, [r.platform, r.edition, r.review], !!r.private));
  }
  return out;
}

/** 一部电影 → 两条索引（没有私密列） @param {Record<string, any>} r */
export function movieItems(r) {
  const out = [];
  for (const lang of LANGS) {
    const title = clip(r.title, TITLE_MAX);
    if (!title) continue;
    const T = labels(lang);
    const it = { id: 'movie:' + r.id + (lang === 'en' ? ':en' : ''), type: 'item', lang, title, url: pageUrl(lang, 'movies') };
    const sub = [T.movies, r.year ? String(r.year) : '', r.director].filter(Boolean).join(' · ');
    const parts = [
      r.original_title ? T.original + ': ' + r.original_title : '',
      r.director ? T.director + ': ' + r.director : '',
      r.rating ? T.rating + ': ' + r.rating + '/5' : '',
      r.watched_at ? T.watched + ': ' + r.watched_at : '',
      r.review,
    ];
    out.push(finish(it, sub, parts, false));
  }
  return out;
}

/** 一张专辑（连曲目表）→ 两条索引（没有私密列；只有元数据） @param {Record<string, any>} a @param {Array<Record<string, any>>} tracks */
export function albumItems(a, tracks) {
  const out = [];
  const list = (tracks || []).map((t) => (t.no ? t.no + '. ' : '') + String(t.title || '').trim()).filter((x) => x.trim()).join('\n');
  for (const lang of LANGS) {
    const title = clip(a.title, TITLE_MAX);
    if (!title) continue;
    const T = labels(lang);
    const it = { id: 'album:' + a.id + (lang === 'en' ? ':en' : ''), type: 'item', lang, title, url: pageUrl(lang, 'music') };
    const sub = [T.music, a.artist, a.year ? String(a.year) : ''].filter(Boolean).join(' · ');
    out.push(finish(it, sub, [a.artist ? T.artist + ': ' + a.artist : '', list], false));
  }
  return out;
}

/**
 * 从 D1 读全部收藏、设备、游戏、电影、音乐（页面上的顺序），拼成索引值。
 * 一个 batch 跨 cats / links / devices / games / movies / music 几套数据（同一快照），用主表 links 那套的绑定 D1_FINDS 执行
 * （D1_FINDS / D1_DEVICES / D1_GAMES / D1_MOVIES / D1_MUSIC 是同一个库 styrigx-curio-core）。
 * @param {any} db  D1_FINDS
 */
export async function buildIndex(db, now = Date.now()) {
  await ensureSchema(db);
  await ensureItemSchema(db);
  await ensureMovieSchema(db);
  await ensureMusicSchema(db);
  const [cats, links, devices, games, movies, albums, tracks] = await db.batch([
    db.prepare('SELECT id, name_zh, name_en, private FROM cats ORDER BY pos, id'),
    db.prepare('SELECT id, cat_id, url, name_zh, name_en, desc_zh, desc_en, private FROM links ORDER BY pos, id'),
    db.prepare('SELECT id, name, kind, os, specs, accessories, notes, private FROM devices ORDER BY pos, id'),
    db.prepare('SELECT id, title, platform, edition, status, review, private FROM games ORDER BY pos, id'),
    db.prepare('SELECT id, title, original_title, year, director, rating, review, watched_at FROM movies ORDER BY pos, id'),
    db.prepare('SELECT id, title, artist, year FROM music_albums ORDER BY pos, id'),
    db.prepare('SELECT album_id, no, title FROM music_tracks ORDER BY album_id, no, id'),
  ]);
  const byId = new Map((cats.results || []).map((c) => [c.id, c]));
  const items = [];
  for (const r of links.results || []) items.push(...linkItems(r, byId.get(r.cat_id)));
  for (const r of devices.results || []) items.push(...deviceItems(r));
  for (const r of games.results || []) items.push(...gameItems(r));
  for (const r of movies.results || []) items.push(...movieItems(r));
  /** @type {Map<any, any[]>} */
  const byAlbum = new Map();
  for (const t of tracks.results || []) {
    if (!byAlbum.has(t.album_id)) byAlbum.set(t.album_id, []);
    byAlbum.get(t.album_id).push(t);
  }
  for (const a of albums.results || []) items.push(...albumItems(a, byAlbum.get(a.id)));
  return { site: SITE, generated: new Date(now).toISOString(), items };
}

/** 索引内容指纹：sha256(JSON {site, items})，不含 generated（时间每次都变） */
export async function contentSha(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ site: value.site, items: value.items })));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 重建并写入 KV（metadata 带内容指纹 sha）。永不抛错：
 * 成功 {ok:true, count}，内容没变跳过写 {ok:true, count, unchanged:true}，失败 {ok:false, error}（只打日志，不带内容）。
 * @param {Record<string, any>} env
 * @param {number} [now]
 * @param {{skipUnchanged?: boolean}} [opts] skipUnchanged：KV 里那份的 metadata.sha 和这次一样就不写（Cron 兜底用）；
 *   读不到 / 读出错 / 没有 metadata 都照常写
 */
export async function rebuildSearchIndex(env, now = Date.now(), opts = {}) {
  try {
    const kv = env && env.KV_SEARCH_INDEX;
    if (!kv || typeof kv.put !== 'function') {
      console.error('[curio-search] KV_SEARCH_INDEX binding missing');
      return { ok: false, error: 'kv-binding-missing' };
    }
    if (!env.D1_FINDS) {
      console.error('[curio-search] D1_FINDS binding missing');
      return { ok: false, error: 'db-binding-missing' };
    }
    const value = await buildIndex(env.D1_FINDS, now);
    let body = JSON.stringify(value);
    if (body.length > VALUE_MAX) {
      for (const it of value.items) delete it.text;
      body = JSON.stringify(value);
    }
    const sha = await contentSha(value);
    if (opts && opts.skipUnchanged && typeof kv.getWithMetadata === 'function') {
      let prev = null;
      try {
        prev = await kv.getWithMetadata(KEY);
      } catch (e) {
        prev = null; /* 读失败就照常写 */
      }
      if (prev && prev.value != null && prev.metadata && prev.metadata.sha === sha) {
        return { ok: true, count: value.items.length, unchanged: true };
      }
    }
    await kv.put(KEY, body, { metadata: { sha } });
    return { ok: true, count: value.items.length };
  } catch (e) {
    console.error('[curio-search] rebuild failed: ' + (e && e.message ? e.message : 'error'));
    return { ok: false, error: 'rebuild-failed' };
  }
}

/* 改内容的接口：收藏、设备 / 游戏、导入、电影、音乐（专辑 / 曲目增删改、上传曲目）。照片（/api/photo）不进索引，换照片不用重建 */
const CONTENT_ROUTES = ['/api/links', '/api/items', '/api/import', '/api/movies', '/api/music', '/api/music-upload'];
const MUTATING = ['POST', 'PUT', 'DELETE', 'PATCH'];

/** 这次请求成功改了要进索引的内容吗（内容接口 + 写方法 + 2xx）；key 是 routeKey 后的路径 */
export function isContentMutation(key, method, status) {
  return CONTENT_ROUTES.includes(key) && MUTATING.includes(String(method || '').toUpperCase()) && status >= 200 && status < 300;
}
