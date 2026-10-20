-- 书签在线管理：分类、书签、导入标记（首次读取时从 links.yaml 导入，之后以库为准）。
-- 代码里也有 CREATE TABLE IF NOT EXISTS 兜底（functions/_kernel/bookmarks.js），此 migration 用于 wrangler d1 migrations apply。
CREATE TABLE IF NOT EXISTS bm_cat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_zh TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bm_link (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cat_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  name_zh TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  desc_zh TEXT NOT NULL DEFAULT '',
  desc_en TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bm_link_cat ON bm_link (cat_id, pos);
CREATE TABLE IF NOT EXISTS bm_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
