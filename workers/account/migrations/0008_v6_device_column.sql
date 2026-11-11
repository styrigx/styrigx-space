-- v6 2g：account_sessions 加可空设备列（定稿 v6-identity-final.md v5.5 §十一「sessions……2g 加可空设备列，su 时发长期设备标记写入，
-- 老会话留空不回填」；「设备标记 cookie 名 sgx-device、有效期 400 天，设备列表按它合并同一台设备的会话」，Gray 2026-11-11 17:49、19:59）。
-- 部署时 deploy-account-worker 先 d1 migrations apply，再上新代码；代码只认有这一列的表结构。
-- 老会话留空（NULL），不回填。不加索引：设备列表一次读全站未过期会话（几十行），按设备归并在代码里做。
ALTER TABLE account_sessions ADD COLUMN device TEXT;
