/**
 * 代理订阅的常量（设计稿 v1.7）。
 */
export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_SOURCES = 20;
export const MAX_NODES = 800;             // 每源（v1.13：节点处理后 800 节点 × 上限词数约 9 ms）
export const MAX_BYTES = 2 * 1024 * 1024; // 机场下载、上传文件
export const FETCH_TIMEOUT_MS = 15000;
export const LOCK_MS = 60000;
export const UA_DEFAULT = '1.19.33';
export const UA_CHECK_MS = 24 * 3600 * 1000;
export const MAX_URL = 2048;
export const MAX_MAP_WORDS = 100;       // 映射词（设计稿 v1.13 §3）
export const MAX_DROP_WORDS = 50;       // 丢弃词
export const MAX_WORD = 32;             // 源词长度

/** 错误类别（只记类别，不记内容） */
export const ERR = Object.freeze({
  fetch: 'fetch',        // 网络 / 超时
  status: 'status',      // 非 2xx
  size: 'size',          // 超 2 MB
  format: 'format',      // 不是 YAML 或没有 proxies:
  empty: 'empty',        // proxies 为空
  tooMany: 'too-many',   // 超每源上限
  noKey: 'no-pubkey',
  config: 'config',
});
