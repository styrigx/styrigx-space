-- 2026-10-27：锁屏 / 账号的纪元、通行密钥、密码从 KV 搬到 D1（D1 读强一致；KV 边缘读最长约 60 秒才看到新值）。
-- 库：styrigx-auth-gateway（正式）/ styrigx-auth-gateway-preview（预览）；绑定 D1_LOCK_AUTH / D1_ACCOUNT_AUTH / D1_ROOT_AUTH
-- （同一个库，每个绑定只读写自己 realm 的行；recovery_switch 也经 D1_LOCK_AUTH）。其余认证状态（challenge、限速、临时钥匙、设备、审计）在 0006_auth_state.sql。
-- 命名：表名是小写 snake_case 名词；每张表都有 realm 列（'lock' | 'account' | 'root'，= functions/_kernel/realms.js 的凭证域 id）。
-- 代码里有同样的 CREATE ... IF NOT EXISTS 兜底（functions/_kernel/d1-state.js SCHEMA，单测核对两边一致）：正式网关的部署 job 不跑迁移，
-- 第一次查询遇到「no such table」时由代码建表；预览由 CI「Apply D1 migrations to preview」跑本文件。全部幂等。
-- 上线前的 KV 旧值由 scripts/migrate-kv-to-d1.mjs 一次性写进来（运行时不读 KV）。

-- 纪元：realm = 'lock' | 'account'。只用 UPDATE ... SET value = value + 1 推进（原子，两次推进不会写出同一个值）。
CREATE TABLE IF NOT EXISTS epoch (
  realm TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- 通行密钥：realm = 'lock' | 'account'；record = 记录的 JSON（name、provider、aaguid、createdAt、lastUsedAt、credId、publicKey、signCount、uv）。
CREATE TABLE IF NOT EXISTS passkey (
  realm TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (realm, credential_id)
);

-- 密码：realm = 'lock' | 'account'；record = 记录的 JSON（salt、hash、iterations、peppered、updatedAt）。
CREATE TABLE IF NOT EXISTS password (
  realm TEXT PRIMARY KEY,
  record TEXT NOT NULL
);

-- KV → D1 一次性导入标记（scripts/migrate-kv-to-d1.mjs 写，运行时不读）：name = '<realm>-<内容>'，如 'lock-passkey'、'account-device'。
-- 有这一行 = 该项已导入过，再跑脚本跳过（导入后在 D1 里删掉的不会被再跑一次写回来）。
CREATE TABLE IF NOT EXISTS kv_migration (
  name TEXT PRIMARY KEY,
  migrated_at INTEGER NOT NULL
);
