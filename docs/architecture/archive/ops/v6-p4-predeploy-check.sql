-- v6 P4（定稿 v6-identity-final.md v5.3 §十三 P4 行）部署前只读核对。只有 SELECT，不改数据。
--
-- 账号库（styrigx-account）：
--   npx wrangler d1 execute styrigx-account --remote --file docs/ops/v6-p4-predeploy-check.sql
-- 站点核心库（styrigx-space-core）：同一文件对 styrigx-space-core 再跑一次；某条查询所在库没有那张表时会报 no such table，
-- 按下面分段单独 --command 执行即可。
--
-- 期望：
-- 1. pepper_id = 'space' 的行数 = 0。不为 0 时不要部署：P4 删了 SGX_SPACE_PASSWORD_PEPPER 绑定
--    （workers/account/src/core/identity-auth.js:5-7、workers/account/wrangler.toml:62），这些人的密码会验不过（fail closed）。
-- 2. 有效 share_link 数：仅供知悉，部署后这些链接打不开（/s/<码> 已删）。expires_at 是毫秒。
-- 3. account_epoch 行数：清理 SQL docs/ops/v6-p4-clear-old-account-sessions.sql 执行前后对照（前 2，后 0）。

-- [styrigx-account]
SELECT 'account_user_password pepper_id=space' AS item, COUNT(*) AS n FROM account_user_password WHERE pepper_id = 'space';

-- [styrigx-account]
SELECT 'account_epoch rows' AS item, COUNT(*) AS n FROM account_epoch;

-- [styrigx-space-core]
SELECT 'share_link active' AS item, COUNT(*) AS n FROM share_link
  WHERE revoked_at IS NULL AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000;
