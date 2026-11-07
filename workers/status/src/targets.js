/**
 * @fileoverview 监测的地址：主站、规则集、AI 助手（P4-2 起经服务绑定 AI_SERVICE 测 styrigx-ai）。
 *
 * 子站（博客 / 奇趣 / 日刻）合并 PR3（2026-11-03）起和主站同一个 Pages、同一条网关链路，在 styrigx.com/<站>/ 下，不单独测。
 * 退役的 blog / curio / daymark / atlas / book / muse-invite / search / chat 的历史数据由 migrations-archive/0005_retire_sites.sql 删除（2026-11 合库前在旧库 styrigx-status 里跑过）；
 * 改这里的站点列表时同步那条迁移的思路（新退役的站另写一条迁移清数据）。
 * 主站首页本身就公开（锁屏页），直接测 /。
 * expect：正常的状态码。拿到别的码、超时或连不上都算这一次失败。
 *
 * binding（2026-10-28 加）：没有公开地址的 Worker（P4-2 起只有 styrigx-ai）走服务绑定测它自己的 GET /healthz，
 * 不经网关、不开免会话口子；url 只是给绑定的请求地址（主机名随便，Worker 只看路径），页面上显示成 Worker 名。
 * 绑定没配（本地 / 老配置）→ 这一次记 err = 'binding'。
 *
 * name：站名的英文原文（语言包化第二部分 2026-11-07：英文是源，接口只回英文）。页面按字符串表 js.status.site_<site> 显示当前语言，
 * 表里没有的站回退这里的英文名；加站时在 space/web/data/i18n/{en,zh}.yaml 的 js.status 补 site_<site>。
 */
export const TARGETS = [
  { site: 'space', name: 'Home', url: 'https://styrigx.com/', expect: [200] },
  { site: 'proxy-rules', name: 'Proxy rules', url: 'https://proxy-rules.styrigx.com/healthz', expect: [200] },
  { site: 'ai', name: 'AI', url: 'https://styrigx-ai/healthz', binding: 'AI_SERVICE', expect: [200] },
];

/** 单次检查超时 */
export const TIMEOUT_MS = 10 * 1000;
/** 连续失败几次开故障 */
export const FAIL_THRESHOLD = 3;
/** 原始记录保留 */
export const KEEP_MS = 7 * 24 * 3600 * 1000;
