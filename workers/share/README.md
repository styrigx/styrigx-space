# styrigx-share

主站「分享短链」的后端（2026-10-24 新建，照账号 Worker `styrigx-account` 的拆法）：`https://styrigx.com/s/<码>`（中英文同一条）和管理接口 `/api/share`。

```
src/index.js        入口：/s/<码> → open.js；/api/share → api/share.js；X-SGX-Runtime: share
src/gate.js         门：只认 styrigx.com；/s/* 谁都能开；/api/share* 要进门（没会话 401）；create / revoke 另要锁侧复验（没有 401 reauth）
src/auth.js         会话：本 Worker 自己一份（只认进站会话，问网关 AuthVerifier / AUTH；不问账号会话）
src/open.js         打开短链：普通 → 302；带会话 → 请网关 ShareIssuer 签临时会话 → 302（去掉码）；失败统一 302 /?lock=1；限速
src/api/share.js    POST /api/share { list | create | revoke }（只认进站会话；只收同源，跨源一律 403，不回 CORS 头）
src/lib/links.js    规则（码、有效期、会话档位、目标：站内路径或 https://styrigx.com 的地址，一律存成相对路径）、复用查询和 D1 语句
migrations/         D1 styrigx-space-gateway 的 share_* 表：0001_baseline.sql（share_link、share_fail；迁移记录表 d1_migrations_share）
migrations-archive/ 旧库 styrigx-share 的迁移历史（0001_share_links、0002_drop_atlas_targets），只留史、不再跑
```

- 钥匙和会话：本 Worker 不持任何钥匙、不绑认证库。带会话的短链由网关签一把「短链钥匙」（临时 LockKey，link=true，没有临时码），
  点开时由网关签 临时钥匙进门的会话 + 钥匙票（和锁屏输临时码进门同一套代码，`workers/auth-gateway/src/rpc/share-issuer.js`），
  经服务绑定 `ISSUER`（entrypoint `ShareIssuer`，只有本 Worker 绑定）调用。
- 作废：带会话的短链先请网关作废钥匙（写作废标记），拿它进来的人下一个请求就进不来；再在 D1 记 revoked_at。
- 数据：D1 `styrigx-space-gateway`（主站共用库，2026-11 合库；表 `share_link`、`share_fail`，绑定 `D1_SHARE_LINK`，迁移记录表 `d1_migrations_share`；旧库 `styrigx-share` 的数据由 `.github/workflows/d1-cutover.yml` 一次性搬来）；预览 D1 是所有 Worker 的预览共用的测试库 `styrigx-test-preview`，登记在 `[env.preview]`（迁移记录表 `d1_migrations_share`；passkey-e2e 部署预览前会跑这套迁移；还没有部署预览 Worker 的 CI job）。
- 部署：`.github/workflows/deploy.yml` 的 `deploy-share-worker`，顺序 账号 ∥ 短链 → 网关 → Pages（不再依赖账号 Worker；在网关之前：新短链对新旧网关都能用）；先迁移 D1（本 Worker 的 share 迁移 + 同库网关的迁移）、查 `d1_migrations_share` / `d1_migrations_gateway` 并核对搬迁标记 `d1_cutover`，再部署，再冒烟。
  token `styrigx-share-deploy`（GitHub 环境 `STYRIGX_SHARE_DEPLOY`，只允许 main）。
- 顶栏分享按钮（2026-10-24，共享外壳 share.js）：进门的人点它（P2-3 起不分角色；先锁侧复验）→ POST `/api/share` `{action:'create', reuse:true, to:当前页, hours:24, session:43200}`（合并 PR3 起三站在 styrigx.com/<站>/ 下，与主站同源）；
  同一页、同档位、还剩 ≥ 12 小时的有效短链直接复用（不签新钥匙，临时钥匙列表不变长）。
- 跨源：旧图志 atlas.styrigx.com 下线后（2026-11）删掉了 lib/cors.js：/api/share 不回任何 Access-Control-* 头，OPTIONS 预检在门之前一律 403，跨源 POST 403 origin。
- 测试：`tests/workers/share/`；边缘测试台 `tests/space/e2e/edge/edge-flow.spec.js` 的 R9。
