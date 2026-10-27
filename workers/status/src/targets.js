/**
 * @fileoverview 监测的地址（2026-10-22 定 5 个公开地址，book 已下线、muse-invite 已删；2026-10-28 加 search / chat 两个服务绑定）。
 *
 * 子站没会话时页面会 302 去主站锁屏，测不出站本身；所以子站测 /robots.txt（公开、走同一条网关 → Pages 链路）。
 * 主站首页本身就公开（锁屏页），直接测 /。
 * expect：正常的状态码。拿到别的码、超时或连不上都算这一次失败。
 *
 * binding（2026-10-28 加）：没有公开地址的 Worker（search-index / chat）走服务绑定测它自己的 GET /healthz，
 * 不经网关、不开免会话口子；url 只是给绑定的请求地址（主机名随便，Worker 只看路径），页面上显示成 Worker 名。
 * 绑定没配（本地 / 老配置）→ 这一次记 err = 'binding'。
 */
export const TARGETS = [
  { site: 'space', zh: '主站', en: 'Home', url: 'https://styrigx.com/', expect: [200] },
  { site: 'blog', zh: '博客', en: 'Blog', url: 'https://blog.styrigx.com/robots.txt', expect: [200] },
  { site: 'daymark', zh: '日刻', en: 'Daymark', url: 'https://daymark.styrigx.com/robots.txt', expect: [200] },
  { site: 'curio', zh: '奇趣', en: 'Curio', url: 'https://curio.styrigx.com/robots.txt', expect: [200] },
  { site: 'proxy-rules', zh: '规则集', en: 'Proxy rules', url: 'https://proxy-rules.styrigx.com/healthz', expect: [200] },
  { site: 'search', zh: '站内搜索', en: 'Search', url: 'https://styrigx-search-index/healthz', binding: 'SEARCH', expect: [200] },
  { site: 'chat', zh: '聊天', en: 'Chat', url: 'https://styrigx-chat/healthz', binding: 'CHAT', expect: [200] },
];

/** 单次检查超时 */
export const TIMEOUT_MS = 10 * 1000;
/** 连续失败几次开故障 */
export const FAIL_THRESHOLD = 3;
/** 原始记录保留 */
export const KEEP_MS = 7 * 24 * 3600 * 1000;
