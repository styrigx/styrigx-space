-- 音乐分层方案 v1.13（Gray 2026-11-13 02:17 开项）：单曲 / 专辑分类 + 歌手表。只加列、加表、回填，不删不改原有数据。
-- 合入 main 后部署流水线 `d1 migrations apply styrigx-curio-core --remote` 会在正式库执行这份——合并即执行，须 Gray 点头。
-- 代码兜底 src/api/_music.js MUSIC_SCHEMA 同步（全新库直接建成最终结构，测试核对两边一致）。

-- 1. 单曲 / 专辑：单曲 = 只含一首曲的 kind='single' 记录；现有记录全部默认 'album'
ALTER TABLE music_albums ADD COLUMN kind TEXT NOT NULL DEFAULT 'album' CHECK (kind IN ('album', 'single'));

-- 2. 歌手表：名字唯一（按原文，区分大小写）；头像是 R2_MUSIC 的 key，空串表示没有
CREATE TABLE IF NOT EXISTS music_artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  avatar TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 3. 专辑、曲目指向歌手；0 = 没有歌手。原 music_albums.artist 文本保留当显示名
ALTER TABLE music_albums ADD COLUMN artist_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE music_tracks ADD COLUMN artist_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS music_albums_kind ON music_albums (kind, pos, id);
CREATE INDEX IF NOT EXISTS music_albums_artist ON music_albums (artist_id);
CREATE INDEX IF NOT EXISTS music_tracks_artist ON music_tracks (artist_id);

-- 4. 回填一次：按专辑的歌手文本（去首尾空白）去重建歌手；专辑挂上；曲目跟所属专辑
INSERT OR IGNORE INTO music_artists (name, created_at, updated_at)
  SELECT DISTINCT trim(artist), CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM music_albums WHERE trim(artist) <> '';
UPDATE music_albums
  SET artist_id = COALESCE((SELECT a.id FROM music_artists a WHERE a.name = trim(music_albums.artist)), 0)
  WHERE trim(artist) <> '';
UPDATE music_tracks
  SET artist_id = COALESCE((SELECT al.artist_id FROM music_albums al WHERE al.id = music_tracks.album_id), 0);
