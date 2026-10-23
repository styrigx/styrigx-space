-- 2026-10-24：主站书签 2026-10-21 下线（迁到子站 Curio），bm_* 三张表已经没有代码读写，删掉。
-- 0003_bookmarks.sql 是历史迁移，内容不动；新库按顺序跑完 0003 → 0004 后同样没有这三张表。
DROP INDEX IF EXISTS bm_link_cat;
DROP TABLE IF EXISTS bm_link;
DROP TABLE IF EXISTS bm_cat;
DROP TABLE IF EXISTS bm_meta;
