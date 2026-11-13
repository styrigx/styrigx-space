/**
 * @fileoverview 虚拟目录树（终端统一 T6，设计稿 v1.5 §8.3）。路径写成 '~'、'blog'、'daymark/today'；只读、不跨站。
 * ~ 下：三个子站的目录 + account（账号卡片，S9 起没有层）+ proxy（代理订阅 P2：ls 列来源、open 进代理订阅）。v5 S5：盾牌没有窗口了，shield/ 删掉。
 */

/** 三个子站的目录（cd 的头一行、help 的 cd 那一行；同 NAVIGATE 02–04。旷野 2026-11-12 删除，状态页 /status/ 不是目录） */
export const DIRS = ['blog', 'curio', 'daymark'];

/** 目录 → 里面的东西（目录带 /）；不在表里的目录是空的 */
const TREE = /** @type {Record<string, string[]>} */ ({
  '~': ['blog/', 'curio/', 'daymark/', 'account/', 'proxy/'],
  daymark: ['today'],
});

/** @param {string} p @returns {[string, string]} [父目录, 名字] */
function split(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['~', p] : [p.slice(0, i), p.slice(i + 1)];
}
/** @param {string} p */
function kindOf(p) {
  if (p === '~') return 'dir';
  const s = split(p);
  const kids = TREE[s[0]] || [];
  if (kids.indexOf(s[1] + '/') >= 0) return 'dir';
  if (kids.indexOf(s[1]) >= 0) return 'file';
  return '';
}

/**
 * 参数 → 路径和类型；不存在 → null。相对路径先在当前目录下找，找不到再从 ~ 找（不以 ./ ../ 开头时）
 * @param {string} cwd @param {string} [arg] @returns {{path: string, dir: boolean} | null}
 */
export function resolvePath(cwd, arg) {
  const r = walk(cwd, arg);
  if (r || !cwd || cwd === '~') return r;
  /* 相对路径在当前目录下找不到：再从 ~ 找一次（站内终端的习惯：在 ~/blog 里 cd curio 也能去奇趣） */
  const a = String(arg == null ? '' : arg).trim();
  return /^\.{1,2}(\/|$)/.test(a) ? null : walk('~', a);
}

/** @param {string} cwd @param {string} [arg] @returns {{path: string, dir: boolean} | null} */
function walk(cwd, arg) {
  let a = String(arg == null ? '' : arg).trim().toLowerCase();
  if (!a || a === '~' || a === '/' || a === '~/') return { path: '~', dir: true };
  /** @type {string[]} */
  let parts;
  if (a.indexOf('~/') === 0 || a.charAt(0) === '/') { parts = []; a = a.replace(/^~?\/+/, ''); } else parts = !cwd || cwd === '~' ? [] : cwd.split('/');
  const segs = a.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || s === '.') continue;
    if (s === '..') { parts.pop(); continue; }
    parts.push(s);
    const k = kindOf(parts.join('/'));
    if (!k) return null;
    if (k === 'file' && segs.slice(i + 1).some(function (x) { return x && x !== '.'; })) return null;
  }
  const p = parts.length ? parts.join('/') : '~';
  return { path: p, dir: kindOf(p) === 'dir' };
}

/**
 * cd 的参数 → 目标目录（'~'、'blog'、'daymark/today' …）；不存在或是文件 → null
 * @param {string} cwd @param {string} [arg] @returns {string|null}
 */
export function normDir(cwd, arg) {
  const r = resolvePath(cwd, arg);
  return r && r.dir ? r.path : null;
}

/** 目录里的东西（目录带 /） @param {string} p */
export function listDir(p) {
  return (TREE[p] || []).slice();
}

/** 第一段（'daymark/today' → 'daymark'） @param {string} p */
export function top(p) {
  return p === '~' ? '~' : p.split('/')[0];
}
