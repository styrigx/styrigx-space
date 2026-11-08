-- 2026-11-08 账号命名 v2：账号的表改名 account_*，去掉 realm 列（同 share_*、status_* 的写法）。
-- 正式库 styrigx-account 由账号部署 job 的 `d1 migrations apply styrigx-account --remote` 跑；预览库 styrigx-test-preview 由 CI
-- 「Apply D1 migrations to preview」跑（记录表 d1_migrations_account）。一次性，Gray 2026-11-08 批准。
--
-- 旧表（epoch / password / passkey / user_handle / challenge / attempt_limit / device / audit）留着，只删 realm='account' 的行：
-- 预览库里网关的锁屏行（realm='lock'）也在这些表里，不能动。正式库里的空旧表等收尾（P4）再 DROP。
--
-- WebAuthn 红线：account_user_handle 的 handle / legacy_handle（= WebAuthn user.id）逐字节照抄；
-- account_passkey 的 record 原样复制（credId、publicKey、signCount、aaguid 不动），只把显示用的 provider / name 归一。
-- 账号密码不搬：pepper 换成账号独占的 SGX_ACCOUNT_PASSWORD_PEPPER（Gray 选的 Q2），旧哈希验不过，用恢复密钥重设一次。
-- session 纪元照抄旧 account 纪元：session 票格式、cookie、签名钥匙都没变，已登录的设备不掉线。reauth / reset 票作废一次（各 3 分钟）。
-- 全部 IF NOT EXISTS / OR IGNORE：兜底建表（lib/db.js ACCOUNT_SCHEMA）先建过表也不出错。

-- 纪元：session（照抄旧 account 纪元）、reset（从 0 开始）
CREATE TABLE IF NOT EXISTS account_epoch (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO account_epoch (name, value) SELECT 'session', value FROM epoch WHERE realm = 'account';
INSERT OR IGNORE INTO account_epoch (name, value) VALUES ('session', 0), ('reset', 0);

-- 账号密码：单行，不搬（见文件头）
CREATE TABLE IF NOT EXISTS account_password (id INTEGER PRIMARY KEY CHECK (id = 1), record TEXT NOT NULL);

-- 账号通行密钥：record 原样复制，只归一显示用的 provider / name
CREATE TABLE IF NOT EXISTS account_passkey (credential_id TEXT PRIMARY KEY, record TEXT NOT NULL);
INSERT OR IGNORE INTO account_passkey (credential_id, record) SELECT credential_id, record FROM passkey WHERE realm = 'account';
UPDATE account_passkey SET record = json_set(record, '$.provider', CASE json_extract(record, '$.provider')
  WHEN 'Samsung Pass' THEN 'samsung-pass' WHEN 'Google 密码管理器' THEN 'google-password-manager'
  WHEN 'Apple 密码' THEN 'apple-passwords' WHEN 'iCloud 钥匙串' THEN 'icloud-keychain'
  WHEN 'Microsoft 密码管理器' THEN 'microsoft-password-manager' WHEN 'Windows Hello' THEN 'windows-hello'
  WHEN '1Password' THEN '1password' WHEN 'Bitwarden' THEN 'bitwarden'
  ELSE json_extract(record, '$.provider') END)
  WHERE json_extract(record, '$.provider') IN ('Samsung Pass', 'Google 密码管理器', 'Apple 密码', 'iCloud 钥匙串', 'Microsoft 密码管理器', 'Windows Hello', '1Password', 'Bitwarden');
UPDATE account_passkey SET record = json_set(record, '$.name', '') WHERE json_extract(record, '$.name') IN
  ('通行密钥', 'Samsung Pass', 'Google 密码管理器', 'Apple 密码', 'iCloud 钥匙串', 'Microsoft 密码管理器', 'Windows Hello', '1Password', 'Bitwarden');

-- WebAuthn user handle：逐字节照抄（红线）
CREATE TABLE IF NOT EXISTS account_user_handle (id INTEGER PRIMARY KEY CHECK (id = 1), handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '');
INSERT OR IGNORE INTO account_user_handle (id, handle, legacy_handle) SELECT 1, handle, legacy_handle FROM user_handle WHERE realm = 'account';

-- 通行密钥 challenge：不搬（5 分钟就过期）；用途换成 session / reauth / keys-add / reset-add
CREATE TABLE IF NOT EXISTS account_challenge (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);

-- 输错计数：kind rootkey → recovery-key
CREATE TABLE IF NOT EXISTS account_attempt_limit (kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, PRIMARY KEY (kind, bucket));
INSERT OR IGNORE INTO account_attempt_limit (kind, bucket, count, strikes, locked_until, window_start, expires_at)
  SELECT CASE kind WHEN 'rootkey' THEN 'recovery-key' ELSE kind END, bucket, count, strikes, locked_until, window_start, expires_at
  FROM attempt_limit WHERE realm = 'account';

-- 已登录设备
CREATE TABLE IF NOT EXISTS account_device (device_id TEXT PRIMARY KEY, record TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
INSERT OR IGNORE INTO account_device (device_id, record, last_seen, revoked_at, expires_at)
  SELECT device_id, record, last_seen, revoked_at, expires_at FROM device WHERE realm = 'account';

-- 审计：path → event（事件名 = <接口>-<action>）；decoy / via 删；root-reauth 这类旧行不迁
CREATE TABLE IF NOT EXISTS account_audit (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, ip_prefix TEXT NOT NULL, ok INTEGER NOT NULL, event TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS account_audit_ts ON account_audit (ts);
INSERT OR IGNORE INTO account_audit (id, ts, ip_prefix, ok, event, expires_at)
  SELECT id, ts, ip_prefix, ok, CASE path
    WHEN 'root-reset' THEN 'reset-recovery-key'
    WHEN 'password-change' THEN 'keys-password-set'
    WHEN 'passkey-register' THEN 'keys-passkey-add'
    WHEN 'passkey-delete' THEN 'keys-passkey-delete'
    WHEN 'passkey-rename' THEN 'keys-passkey-rename'
    WHEN 'device-revoke' THEN 'devices-revoke'
    WHEN 'device-revoke-all' THEN 'devices-revoke-all'
    WHEN 'login-password-cooldown' THEN 'password-cooldown'
    WHEN 'reset-signout-all' THEN 'reset-finish-all'
    WHEN 'reset-signout-others' THEN 'reset-finish-others'
    WHEN 'reset-signout-none' THEN 'reset-finish-none'
  END, expires_at
  FROM audit WHERE realm = 'account' AND path IN ('root-reset', 'password-change', 'passkey-register', 'passkey-delete', 'passkey-rename',
    'device-revoke', 'device-revoke-all', 'login-password-cooldown', 'reset-signout-all', 'reset-signout-others', 'reset-signout-none');

-- 应用授权：先把旧种子逻辑的效果写成行（之后授权只看行，种子代码删了）——
-- 1) 已种过（有 app-grant-seed-1）但还没补种 profile（没有 app-grant-seed-2）：旧代码把 profile 算已授权，这里补上这一行
-- 2) 从没种过（没有 app-grant-seed-1、表也空）：旧代码把全部作用域算已授权，这里写满全部应用
INSERT OR IGNORE INTO app_grant (app, record, granted_at)
  SELECT 'profile', '{"v":1,"scopes":["profile.write"],"deviceId":"","by":""}', CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE EXISTS (SELECT 1 FROM data_migration WHERE name = 'app-grant-seed-1')
    AND NOT EXISTS (SELECT 1 FROM data_migration WHERE name = 'app-grant-seed-2');
INSERT OR IGNORE INTO app_grant (app, record, granted_at)
  SELECT column1, '{"v":1,"scopes":["' || column2 || '"],"deviceId":"","by":""}', CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM (VALUES ('curio', 'curio.write'), ('daymark', 'daymark.write'), ('prefs', 'prefs.sync'), ('wellbeing', 'wellbeing.write'),
    ('avatar', 'avatar.write'), ('profile', 'profile.write'))
  WHERE NOT EXISTS (SELECT 1 FROM data_migration WHERE name = 'app-grant-seed-1') AND NOT EXISTS (SELECT 1 FROM app_grant);
ALTER TABLE app_grant RENAME TO account_grant;
DROP TABLE IF EXISTS data_migration;

-- 旧表里账号的行删掉（表留着：预览库里还有网关的锁屏行）
DELETE FROM epoch WHERE realm = 'account';
DELETE FROM password WHERE realm = 'account';
DELETE FROM passkey WHERE realm = 'account';
DELETE FROM user_handle WHERE realm = 'account';
DELETE FROM challenge WHERE realm = 'account';
DELETE FROM attempt_limit WHERE realm = 'account';
DELETE FROM device WHERE realm = 'account';
DELETE FROM audit WHERE realm = 'account';
