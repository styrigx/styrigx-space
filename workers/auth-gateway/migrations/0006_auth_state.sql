-- 2026-10-27：网关其余认证状态从 KV 搬到 D1 styrigx-auth-gateway（同 0005：绑定 D1_LOCK_AUTH / D1_ACCOUNT_AUTH / D1_ROOT_AUTH，同一个库）。
-- 按访问模式放：单次使用的 challenge 用 DELETE ... RETURNING 原子消费；计数用原子 UPSERT（count = count + 1）；
-- 吊销（临时钥匙、设备）写完下一个请求就生效。KV 的 TTL 换成 expires_at 列（毫秒）：过期行读时一律不认，写入时顺手清掉。
-- 命名同 0005：小写 snake_case 名词，每张表都有 realm 列（'lock' | 'account' | 'root'）。
-- 代码兜底建表：functions/_kernel/d1-state.js SCHEMA（单测核对与本文件逐条一致）。全部幂等。

-- 通行密钥注册用的 WebAuthn user handle（每个 realm 一个，第一次注册时生成，之后一直复用）。
CREATE TABLE IF NOT EXISTS user_handle (
  realm TEXT PRIMARY KEY,
  handle TEXT NOT NULL
);

-- 一次性 challenge：realm + purpose（lock: register / auth / reset；account: login / register）。
-- 只经 DELETE ... WHERE realm = ? AND id = ? AND purpose = ? AND expires_at > now RETURNING 消费：并发两次只有一次拿到；过期的没清掉也不认。
CREATE TABLE IF NOT EXISTS challenge (
  realm TEXT NOT NULL,
  id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (realm, id)
);

-- 输错限速：realm = 'lock' | 'account' | 'root'；kind = 'password' | 'tempkey' | 'rootkey'；
-- bucket = IP 分桶（IPv6 /64），全局窗口那一行 bucket = '*'。
-- 单 IP 行：count（本轮连错）、strikes（已冷却轮数，只有密码用）、locked_until（冷却 / 锁定到期）；
-- 全局行：count + window_start（每小时窗口）。所有更新都是一条 INSERT ... ON CONFLICT DO UPDATE（原子）。
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

-- 临时 LockKey（realm = 'lock'）：code_hash = SHA-256(pepper|临时码)（短链钥匙 link = 1 时为 NULL）。
-- 作废 = revoked_at = now（行留到 expires_at，以前的 lock-tempkey-revoked:<id>）；验访客会话时查 revoked_at（D1 强一致，作废后下一个请求就进不来）。
CREATE TABLE IF NOT EXISTS tempkey (
  realm TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  code_hash TEXT,
  link INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (realm, id)
);
-- 临时码 → 钥匙（以前的 lock-tempkey-code:* 键）：唯一索引，NULL（短链钥匙）不参与。
CREATE UNIQUE INDEX IF NOT EXISTS tempkey_code ON tempkey (realm, code_hash);

-- 账号已登录设备（realm = 'account'）：record = 设备信息 JSON；revoked_at > 0 = 已单独退出（行留到 expires_at，期间这台的票一律拒）。
CREATE TABLE IF NOT EXISTS device (
  realm TEXT NOT NULL,
  device_id TEXT NOT NULL,
  record TEXT NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (realm, device_id)
);

-- 根凭证使用审计（realm = 'root'；只追加，保留 7 天）：按时间倒序查最近 50 条。
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
