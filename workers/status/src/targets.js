/**
 * @fileoverview 监测的地址（2026-10-22 定：5 个，book 已下线、muse-invite 已删，不再监测）。
 *
 * 子站没会话时页面会 302 去主站锁屏，测不出站本身；所以子站测 /robots.txt（公开、走同一条网关 → Pages 链路）。
 * 主站首页本身就公开（锁屏页），直接测 /。
 * expect：正常的状态码。拿到别的码、超时或连不上都算这一次失败。
 */
export const TARGETS = [
  { site: 'space', zh: '主站', en: 'Home', url: 'https://styrigx.com/', expect: [200] },
  { site: 'blog', zh: '博客', en: 'Blog', url: 'https://blog.styrigx.com/robots.txt', expect: [200] },
  { site: 'daymark', zh: '日刻', en: 'Daymark', url: 'https://daymark.styrigx.com/robots.txt', expect: [200] },
  { site: 'curio', zh: '奇趣', en: 'Curio', url: 'https://curio.styrigx.com/robots.txt', expect: [200] },
  { site: 'proxy-rules', zh: '规则集', en: 'Proxy rules', url: 'https://proxy-rules.styrigx.com/healthz', expect: [200] },
];

/** 单次检查超时 */
export const TIMEOUT_MS = 10 * 1000;
/** 连续失败几次开故障 */
export const FAIL_THRESHOLD = 3;
/** 原始记录保留 */
export const KEEP_MS = 7 * 24 * 3600 * 1000;
