/**
 * fetch 错误五分支映射（批次 B #36）：纯函数，无 DOM，可单元测试。
 *
 * 五分支：
 * - fetch 抛错（网络）→ 「网络连接失败，请重试」
 * - 响应非 JSON（解析失败）→ 「服务响应异常，请重试」
 * - 服务端 5xx → 「服务暂时不可用，请稍后重试」
 * - challenge 下发失败 → 「验证初始化失败」
 * - 429 / 密码错误等业务错 → 保持现有具体文案（本函数返回 null，调用方用原有文案）
 *
 * @param {{kind?:string, status?:number}} input
 *   kind: 'network' | 'parse' | 'http' | 'challenge' | 其他（业务错）
 *   status: kind='http' 时的 HTTP 状态码
 * @param {{network:string, parse:string, server:string, challenge:string}} texts
 *   调用方传入的本地化文案（中英由调用方按 t() 取）
 * @returns {string|null} 映射后的文案；null 表示保持调用方原有具体文案
 */
export function mapFetchError(input, texts) {
  const kind = (input && input.kind) || '';
  if (kind === 'network') return texts.network;
  if (kind === 'parse') return texts.parse;
  if (kind === 'challenge') return texts.challenge;
  if (kind === 'http') {
    const status = input.status || 0;
    if (status >= 500) return texts.server;
    return null;
  }
  return null;
}
