-- 2026-11-11 v6 身份统一 P1：账号库 styrigx-account 里新增身份表（不新增 D1）。
-- 只建表、建索引，不放数据、不动任何旧表：P1 是分步割接，旧入口、旧会话、旧命令都不动，新路径并存。
-- 数据迁移（现账号凭据 → root、现进站凭据 → styrigx、默认组）不在这里：见 docs/specs/v6-identity-migration.md 与
-- space/scripts/v6-identity-migrate.mjs（只生成 SQL，不执行；P1 不对生产 D1 做任何数据写入）。
-- 表名带 account_ 前缀（命名 v2 的写法；预览库 styrigx-test-preview 是网关 / 账号共用的，裸名 audit 等会和网关旧表撞名）。
-- 与 src/lib/db.js ACCOUNT_SCHEMA 逐条一致（tests/workers/account/identity-schema.test.mjs 核对）。全部 IF NOT EXISTS，重复跑不出错。
-- 正式库由账号部署 job 的 `d1 migrations apply styrigx-account --remote` 跑（合并后建空表）；预览由 CI「Apply D1 migrations to preview」跑。

-- 用户：uid 0 = root，1000 = styrigx，1001 起普通用户（src/core/groups.js）。
-- avatar：头像在 KV_PROFILE 里的键前缀（'' = 默认头像；迁移时 styrigx = 'avatar:'，即现有的 avatar:* 文件）；expires_at：到期时间（UTC 毫秒，0 = 永久；useradd -e 的日期按 Asia/Shanghai 当日 00:00 起失效）；
-- epoch：凭据 / 组 / 期限任何变更 +1（src/core/users.js），会话里存快照，严格相等才有效；disabled：1 = 禁用（到期自动禁用、作废会话）。
CREATE TABLE IF NOT EXISTS account_users (uid INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, avatar TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);

-- 组成员：一行一个（uid, 组）。组名见 src/core/groups.js GROUPS（列名 grp：group 是 SQL 关键字）。
CREATE TABLE IF NOT EXISTS account_user_groups (uid INTEGER NOT NULL, grp TEXT NOT NULL, added_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, grp));

-- 密码：每用户一行；record = 现有格式的 JSON（salt、hash、iterations、peppered、updatedAt），哈希沿用加盐 + pepper。
-- pepper_id：这条哈希用的是哪把 pepper——'account' = SGX_ACCOUNT_PASSWORD_PEPPER（默认）、'space' = SGX_SPACE_PASSWORD_PEPPER（从进站密码迁来的 styrigx）。
-- 方案 a（未决，Hark 倾向）：登录成功时用账号 pepper 重算并改成 'account'，全部重算后 P4 删 space pepper。
-- must_change：1 = 一次性密码，首登强制改；expires_at：一次性密码到期（UTC 毫秒，0 = 不是一次性密码）。
CREATE TABLE IF NOT EXISTS account_user_password (uid INTEGER PRIMARY KEY, record TEXT NOT NULL, pepper_id TEXT NOT NULL DEFAULT 'account', must_change INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0);

-- 通行密钥：凭据 ID 全局唯一，挂在 uid 上；user_handle / legacy_handle = 这把钥匙可能注册时用的 WebAuthn user.id（逐字节照抄；
-- 验 userHandle 时两者任一相等都认，同现有 account_user_handle 的 handle / legacy_handle 规则；RP 不变）。
-- record = 现有格式的 JSON（name、provider、aaguid、createdAt、lastUsedAt、credId、publicKey、signCount、uv）。
CREATE TABLE IF NOT EXISTS account_user_passkey (credential_id TEXT PRIMARY KEY, uid INTEGER NOT NULL, user_handle TEXT NOT NULL, legacy_handle TEXT NOT NULL DEFAULT '', record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS account_user_passkey_uid ON account_user_passkey (uid);

-- 会话：id = 不透明会话令牌的 SHA-256（十六进制；库里不存令牌本身）；uid = 栈底身份；epoch = 签发时栈底用户的 epoch 快照；
-- rescue：1 = 救援会话（栈底就是 root、没有中间层、15 分钟、不续期）；renewed_at：上次滑动续期的时间（节流：每会话每天至多一次）。
CREATE TABLE IF NOT EXISTS account_sessions (id TEXT PRIMARY KEY, uid INTEGER NOT NULL, epoch INTEGER NOT NULL, rescue INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS account_sessions_uid ON account_sessions (uid);

-- 身份栈：挂在 account_sessions 下。栈底身份在 account_sessions 里（深度 0），这里只放 su 压上来的那一层（深度 1，只会是 root）：
-- 访客 → 普通用户 → root，最多三层（CHECK 写死）。sudo 不压栈。epoch = 压栈时这一层用户的 epoch 快照；expires_at = 这一层的硬上限（root ≤ 1 小时）。
CREATE TABLE IF NOT EXISTS account_session_stack (session_id TEXT NOT NULL, depth INTEGER NOT NULL CHECK (depth = 1), uid INTEGER NOT NULL, epoch INTEGER NOT NULL, pushed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (session_id, depth));

-- 审计（只追加，保留 90 天）：uid = 做事的身份（登录失败时可能为 NULL）、command = 命令（useradd / su / sudo / 救援 / 登录失败……）、ok、IP 前缀。
CREATE TABLE IF NOT EXISTS account_user_audit (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, uid INTEGER, command TEXT NOT NULL, ok INTEGER NOT NULL, ip_prefix TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS account_user_audit_ts ON account_user_audit (ts);

-- 恢复钥匙（一把，只管 root；不再用 Worker Secret）：record = 加盐 + pepper 的哈希 JSON（同 account_user_password 的格式）；
-- used_at：用过的时间（0 = 还有效；用一次就作废，终端强制生成新钥匙）。同一时刻最多一把有效（部分唯一索引）。
-- P1 只建表：不写生产、不生成钥匙值（P3 由 Gray 在终端生成）。
CREATE TABLE IF NOT EXISTS account_recovery_key (id TEXT PRIMARY KEY, record TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS account_recovery_key_active ON account_recovery_key (used_at) WHERE used_at = 0;
