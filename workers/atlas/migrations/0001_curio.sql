-- 0001_curio.sql
-- Atlas（styrigx-atlas）表结构起点：奇趣，等于 workers/curio-core/migrations 0001+0003+0004+0005 跑完后的结构（2026-11-14，main 9122f158）
-- 只有结构，不含种子数据；线上数据由迁移脚本从旧库拷入（设计稿第 3 步）。
-- 已上线后不改名、不重新编号；之后的结构变更接着编号。

CREATE TABLE cats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_zh TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cat_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  name_zh TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  desc_zh TEXT NOT NULL DEFAULT '',
  desc_en TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX links_cat ON links (cat_id, pos);

CREATE INDEX links_url ON links (url);

CREATE TABLE imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  cats_added INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  bought_at TEXT NOT NULL DEFAULT '',
  retired_at TEXT NOT NULL DEFAULT '',
  replaced_by INTEGER NOT NULL DEFAULT 0,
  os TEXT NOT NULL DEFAULT '',
  specs TEXT NOT NULL DEFAULT '',
  accessories TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  device_id INTEGER NOT NULL DEFAULT 0,
  edition TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'want',
  rating INTEGER NOT NULL DEFAULT 0,
  review TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX games_status ON games (status, pos);

CREATE TABLE movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  original_title TEXT NOT NULL DEFAULT '',
  year INTEGER NOT NULL DEFAULT 0,
  director TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL DEFAULT 0,
  review TEXT NOT NULL DEFAULT '',
  watched_at TEXT NOT NULL DEFAULT '',
  poster TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE music_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  year INTEGER NOT NULL DEFAULT 0,
  cover TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
, kind TEXT NOT NULL DEFAULT 'album' CHECK (kind IN ('album', 'single')), artist_id INTEGER NOT NULL DEFAULT 0);

CREATE TABLE music_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL,
  no INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  lrc TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
, artist_id INTEGER NOT NULL DEFAULT 0);

CREATE INDEX music_tracks_album ON music_tracks (album_id, no, id);

CREATE TABLE music_tokens (
  token TEXT PRIMARY KEY,
  album_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX music_tokens_exp ON music_tokens (expires_at);

CREATE TABLE music_artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  avatar TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX music_albums_kind ON music_albums (kind, pos, id);

CREATE INDEX music_albums_artist ON music_albums (artist_id);

CREATE INDEX music_tracks_artist ON music_tracks (artist_id);

