-- 0002_daymark.sql
-- Atlas（styrigx-atlas-core）表结构起点：日刻，等于 workers/daymark-core/migrations 0001+0002+0004+0005+0006 跑完后的结构（不含 0003 种子句子）
-- 只有结构，不含种子数据；线上数据由迁移脚本从旧库拷入（设计稿第 3 步）。
-- 已上线后不改名、不重新编号；之后的结构变更接着编号。

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  trans TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
, source_type TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '');

CREATE INDEX quotes_created ON quotes (created_at);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE collection_quotes (
  collection_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, quote_id)
);

CREATE INDEX collection_quotes_quote ON collection_quotes (quote_id);

CREATE TABLE daily_pick (
  day TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  set_by TEXT NOT NULL DEFAULT 'auto',
  set_at INTEGER NOT NULL DEFAULT 0
);

