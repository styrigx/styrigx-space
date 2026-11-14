-- styrigx-proxy：代理订阅（设计稿 v1.7）。只绑 styrigx-proxy。
-- 明文只有：公钥、令牌哈希、UA、来源名 / 类型 / 开关 / 机场域名 / 节点数 / 时间 / 错误类别。
-- 机场链接、各源节点用 SGX_PROXY_DB_KEY（AES-256-GCM）加密；下载成品 armor 用手机的 age 公钥加密。

-- 单值配置：'pubkey' | 'token_hash' | 'ua' | 'ua_checked'
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 来源：一个机场或一份上传文件 = 一行 = 一条下载路径 /s/<令牌>/<name>
CREATE TABLE sources (
  id             TEXT PRIMARY KEY,               -- 随机 id（加密的附加数据用它，改名不影响解密）
  name           TEXT NOT NULL UNIQUE,           -- [A-Za-z0-9_-]{1,32}，进 URL
  type           TEXT NOT NULL CHECK (type IN ('airport', 'file')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  host           TEXT,                           -- 机场域名（明文，界面显示用）
  url_enc        TEXT,                           -- 机场完整链接，DB_KEY 加密
  last_nodes_enc TEXT,                           -- 上次好的节点（JSON），DB_KEY 加密
  node_count     INTEGER NOT NULL DEFAULT 0,
  last_ok_at     INTEGER,
  last_error     TEXT,                           -- 只记错误类别，不含链接或节点内容
  armor          TEXT NOT NULL DEFAULT '',       -- 下载成品：age 密文（空 = 还没有，下载 404）
  gen            INTEGER NOT NULL DEFAULT 0,     -- 成品生成时间（毫秒），只写更新的
  created_at     INTEGER NOT NULL
);

-- 刷新锁（单行）
CREATE TABLE lock (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  owner   TEXT,
  expires INTEGER NOT NULL DEFAULT 0
);
INSERT INTO lock (id, owner, expires) VALUES (1, NULL, 0);
