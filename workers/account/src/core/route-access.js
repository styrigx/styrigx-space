/**
 * v6 身份统一（P1）：全站路由访问表——每条路由要哪一档（core/groups.js ACCESS_LEVELS：public / user / 组名 / root）。
 *
 * 规则：
 * 1. 只认表里逐条写出的「主机 + 方法 + 路径」；不在表里的接口一律拒绝（fail closed）。页面和静态文件（不在 /api/、/<子站>/api/ 下）
 *    一律 public，不进表（同 v5 S3：整站放开）。
 * 2. 路径参数只有两种，各自精确一段：/s/:token/:source（代理订阅，两段，主机 proxy-rules.styrigx.com）、/avatar/:file。
 *    （/s/:code 分享短链一段的那条 v6 P4 删除，两段的代理订阅不受影响。）
 * 3. 一条路由下有多个 action / op 的（POST { action }），level 是进这个接口的最低一档；某个 action 要更高的档写在 actions 里，
 *    由接口在读完 body 后按同一张表判断（levelOf(method, path, { action })）。网关 admit 只看路由这一档。
 * 4. 删除两级（定稿 §十一、Muse 复盘 4）：单条内容删除（del: 'item'）归写组；批量 / 结构删除（del: 'bulk'）只属 root。
 * 5. 原来要再验证（reauth / sudo -v / sudo root reauth，即 STEPUP 的继任者）的操作，v6 一律改成 sudo 每次重验 = root 档。
 * 6. retire：v6 割接后要删的旧入口（P3 / P4）；它们在 P1–P3 照旧按老规则跑（旧会话判定不变），这里写的是新会话的档。
 * 7. decided：盘点时拿不准、由 Gray 定稿的条目（2026-11-11；docs/specs/v6-route-inventory.md「已定」汇总）。
 * 8. rescue：救援会话能走的路由（白名单）。一条路由有多个 action 时，rescueActions 列出救援能用的那几个（没列 = 整条都能用）；
 *    判断用 rescueOf(method, path, { action })，结果交给 permits 的 opts.rescue（P2，定稿 v4 §三 / §九）。
 * 9. webmaster：站长档（= styrigx 的 uid；名片属于站长），root 由 permits 第 2 步放行（P2）。
 * 10. private（割接）：公开读接口里的私密行与 canWrite 提示——GET 路由档是 public（谁都能读公开部分），actions.private 是能看私密行的那一档
 *    （= 对应的写组）；子站接口 Worker 读完路由后按 action 'private' 问 admit（同一张表、同一个 permits），不自己比组。
 *    2c：POST /api/ai 也挂 private（= webmaster：站长 styrigx + root）——AI 回答召回私密条目、能切模型（GET /api/ai 的 canChoose 问同一条）；
 *    跨奇趣 / 日刻 / 博客的私密内容，对应旧「账号会话」（= 站长本人），不按某一个写组。
 *
 * 判断不在这里：这张表只回答「要哪一档」，够不够由 core/groups.js permits() 判断（全站唯一一处）。
 * 没有公开地址、只经服务绑定 / RPC 进来的入口不进表，列在 SERVICE_ONLY（盘点用）。
 *
 * 只 import core/groups.js。
 */
import { ACCESS_LEVELS } from './groups.js';

/** 主站主机（网关、账号转发、子站接口 Worker 都在这里） */
export const MAIN_HOST = 'styrigx.com';
/** 代理订阅 / 规则集的主机（styrigx-proxy-rules 的自定义域名，不经网关） */
export const PROXY_HOST = 'proxy-rules.styrigx.com';

/**
 * @typedef {{ host?: string, method: string, path: string, level: string, worker: string, why: string,
 *   actions?: Readonly<Record<string, string>>, rescue?: boolean, rescueActions?: ReadonlyArray<string>, del?: 'item'|'bulk', retire?: string, decided?: string }} RouteRule
 */

/** @param {RouteRule} r */
const R = (r) => Object.freeze(Object.assign({ host: MAIN_HOST }, r, r.actions ? { actions: Object.freeze(r.actions) } : {},
  r.rescueActions ? { rescueActions: Object.freeze(r.rescueActions.slice()) } : {}));

/** @type {ReadonlyArray<Readonly<RouteRule>>} */
export const ROUTE_ACCESS = Object.freeze([
  /* ---------- 站点核心 styrigx-space-core 自己的接口（workers/space-core/src/router.js API_ROUTES） ---------- */
  R({ method: 'POST', path: '/api/ai', level: 'ai', worker: 'space-core', why: 'AI 对话（转 styrigx-ai /ask；私密召回与切模型只给 webmaster，见 actions.private）', actions: { private: 'webmaster' } }),
  R({ method: 'GET', path: '/api/ai', level: 'ai', worker: 'space-core', why: 'AI 可选模型列表（转 styrigx-ai /models）' }),
  R({ method: 'GET', path: '/api/find', level: 'public', worker: 'space-core', why: '关键词搜索，只回公开页面元数据（IP 限流）' }),
  R({ method: 'GET', path: '/api/geo', level: 'public', worker: 'space-core', why: '只回调用者自己的城市 / 时区' }),
  R({ method: 'GET', path: '/api/status', level: 'status', worker: 'space-core', why: '旷野状态卡 / 监测页（转 styrigx-status /summary）' }),
  R({ method: 'GET', path: '/api/space-audit', level: 'root', worker: 'space-core', why: '进站凭证使用审计（含 IP 前缀）' }),
  /* v6 P4（定稿 v5.2 §十三）：进站接口（lock-* / space-auth）与分享短链（/s/:code、/api/share）删除 */

  /* ---------- 账号 styrigx-account（网关 FORWARDING 转来；workers/account/src/router.js API_ROUTES） ---------- */
  R({ method: 'POST', path: '/api/identity', level: 'public', worker: 'account', why: 'v6 身份命令（P2）：whoami / su / sudo / exit / lock / passwd / passkey / groups / who / useradd / userdel / usermod / passwd <名>；P3 救援入口 rescue；每个 action 一档',
    actions: {
      whoami: 'public', 'su-challenge': 'public', su: 'public', exit: 'public', idle: 'public', lock: 'public', rescue: 'public',
      /* 定稿 v5.5 §五：通行密钥增删与列表 webmaster（站长 + root）；普通用户只能 passwd 改自己的密码（§八） */
      passwd: 'user', 'passkey-list': 'webmaster', 'passkey-add-challenge': 'webmaster', 'passkey-add': 'webmaster', 'passkey-delete': 'webmaster', groups: 'user', who: 'user',
      'sudo-challenge': 'sudoers', sudo: 'sudoers',
      useradd: 'root', userdel: 'root', usermod: 'root', 'passwd-user': 'root',
    },
    rescue: true, rescueActions: ['whoami', 'exit', 'lock', 'passwd', 'passkey-list', 'passkey-add-challenge', 'passkey-add', 'passkey-delete', 'groups'] }),
  /* v6 P4：旧账号会话（GET /api/account、/session、/reauth、/reset、/keys）删除 */
  R({ method: 'POST', path: '/api/account/devices', level: 'webmaster', worker: 'account', why: '设备会话（全站视图：列出全站会话，2g 按 sgx-device 合并同一台设备）',
    actions: { list: 'webmaster', revoke: 'root', 'revoke-all': 'root' },
    decided: '定稿 v5.5 §五：设备会话的列表与踢出属后台控制，root 档（站长 sudo），列表为全站视图；§七：站长打开账号页时设备卡列表直接可读，只有改动才预填 sudo（Gray 2026-11-11 19:59）→ list webmaster、revoke / revoke-all root' }),
  R({ method: 'POST', path: '/api/account/proxy', level: 'root', worker: 'account', why: '代理订阅管理 sub（转 styrigx-proxy-rules ProxyAdmin；含令牌、age 公钥）',
    actions: { status: 'root', show: 'root', token: 'root', key: 'root', add: 'root', mv: 'root', on: 'root', off: 'root', upload: 'root', rm: 'root' },
    decided: 'Gray 2026-11-11 定 root，不加新组' }),
  R({ method: 'PUT', path: '/api/avatar', level: 'webmaster', worker: 'account', why: '换站点头像（全站一份配置，归站长 styrigx）', decided: '定稿 v5.5 §五：avatar、prefs 写入 webmaster（站长 + root）；§七：全站只有一份配置（Gray 2026-11-11 18:10–18:39）' }),
  R({ method: 'DELETE', path: '/api/avatar', level: 'webmaster', worker: 'account', why: '删站点头像（回默认）', del: 'item', decided: '定稿 v5.5 §五：同上' }),
  R({ method: 'GET', path: '/avatar/:file', level: 'public', worker: 'account', why: '头像图片（页面路径）' }),
  R({ method: 'GET', path: '/api/profile', level: 'public', worker: 'account', why: '站点个人资料（公开数据）', decided: 'Gray 2026-11-11 定 public：资料是公开数据（KV_PROFILE 只放公开数据）' }),
  R({ method: 'PUT', path: '/api/profile', level: 'webmaster', worker: 'account', why: '改站点个人资料（站长资料，不是每个用户一份）',
    decided: 'Gray 2026-11-11 定稿 v4：站长（styrigx）+ root（root 由 permits 放行），其余一律拒；名片只有一份，属于站长' }),
  R({ method: 'GET', path: '/api/prefs', level: 'user', worker: 'account', why: '读设置云同步（全站一份配置，归站长 styrigx；普通用户只能看）', decided: '定稿 v5.5 §七：全站只有一份配置，普通用户只能看' }),
  R({ method: 'POST', path: '/api/prefs', level: 'webmaster', worker: 'account', why: '写设置云同步（全站一份配置）', decided: '定稿 v5.5 §五：avatar、prefs 写入 webmaster（站长 + root）' }),
  /* v6 P4：数字健康 POST / GET /api/wellbeing 随数字健康整套删除（定稿 v5.5 §四、§五） */

  /* ---------- 奇趣接口 styrigx-curio-core（styrigx.com/curio/api/*，不经网关；workers/curio-core/src/routes.js） ---------- */
  R({ method: 'GET', path: '/curio/api/items', level: 'public', worker: 'curio-core', why: '设备 / 游戏列表（私密行只给 curio-write，见 decided）', actions: { private: 'curio-write' }, decided: 'Gray 2026-11-11 定 public：私密行只给 curio-write' }),
  R({ method: 'POST', path: '/curio/api/items', level: 'curio-write', worker: 'curio-core', why: 'device.* / game.*：add / edit / order；del 是单条', del: 'item' }),
  R({ method: 'GET', path: '/curio/api/links', level: 'public', worker: 'curio-core', why: '收藏列表（私密行同上）', actions: { private: 'curio-write' }, decided: 'Gray 2026-11-11 定 public：私密行只给 curio-write' }),
  R({ method: 'POST', path: '/curio/api/links', level: 'curio-write', worker: 'curio-core', why: 'cat.* / link.*；link.del 单条；cat.del 只删空分类（非空 409），按单条算', del: 'item' }),
  R({ method: 'GET', path: '/curio/api/movies', level: 'public', worker: 'curio-core', why: '电影列表', actions: { private: 'curio-write' }, decided: 'Gray 2026-11-11 定 public：私密行只给 curio-write' }),
  R({ method: 'POST', path: '/curio/api/movies', level: 'curio-write', worker: 'curio-core', why: 'movie.add / edit / del（单条）', del: 'item' }),
  R({ method: 'GET', path: '/curio/api/photo', level: 'public', worker: 'curio-core', why: '设备照片 / 海报（私密设备的照片只给 curio-write）', actions: { private: 'curio-write' } }),
  R({ method: 'POST', path: '/curio/api/photo', level: 'curio-write', worker: 'curio-core', why: '上传照片 / 海报' }),
  R({ method: 'DELETE', path: '/curio/api/photo', level: 'curio-write', worker: 'curio-core', why: '删一张照片', del: 'item' }),
  R({ method: 'GET', path: '/curio/api/icon', level: 'public', worker: 'curio-core', why: '网站图标缓存（私密收藏的图标只给 curio-write）', actions: { private: 'curio-write' } }),
  R({ method: 'GET', path: '/curio/api/preview', level: 'curio-write', worker: 'curio-core', why: '添加收藏时抓标题 / 图标（算在写里）' }),
  R({ method: 'GET', path: '/curio/api/export', level: 'root', worker: 'curio-core', why: '导出全部收藏（含私密）', decided: 'Gray 2026-11-11 定 root：导出全部收藏含私密' }),
  R({ method: 'POST', path: '/curio/api/import', level: 'root', worker: 'curio-core', why: '批量导入书签（v5 要账号复验 → v6 sudo 每次重验 = root）' }),
  R({ method: 'GET', path: '/curio/api/music', level: 'public', worker: 'curio-core', why: '歌单（不含音频地址；canWrite 提示给 curio-write）', actions: { private: 'curio-write' } }),
  R({ method: 'POST', path: '/curio/api/music', level: 'curio-write', worker: 'curio-core', why: 'album.add / edit、track.edit / del（单条）；album.del 连曲目一起删 = 结构删除',
    actions: { 'album.add': 'curio-write', 'album.edit': 'curio-write', 'track.edit': 'curio-write', 'track.del': 'curio-write', 'album.del': 'root' }, del: 'item' }),
  R({ method: 'GET', path: '/curio/api/music-cover', level: 'public', worker: 'curio-core', why: '专辑封面' }),
  R({ method: 'POST', path: '/curio/api/music-play', level: 'listen', worker: 'curio-core', why: '签播放令牌（听歌）' }),
  R({ method: 'GET', path: '/curio/api/music-stream', level: 'listen', worker: 'curio-core', why: '取音频（令牌 + Range）' }),
  R({ method: 'HEAD', path: '/curio/api/music-stream', level: 'listen', worker: 'curio-core', why: '同上' }),
  R({ method: 'POST', path: '/curio/api/music-upload', level: 'curio-write', worker: 'curio-core', why: '上传音轨 / 封面' }),

  /* ---------- 日刻接口 styrigx-daymark-core（styrigx.com/daymark/api/*，不经网关；workers/daymark-core/src/routes.js） ---------- */
  R({ method: 'GET', path: '/daymark/api/today', level: 'public', worker: 'daymark-core', why: '今日一句（首页 / 锁屏跨站读）' }),
  R({ method: 'HEAD', path: '/daymark/api/today', level: 'public', worker: 'daymark-core', why: '同上' }),
  R({ method: 'OPTIONS', path: '/daymark/api/today', level: 'public', worker: 'daymark-core', why: 'CORS 预检' }),
  R({ method: 'PUT', path: '/daymark/api/today', level: 'daymark-write', worker: 'daymark-core', why: '设为今日' }),
  R({ method: 'GET', path: '/daymark/api/quotes', level: 'public', worker: 'daymark-core', why: '句子列表（私密句子只给 daymark-write，见 decided）', actions: { private: 'daymark-write' }, decided: 'Gray 2026-11-11 定 public：私密句子只给 daymark-write' }),
  R({ method: 'POST', path: '/daymark/api/quotes', level: 'daymark-write', worker: 'daymark-core', why: '新增句子' }),
  R({ method: 'PUT', path: '/daymark/api/quotes', level: 'daymark-write', worker: 'daymark-core', why: '改句子' }),
  R({ method: 'DELETE', path: '/daymark/api/quotes', level: 'daymark-write', worker: 'daymark-core', why: '删一句（日记条目）', del: 'item' }),
  R({ method: 'GET', path: '/daymark/api/collections', level: 'public', worker: 'daymark-core', why: '百味专题列表（含私密句子的部分只给 daymark-write）', actions: { private: 'daymark-write' } }),
  R({ method: 'POST', path: '/daymark/api/collections', level: 'daymark-write', worker: 'daymark-core', why: '新建专题' }),
  R({ method: 'PUT', path: '/daymark/api/collections', level: 'daymark-write', worker: 'daymark-core', why: '改专题 / 重排专题里的句子' }),
  R({ method: 'DELETE', path: '/daymark/api/collections', level: 'root', worker: 'daymark-core', why: '删整个专题（句子本身不删）= 结构删除', del: 'bulk',
    decided: 'Gray 2026-11-11 定 root：删整个专题 = 结构删除' }),
  R({ method: 'GET', path: '/daymark/api/days', level: 'public', worker: 'daymark-core', why: '按日浏览' }),

  /* ---------- 代理订阅 / 规则集 styrigx-proxy-rules（proxy-rules.styrigx.com，不经网关；workers/proxy-rules/src/router.js） ---------- */
  R({ host: PROXY_HOST, method: 'GET', path: '/s/:token/:source', level: 'public', worker: 'proxy-rules', why: '代理订阅下载：令牌 + age 密文就是凭证（两段，保留）' }),
  R({ host: PROXY_HOST, method: 'HEAD', path: '/s/:token/:source', level: 'public', worker: 'proxy-rules', why: '同上' }),
  R({ host: PROXY_HOST, method: 'GET', path: '/:rules', level: 'public', worker: 'proxy-rules', why: '规则集反代（core/sources.js 白名单里的来源路径）' }),
  R({ host: PROXY_HOST, method: 'HEAD', path: '/:rules', level: 'public', worker: 'proxy-rules', why: '同上' }),
  R({ host: PROXY_HOST, method: 'GET', path: '/healthz', level: 'public', worker: 'proxy-rules', why: '健康检查（任意方法 200；styrigx-status 每分钟测）' }),
  R({ host: PROXY_HOST, method: 'GET', path: '/', level: 'public', worker: 'proxy-rules', why: '同上' }),
]);

/**
 * 没有公开地址、只经服务绑定 / RPC 进来的入口（盘点用，不进访问表；它们的门在调用方）。
 * @type {ReadonlyArray<Readonly<{worker:string, entry:string, caller:string, why:string}>>}
 */
export const SERVICE_ONLY = Object.freeze([
  { worker: 'ai', entry: 'POST /ask', caller: 'space-core POST /api/ai（AI_SERVICE）', why: '回答本身；门在网关（ai 组）' },
  { worker: 'ai', entry: 'GET /find', caller: 'space-core GET /api/find', why: '关键词搜索（公开）' },
  { worker: 'ai', entry: 'GET /models', caller: 'space-core GET /api/ai', why: '模型列表（ai 组）' },
  { worker: 'ai', entry: 'GET /healthz', caller: 'styrigx-status 监测', why: '健康检查' },
  { worker: 'status', entry: 'GET /summary', caller: 'space-core GET /api/status（STATUS）', why: '监测数据（status 组）' },
  { worker: 'account', entry: 'AccountService.fetch', caller: 'space-core FORWARDING（ACCOUNT）', why: '上表 /api/account*、/api/avatar*、/api/profile、/api/prefs、/avatar/*' },
  { worker: 'account', entry: 'AccountVerifier.admit / auditRoot', caller: 'space-core（ACCOUNT_VERIFIER）', why: 'v6 会话判定（只读）/ root 特权操作留痕（v6 P4 起 authorize 删除）' },
  { worker: 'space-core', entry: 'SpaceVerifier.admit / auditRoot', caller: 'curio-core、daymark-core（SPACE）', why: 'admit / auditRoot 原样转给账号 Worker（v6 P4 起 session、ShareJanitor、conclusion 删除）' },
  { worker: 'account', entry: 'AccountJanitor.purgeExpiredUsers', caller: 'styrigx-status 每日一轮（JOB_ACCOUNT）', why: '到期满 30 天的用户自动删除（v6 P2c）' },
  { worker: 'proxy-rules', entry: 'ProxyAdmin.*', caller: 'account POST /api/account/proxy（PROXY）', why: '代理订阅管理（root 档在调用方）' },
  { worker: 'curio-core / daymark-core / ai', entry: 'HourlyJob.run', caller: 'styrigx-status 每小时一轮', why: '搜索索引 / 照片清理等定时任务' },
]);

/* ---------------- 查表 ---------------- */

/** 结尾一个 / 当同一条；不解码、不合并斜杠（对不上表 → 拒绝） @param {string} p */
function trimSlash(p) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * 实际路径 → 表里的规范路径（只认三种参数段，每段不含 /、不为空）。
 * @param {string} host @param {string} p 已 trimSlash
 */
function canonicalPath(host, p) {
  if (host === PROXY_HOST) {
    if (/^\/s\/[^/]+\/[^/]+$/.test(p)) return '/s/:token/:source';
    if (p === '/' || p === '/healthz') return p;
    return /^\/[^/]/.test(p) && !p.startsWith('/s/') ? '/:rules' : p;
  }
  if (/^\/avatar\/[^/]+$/.test(p)) return '/avatar/:file';
  return p;
}

const KEYS = new Map(ROUTE_ACCESS.map((r) => [r.host + ' ' + r.method + ' ' + r.path, r]));

/**
 * 这一请求对应的表行（没有 → null = 拒绝）。
 * @param {string} method @param {string} pathname @param {{host?: string}} [opts] 主机默认 styrigx.com
 * @returns {Readonly<RouteRule>|null}
 */
export function ruleOf(method, pathname, opts) {
  const host = (opts && opts.host) || MAIN_HOST;
  const m = String(method || 'GET').toUpperCase();
  const p = canonicalPath(host, trimSlash(String(pathname || '')));
  return KEYS.get(host + ' ' + m + ' ' + p) || null;
}

/**
 * 要哪一档；不在表里 → null（调用方当拒绝）。给了 action 且表里有它 → 那个 action 的档；action 不认识 → null（拒绝）。
 * @param {string} method @param {string} pathname @param {{host?: string, action?: string}} [opts]
 * @returns {string|null}
 */
export function levelOf(method, pathname, opts) {
  const r = ruleOf(method, pathname, opts);
  if (!r) return null;
  const a = opts && typeof opts.action === 'string' ? opts.action : null;
  if (a === null || !r.actions) return r.level;
  return Object.prototype.hasOwnProperty.call(r.actions, a) ? r.actions[a] : null;
}

/**
 * 救援会话能不能走这一请求（白名单，交给 permits 的 opts.rescue）：路由没标 rescue → false；标了且有 rescueActions →
 * 只有列出的 action（没给 action → false）；标了没有 rescueActions → 整条都行。
 * @param {string} method @param {string} pathname @param {{host?: string, action?: string}} [opts]
 * @returns {boolean}
 */
export function rescueOf(method, pathname, opts) {
  const r = ruleOf(method, pathname, opts);
  if (!r || r.rescue !== true) return false;
  if (!r.rescueActions) return true;
  const a = opts && typeof opts.action === 'string' ? opts.action : null;
  return a !== null && r.rescueActions.indexOf(a) !== -1;
}

/* 表本身的自检（模块加载时）：档都合法、没有重复键、rescueActions 是 actions 的子集——表写错就让 Worker 起不来，CI 单测第一时间红 */
for (const r of ROUTE_ACCESS) {
  const lv = [r.level].concat(r.actions ? Object.values(r.actions) : []);
  for (const l of lv) if (ACCESS_LEVELS.indexOf(l) === -1) throw new Error('route-access: bad level ' + l + ' for ' + r.method + ' ' + r.path);
  for (const a of r.rescueActions || []) {
    if (r.rescue !== true || !r.actions || !Object.prototype.hasOwnProperty.call(r.actions, a)) throw new Error('route-access: bad rescue action ' + a + ' for ' + r.path);
  }
}
if (KEYS.size !== ROUTE_ACCESS.length) throw new Error('route-access: duplicate rule');
