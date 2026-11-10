# migrations-pending（待批准的迁移，不自动执行）

这里的 SQL **不在** `wrangler.toml` 的 `migrations_dir`（`migrations/`）里：账号部署 job 的 `d1 migrations apply styrigx-account --remote`
和 CI 预览库都不会跑它们。生产执行要 Gray 批准（v6 定稿 v4 §十一）。

| 文件 | 内容 | 状态 |
|---|---|---|
| `0007_v6_uid_columns.sql` | settings_sync、wb_daily 加 uid 进主键（现有数据归 styrigx = 1000）；account_device 加 uid 列 | 待 Gray 批准（P2） |

执行步骤：记下 D1 Time Travel 时间点 → 把文件挪进 `migrations/`（文件名不变）开 PR → 合并后部署 job 执行。代码两种表结构都能跑
（`src/lib/uid-schema.js`），迁移后最多 60 秒自动切到按 uid 读写；单测 `tests/workers/account/v6-uid-data.test.mjs` 在内存库上把两种结构都跑一遍。
