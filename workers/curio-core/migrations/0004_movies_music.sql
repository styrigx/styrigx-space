-- 奇趣拆页（P4-3）：电影收藏、私人音乐（数字专辑）三张表 + 播放令牌表。同一个库 styrigx-curio-core（绑定 D1_MOVIES / D1_MUSIC）。
-- 代码里也有 CREATE TABLE IF NOT EXISTS 兜底（src/api/_movies.js 的 MOVIE_SCHEMA、src/api/_music.js 的 MUSIC_SCHEMA，两边要一致，测试核对）。
-- 海报在 R2 R2_PHOTOS（photos/movie/<id>-<时间>.<扩展名>，同设备照片的清扫规则）；音频和专辑封面在 R2 R2_MUSIC（music/<专辑 id>/…，不清扫）。
-- 日期 'YYYY-MM-DD' 文本，空串表示没填。
CREATE TABLE IF NOT EXISTS movies (
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
CREATE TABLE IF NOT EXISTS music_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  year INTEGER NOT NULL DEFAULT 0,
  cover TEXT NOT NULL DEFAULT '',
  pos INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS music_tracks (
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
);
CREATE INDEX IF NOT EXISTS music_tracks_album ON music_tracks (album_id, no, id);
CREATE TABLE IF NOT EXISTS music_tokens (
  token TEXT PRIMARY KEY,
  album_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS music_tokens_exp ON music_tokens (expires_at);
