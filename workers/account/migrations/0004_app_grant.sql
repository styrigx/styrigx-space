-- 2026-11-06 P3-1（第 3 件）：应用授权记录，放进账号库 D1 styrigx-account（绑定 D1_ACCOUNT_AUTH）。
-- Gray 2026-11-05 已书面批准（长期约束「不新增数据迁移」的例外；批准同时覆盖「这一次由 CI 自动 apply」）。
-- 一行一个应用（app = 作用域表 workers/account/src/core/scopes.js 的应用 id = 授权卡 id），取消授权 = DELETE 这一行。
-- 授权没有过期，不带 realm / revoked_at / expires_at，也不归 sweepExpired 管（设备清扫逻辑碰不到它）。
-- record 里 deviceId、by 只作审计和展示（授权时的设备、授权时账号会话的登录方式）。
-- 首次切换的种子（core/app-grant.js ensureSeed）：表空且 data_migration 没有 'app-grant-seed-1' 时，同一个 batch 写满全部应用 + 这条标记；
-- 之后用户取消到 0 行也不会再种。data_migration 表由 0003_account_auth.sql 建。
-- 全部 IF NOT EXISTS，重复跑不出错。正式库由账号部署 job 的 `d1 migrations apply styrigx-account --remote` 自动跑；
-- 预览由 CI「Apply D1 migrations to preview」跑（记录表 d1_migrations_account）。

CREATE TABLE IF NOT EXISTS app_grant (
  app TEXT PRIMARY KEY,        -- 应用 id：curio / daymark / prefs / wellbeing / avatar
  record TEXT NOT NULL,        -- JSON {"v":1,"scopes":["curio.write"],"deviceId":"<授权时的设备>","by":"passkey"}
  granted_at INTEGER NOT NULL  -- 授权时间（毫秒）
);
