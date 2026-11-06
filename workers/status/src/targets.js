/**
 * @fileoverview 监测的地址（2026-10-22 定 5 个公开地址，book 已下线、muse-invite 已删；2026-10-28 加 search / chat 两个服务绑定；
 * P4-2 起 search / chat 退役，合成一项 ai，经服务绑定 AI_SERVICE 测 styrigx-ai）。
 *
 * 子站（博客 / 奇趣 / 日刻）合并 PR3（2026-11-03）起和主站同一个 Pages、同一条网关链路，在 styrigx.com/<站>/ 下，不单独测；
 * 旧图志域名那一项（测它的 301 过渡跳转）随跳转一起在 P4-3 PR-1 删除。
 * 主站首页本身就公开（锁屏页），直接测 /。
 * expect：正常的状态码。拿到别的码、超时或连不上都算这一次失败。
 *
 * binding（2026-10-28 加）：没有公开地址的 Worker（P4-2 起只有 styrigx-ai）走服务绑定测它自己的 GET /healthz，
 * 不经网关、不开免会话口子；url 只是给绑定的请求地址（主机名随便，Worker 只看路径），页面上显示成 Worker 名。
 * 绑定没配（本地 / 老配置）→ 这一次记 err = 'binding'。
 */
export const TARGETS = [
  { site: 'space', zh: '主站', en: 'Home', url: 'https://styrigx.com/', expect: [200] },
  { site: 'proxy-rules', zh: '规则集', en: 'Proxy rules', url: 'https://proxy-rules.styrigx.com/healthz', expect: [200] },
  { site: 'ai', zh: 'AI 助手', en: 'AI', url: 'https://styrigx-ai/healthz', binding: 'AI_SERVICE', expect: [200] },
];

/** 单次检查超时 */
export const TIMEOUT_MS = 10 * 1000;
/** 连续失败几次开故障 */
export const FAIL_THRESHOLD = 3;
/** 原始记录保留 */
export const KEEP_MS = 7 * 24 * 3600 * 1000;
