-- 2026-10-29 账号拆分 PR2：账号鉴权状态的表，放进账号库 D1 styrigx-account（绑定 D1_ACCOUNT_AUTH；正式 03f60d23…，预览 styrigx-test-preview）。
-- 结构照搬网关 workers/auth-gateway/migrations/0005_lock_account_state.sql + 0006_auth_state.sql，逐列原样：
-- 每张表都保留 realm 列，本库里值固定 'account'（= workers/account/src/identity/realm.js 的 REALM_ACCOUNT.id），
-- 共享模块 workers/account/src/lib/ 的 d1-state / attempt-limit / passkey-verify / root-limit / root-audit 不改即可用。
-- 与网关的不同只有两处（方案第 9.1 节）：
--   user_handle 多一列 legacy_handle（默认 ''）：旧锁屏 handle，账号 Passkey 登录继续认它；
--   导入标记表叫 data_migration（scripts/migrate-account-auth.mjs 写），不叫 kv_migration；不建 tempkey（临时钥匙留在网关）。
-- 与本库已有的 wb_daily（0001）、settings_sync（0002）不重名。全部 IF NOT EXISTS，重复跑不出错。
-- 正式库由账号部署 job 的 `d1 migrations apply styrigx-account --remote` 自动跑；预览由 CI「Apply D1 migrations to preview」跑（记录表 d1_migrations_account）。

-- 纪元：一行 realm='account'。只用 UPDATE ... SET value = value + 1 推进（原子）。
CREATE TABLE IF NOT EXISTS epoch (
  realm TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- 账号密码：record = PBKDF2 记录的 JSON（salt、hash、iterations、peppered、updatedAt）。
CREATE TABLE IF NOT EXISTS password (
  realm TEXT PRIMARY KEY,
  record TEXT NOT NULL
);

-- 账号通行密钥：record = 记录的 JSON（name、provider、aaguid、createdAt、lastUsedAt、credId、publicKey、signCount、uv）。
CREATE TABLE IF NOT EXISTS passkey (
  realm TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (realm, credential_id)
);

-- WebAuthn user handle：第一次注册时生成，之后一直复用。
-- legacy_handle = 拆分前锁屏用的 handle（迁移脚本拷入；'' = 没有），账号 Passkey 登录时 userHandle 等于 handle 或 legacy_handle 都认。
CREATE TABLE IF NOT EXISTS user_handle (
  realm TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  legacy_handle TEXT NOT NULL DEFAULT ''
);

-- 一次性 challenge：purpose = login | register；5 分钟、单次（DELETE ... RETURNING 原子消费，过期的不认）。
CREATE TABLE IF NOT EXISTS challenge (
  realm TEXT NOT NULL,
  id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (realm, id)
);

-- 输错限速：kind = 'password' | 'rootkey'（账号根密钥 SGX_ACCOUNT_ROOT_KEY）；bucket = IP 分桶（IPv6 /64），全局窗口那一行 bucket = '*'。
-- 所有更新都是一条 INSERT ... ON CONFLICT DO UPDATE（原子）。
CREATE TABLE IF NOT EXISTS attempt_limit (
  realm TEXT NOT NULL,
  kind TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  strikes INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (realm, kind, bucket)
);

-- 已登录设备：record = 设备信息 JSON；revoked_at > 0 = 已单独退出（行留到 expires_at，期间这台的票一律拒）；400 天。
CREATE TABLE IF NOT EXISTS device (
  realm TEXT NOT NULL,
  device_id TEXT NOT NULL,
  record TEXT NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (realm, device_id)
);

-- 审计（只追加）：path = 事件名（root-reauth / root-reset 保留 7 天；安全事件 password-change 等保留 30 天）。按时间倒序查。
CREATE TABLE IF NOT EXISTS audit (
  realm TEXT NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip_prefix TEXT NOT NULL,
  ok INTEGER NOT NULL,
  decoy INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (realm, id)
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit (realm, ts);

-- 迁移脚本幂等标记（scripts/migrate-account-auth.mjs 写，运行时不读）：有这一行 = 该项已拷过，再跑跳过。
CREATE TABLE IF NOT EXISTS data_migration (
  name TEXT PRIMARY KEY,
  migrated_at INTEGER NOT NULL
);
