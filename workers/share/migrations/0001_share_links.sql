-- 分享短链（2026-10-24）：D1 styrigx-share（分享短链 Worker styrigx-share，workers/share）。
-- share_link：一条短链一行。code = /s/<码> 里的 22 位码（只有站长能经 /api/share 读到）；
--   session_sec = 0 普通短链，> 0 带临时会话（key_id = 网关签的短链钥匙 id，钥匙和会话只在网关）；
--   revoked_at 非空 = 已作废；opens / last_open_at = 被打开的次数和最近一次（算访客会话还剩多久）。
--   过期 / 作废 7 天后在列表接口里顺手删掉。
-- share_fail：/s/<码> 打不开的计数（按 IP；10 次锁 15 分钟）。
CREATE TABLE IF NOT EXISTS share_link (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '/',
  session_sec INTEGER NOT NULL DEFAULT 0,
  key_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  opens INTEGER NOT NULL DEFAULT 0,
  last_open_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_link_created ON share_link (created_at);
CREATE TABLE IF NOT EXISTS share_fail (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
