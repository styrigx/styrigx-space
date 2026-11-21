/**
 * @fileoverview 只读固定查询（2026-11 AI 语义召回）：问句里认出意图 → 调奇趣的服务绑定 CURIO（atlas-core 的 CurioReader.query）→ 结果当一条上下文。
 *
 * 模型不写 SQL、也不挑查询：这里用规则认意图，参数只有数字 n 和问句原文 q（atlas-core 那边参数化 bind，见 workers/atlas-core/src/curio/reader.js）。
 *   recentMovies { n }：问句提到电影 + 最近 / 新 / recent…；n 从问句里取（阿拉伯数字或一到二十的中文数字），默认 5，最多 20。
 *   music { q }：问句提到专辑 / 曲目 / 歌 / 歌手 / album / track / song / artist…；atlas-core 找专辑名或歌手名是问句子串的专辑，回曲目表。
 *   daymarkToday {}：问句同时提到「今天 / 今日 / today」和「日刻 / daymark」（或直接说「今日一句」）→ 日刻的服务绑定 DAYMARK（atlas-core 的 DaymarkReader.today），
 *     回北京时间今天的那一句（只出公开句子，同 GET /daymark/api/today）。R-35（2026-11-15）：site:daymark 索引没有日期绑定，问「日刻今天那句是什么」召回不到。
 * 没绑 CURIO / DAYMARK / 调用超时（FIXED_TIMEOUT_MS）/ 出错 → 这一条不要（只打日志），不影响回答。
 * 电影、音乐都没有私密列，进门即可问（Gray 2026-11-07），所以这里不看账号会话。
 */

export const FIXED_TIMEOUT_MS = 3000;
export const CURIO_URL = 'https://styrigx.com/curio';
export const DAYMARK_URL = 'https://styrigx.com/daymark';
/** 音乐页（music 搬家第 4 步：音乐是第四个子站，英文 /music/、中文 /music/zh/；之前是奇趣子页 /curio/music/） */
export const MUSIC_URL = 'https://styrigx.com/music';

const ZH_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 问句里的数量（「最近 3 部」「最近十部」「last 7 movies」）；没有 → 0 @param {string} q */
export function parseCount(q) {
  const m = /(?<!\d)(\d{1,2})(?!\d)/.exec(q);
  if (m) return Number(m[1]);
  const z = /([一两二三四五六七八九十]{1,3})\s*(?:部|个|条)/.exec(q);
  if (!z) return 0;
  const s = z[1];
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (ZH_NUM[s[1]] || 0);
  if (s.endsWith('十')) return (ZH_NUM[s[0]] || 1) * 10;
  if (s.length === 3 && s[1] === '十') return (ZH_NUM[s[0]] || 1) * 10 + (ZH_NUM[s[2]] || 0);
  return ZH_NUM[s[0]] || 0;
}

const MOVIE_RE = /电影|影片|片子|看过|观影|movie|film/i;
const RECENT_RE = /最近|近来|近期|最新|新看|上次|最后|recent|latest|last|newest/i;
const TODAY_RE = /今天|今日|当天|今儿|today|of the day/i;
const DAYMARK_RE = /日刻|daymark|一句|句子|quote/i;
const DAYMARK_ONLY_RE = /今日一句|每日一句|日刻|daymark/i;
const MUSIC_RE = /专辑|单曲|曲目|歌单|歌曲|歌手|乐队|音乐|这首|首歌|唱的|album|track|song|music|artist|singer|band/i;

/**
 * 认意图（纯函数）。
 * @param {string} q
 * @returns {Array<{name: 'recentMovies'|'music'|'daymarkToday', params: Record<string, any>}>}
 */
export function detectIntents(q) {
  const s = String(q || '');
  const out = [];
  if (MOVIE_RE.test(s) && RECENT_RE.test(s)) {
    const n = parseCount(s);
    out.push({ name: /** @type {const} */ ('recentMovies'), params: { n: n > 0 ? Math.min(20, n) : 5 } });
  }
  if (MUSIC_RE.test(s)) out.push({ name: /** @type {const} */ ('music'), params: { q: s.slice(0, 200) } });
  /* 今天 + 日刻：「一句 / 句子 / quote」单独和「今天」一起不算（「今天写了一句代码」），要么带日刻 / daymark，要么是「今日一句」这个词 */
  if (TODAY_RE.test(s) && DAYMARK_RE.test(s) && DAYMARK_ONLY_RE.test(s)) out.push({ name: /** @type {const} */ ('daymarkToday'), params: {} });
  return out;
}

/** 奇趣子页地址：英文（默认语言）无前缀，其他语言 /<语言>/（同 workers/atlas-core/src/curio/search-index.js pageUrl） @param {string} lang @param {string} section */
function pageUrl(lang, section) {
  return CURIO_URL + (lang && lang !== 'en' ? '/' + lang + '/' : '/') + section + '/';
}

/** 音乐页地址：英文 /music/，其他语言 /music/<语言>/（同 workers/atlas-core/src/curio/search-index.js musicUrl） @param {string} lang */
function musicUrl(lang) {
  return MUSIC_URL + (lang && lang !== 'en' ? '/' + lang + '/' : '/');
}

/** 秒 → m:ss @param {any} s */
function dur(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '';
  return Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0');
}

/* 上下文标签：英文是底（EN），其他语言是覆盖层（LAYERS），缺的键回退英文（同 workers/atlas-core/src/curio/search-index.js 的语言包写法） */
const EN = {
  today: "Daymark · today's quote", todayWhere: 'Daymark', todayDay: 'Date (Beijing time): ', todayTrans: 'Translation: ', todayBy: 'By: ',
  movies: 'Recently watched movies', moviesWhere: 'Curio › Movies', music: 'Albums and tracks', musicWhere: 'Curio › Music', single: 'single',
  rated: 'rated ', watched: 'watched ', review: '. Review: ', sep: ', ', open: ' (', close: ')',
};
/** @type {Record<string, Partial<typeof EN>>} */
const LAYERS = {
  zh: { today: '日刻 · 今日一句', todayWhere: '日刻', todayDay: '日期（北京时间）：', todayTrans: '译文：', todayBy: '出处：', movies: '最近看的电影', moviesWhere: '奇趣 › 电影', music: '专辑与曲目', musicWhere: '奇趣 › 音乐', single: '单曲', rated: '评分 ', watched: '观看 ', review: '。短评：', sep: '，', open: '（', close: '）' },
};
/** @param {string} lang @returns {typeof EN} */
function labels(lang) {
  return Object.assign({}, EN, LAYERS[lang] || {});
}

/**
 * 查询结果 → 上下文条目（同 RecallHit 形状）。没有结果 → null。
 * @param {string} name @param {any} r @param {'zh'|'en'} lang
 */
export function toHit(name, r, lang) {
  const T = labels(lang);
  if (!r || r.ok !== true) return null;
  if (name === 'daymarkToday' && r.quote && r.quote.text) {
    const q = r.quote;
    const by = [q.author, q.source].filter(Boolean).join(' · ');
    const lines = [q.text, q.trans ? T.todayTrans + q.trans : '', by ? T.todayBy + by : '', r.day ? T.todayDay + r.day : ''].filter(Boolean);
    return { site: 'daymark', type: 'query', title: T.today, subtitle: T.todayWhere, url: DAYMARK_URL + (lang === 'zh' ? '/zh/' : '/'), text: lines.join('\n').slice(0, 1200), private: false };
  }
  if (name === 'recentMovies' && Array.isArray(r.movies) && r.movies.length) {
    const lines = r.movies.map((/** @type {any} */ m, /** @type {number} */ i) => {
      const bits = [m.year ? String(m.year) : '', m.director || '', m.rating ? T.rated + m.rating + '/5' : '', m.watched_at ? T.watched + m.watched_at : ''].filter(Boolean);
      const orig = m.original_title && m.original_title !== m.title ? T.open + m.original_title + T.close : '';
      return (i + 1) + '. ' + m.title + orig + (bits.length ? ' — ' + bits.join(T.sep) : '') + (m.review ? T.review + m.review : '');
    });
    return { site: 'curio', type: 'query', title: T.movies, subtitle: T.moviesWhere, url: pageUrl(lang, 'movies'), text: lines.join('\n'), private: false };
  }
  if (name === 'music' && Array.isArray(r.albums) && r.albums.length) {
    const blocks = r.albums.map((/** @type {any} */ a) => {
      /* 单曲（kind=single，v1.13 ②）标「单曲」，不当专辑讲 */
      const head = a.title + (a.artist ? ' — ' + a.artist : '') + (a.year ? ' (' + a.year + ')' : '') + (a.kind === 'single' ? ' [' + T.single + ']' : '');
      const tracks = (a.tracks || []).map((/** @type {any} */ t) => '  ' + (t.no ? t.no + '. ' : '') + t.title + (dur(t.duration) ? ' ' + dur(t.duration) : ''));
      return [head, ...tracks].join('\n');
    });
    return { site: 'curio', type: 'query', title: T.music, subtitle: T.musicWhere, url: musicUrl(lang), text: blocks.join('\n\n').slice(0, 2400), private: false };
  }
  return null;
}

/**
 * 跑认出来的固定查询，回上下文条目（可能为空）。永不抛错。
 * @param {any} env @param {string} q @param {'zh'|'en'} lang
 * @returns {Promise<import('./recall.js').RecallHit[]>}
 */
export async function fixedHits(env, q, lang) {
  const curio = env && env.CURIO;
  const daymark = env && env.DAYMARK;
  /* 每个意图对应的调用；没绑对应的服务就跳过这一个 */
  const call = (/** @type {{name: string, params: any}} */ it) => {
    if (it.name === 'daymarkToday') return daymark && typeof daymark.today === 'function' ? () => daymark.today() : null;
    return curio && typeof curio.query === 'function' ? () => curio.query(it.name, it.params) : null;
  };
  const intents = detectIntents(q).filter((it) => call(it));
  if (!intents.length) return [];
  const runs = intents.map(async (it) => {
    /** @type {any} */
    let timer;
    try {
      const r = await Promise.race([
        /** @type {() => Promise<any>} */ (call(it))(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), FIXED_TIMEOUT_MS); }),
      ]);
      return toHit(it.name, r, lang);
    } catch (e) {
      console.error('[ai] fixed query failed', JSON.stringify({ name: it.name, error: String((e && /** @type {any} */ (e).message) || 'error').slice(0, 120) }));
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  return /** @type {any} */ ((await Promise.all(runs)).filter(Boolean));
}
