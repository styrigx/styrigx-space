/**
 * 机场源节点处理（设计稿 v1.13 §4.2）：丢弃 → 去旧图标 → 加国旗 → 指纹 → 源内重名加 #n。纯函数，不碰库。
 * 文件源不走这里（上传前用户自己定义好）。
 *
 * 匹配规则：节点名小写后做子串匹配；只由 1–3 个英文字母组成的源词按整词匹配（前后不是英文字母或数字），
 * 免得 us 命中 russia。不用正则，源词原样当字面量。
 */

/** 指纹可选值（mihomo client-fingerprint）；none = 不加 */
export const FP_VALUES = Object.freeze(['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'none']);
export const FP_DEFAULT = 'chrome';

/* 去旧图标：节点名里任何位置的 emoji 一律去掉（国旗、Extended_Pictographic，连同肤色 / 零宽连接 / 变体选择符 / 键帽 / 旗帜标签），Gray 2026-11-14 02:48 定，无命令 */
const STRIP_RE = /(?:[\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}\u200D\uFE0E\uFE0F\u20E3])+/gu;
const SHORT_RE = /^[a-z]{1,3}$/;
const ALNUM = /[a-z0-9]/;

/** 源词规范化：去首尾空白、小写 @param {unknown} w @returns {string} */
export const normWord = (w) => (typeof w === 'string' ? w.trim().toLowerCase() : '');

/**
 * 节点名（已小写）里有没有这个源词
 * @param {string} name @param {string} word
 */
export function hasWord(name, word) {
  if (!word) return false;
  if (!SHORT_RE.test(word)) return name.indexOf(word) >= 0;
  let i = name.indexOf(word);
  while (i >= 0) {
    const a = i > 0 ? name[i - 1] : '';
    const b = name[i + word.length] || '';
    if (!ALNUM.test(a) && !ALNUM.test(b)) return true;
    i = name.indexOf(word, i + 1);
  }
  return false;
}

/** 去旧图标 @param {string} name */
export const stripIcons = (name) => name.replace(STRIP_RE, ' ').replace(/\s{2,}/g, ' ').trim();

/**
 * @typedef {{ drop: string[], flags: { word: string, flag: string }[], fp: string }} Rules
 * flags 按匹配顺序（pos）排好
 */

/**
 * 处理一个机场源的原始节点（不改入参）。
 * @param {any[]} proxies 原始节点（extractProxies 的结果）
 * @param {Rules} rules
 * @returns {{ proxies: any[], unmatched: string[], dropped: number }} unmatched：没加上国旗的节点原名
 */
export function processNodes(proxies, rules) {
  const out = [];
  const unmatched = [];
  let dropped = 0;
  const fp = rules.fp && rules.fp !== 'none' ? rules.fp : '';
  const seen = new Map();
  for (const p of proxies) {
    const raw = String(p.name || '');
    const low = raw.toLowerCase();
    if (rules.drop.some((w) => hasWord(low, w))) { dropped++; continue; }
    let name = stripIcons(raw) || raw;
    const lowS = name.toLowerCase();
    const hit = rules.flags.find((f) => hasWord(lowS, f.word));
    if (hit) name = hit.flag + ' ' + name;
    else unmatched.push(raw);
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = name + ' #' + n;
    const q = { ...p, name };
    if (fp) q['client-fingerprint'] = fp;
    out.push(q);
  }
  return { proxies: out, unmatched, dropped };
}

/**
 * 加这个丢弃词会多丢几个节点（加词时回显用；已被现有丢弃词丢掉的不算）
 * @param {any[]} proxies @param {string} word @param {string[]} [existing] 现有丢弃词
 */
export function countDropped(proxies, word, existing = []) {
  let n = 0;
  for (const p of proxies) {
    const low = String(p.name || '').toLowerCase();
    if (hasWord(low, word) && !existing.some((w) => hasWord(low, w))) n++;
  }
  return n;
}
