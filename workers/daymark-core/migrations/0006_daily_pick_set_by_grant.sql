-- 0006：daily_pick.set_by 的取值 'admin' → 'grant'（「设为今日」= 账号授权 daymark.write 手动设的；把 admin 这个词让给主站身份）。
--
-- set_by 没有 CHECK 约束，默认值是 'auto'（与 'admin' 无关），不用重建表，只改已存的行；
-- 只动 set_by = 'admin' 的行，day / quote_id / set_at 原样保留；重复跑结果不变。
-- 0005 留着不动（历史上 'owner' → 'admin'），全新库依次跑 0005 → 0006 也落到 'grant'。
UPDATE daily_pick SET set_by = 'grant' WHERE set_by = 'admin';
