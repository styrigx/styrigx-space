-- D-3 a′「先验后发票」（偏离稿 v3.12 第 9 节，Gray 2026-11-15 22:50 选 a、22:53 开工）：跨 Worker sudo 的一次性票。
-- 发票：POST /api/identity action sudo-grant 验过 sudoers 本人的凭据后写一行（同时清掉已过期的行）；
-- 核销：atlas-core 经 space-core 转 AccountVerifier.sudoAdmit，一条 DELETE … WHERE … AND expires_at > ? RETURNING 原子作废。
-- 只存票的 SHA-256（十六进制），票本身不落库；票绑 uid + 会话 + 方法 + 路径 + action，TTL 60 秒。
-- 执行前须 Gray 批（章程 v2：新迁移执行前须批）。部署时 deploy-account-worker 先 d1 migrations apply，再上新代码。
CREATE TABLE IF NOT EXISTS account_sudo_tickets (
  id TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL
);
