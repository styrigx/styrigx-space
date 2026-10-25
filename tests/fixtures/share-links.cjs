/**
 * 账号 › 临时钥匙页的固定数据（visual 截图、share-link 截图用），时间都以 freezeTime 的 2026-10-09 12:00 +08:00 为准。
 * - KEYS：/api/lock-tempkey list 的临时钥匙
 * - LINKS：/api/share list 的分享短链（带会话·有人点开过 / 普通 / 已作废）
 */
const NOW = Date.parse('2026-10-09T12:00:00+08:00'); /* 和浏览器里 freezeTime 冻结的时刻一致 */
const H = 3600e3;
const KEYS = [
  { id: 'k000000000000001', name: '小明', createdAt: NOW - 2 * H, expiresAt: NOW + 6 * 24 * H + 22 * H },
];
const LINKS = [
  { id: 's000000000000001', name: '给小明看博客', to: '/blog/', session: 3 * 3600, createdAt: NOW - H, expiresAt: NOW + 23 * H,
    revokedAt: 0, status: 'active', opens: 2, lastOpenAt: NOW - 50 * 60e3, openFor: 3 * 3600, sessionLeft: 7800, path: '/s/Xq3vN8tKp2LmR7wYc5HdJa' },
  { id: 's000000000000002', name: '', to: '/', session: 0, createdAt: NOW - 3 * H, expiresAt: NOW + 3 * 24 * H - 3 * H,
    revokedAt: 0, status: 'active', opens: 0, lastOpenAt: 0, openFor: 0, sessionLeft: 0, path: '/s/Bv9TzQe4Wk1sNf6uYh2PrM' },
  { id: 's000000000000003', name: '旧链接', to: '/settings/', session: 86400, createdAt: NOW - 30 * H, expiresAt: NOW + 6 * 24 * H,
    revokedAt: NOW - 5 * H, status: 'revoked', opens: 1, lastOpenAt: NOW - 20 * H, openFor: 0, sessionLeft: 0 },
];
module.exports = { NOW, KEYS, LINKS };
