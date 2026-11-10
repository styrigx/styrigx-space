-- v5 收尾（2026-11-10）：删临时钥匙的存储。v5 S1（#382）起没有代码读写 tempkey 表和 share_link.key_id 列，
-- /api/lock-tempkey* 已删，by=tempkey 的旧票不认；分享链接的会话按 share_link 这一行签（by=link）。
-- 库 styrigx-space-core（绑定 D1_SPACE，记录表 d1_migrations_core）；预览库 styrigx-test-preview 同一份（space/web/wrangler.toml [env.preview]）。
-- 只跑一次（d1_migrations_core 记录）；DROP ... IF EXISTS、DELETE 重复跑也不出错，DROP COLUMN 不能重复跑。DROP COLUMN 要求列不在索引、主键、UNIQUE、约束里：key_id 只是 NOT NULL DEFAULT ''，
-- share_link 只有 created_at 上的索引 share_link_created，不用重建表。
-- 部署顺序（deploy.yml deploy-space-core）：先跑本迁移、再部署新代码。两步之间的几十秒里，旧代码新建分享链接（INSERT 带 key_id）会 503，
-- 其余读写不受影响（旧代码已不碰 tempkey 表）。

-- 临时钥匙表和它的唯一索引（先删索引，再删表；删表本身也会带走索引）。
DROP INDEX IF EXISTS tempkey_code;
DROP TABLE IF EXISTS tempkey;

-- 分享链接不再记短链钥匙 id。
ALTER TABLE share_link DROP COLUMN key_id;

-- 临时码的输错计数（kind='tempkey'）：S1 起没人写，清掉残留行。
DELETE FROM attempt_limit WHERE kind = 'tempkey';
