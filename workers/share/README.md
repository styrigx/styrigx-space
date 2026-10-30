# styrigx-share

主站「分享短链」的后端（2026-10-24 新建，照账号 Worker `styrigx-account` 的拆法）：`https://styrigx.com/s/<码>`（中英文同一条）和管理员管理接口 `/api/share`。

```
src/index.js        入口：/s/<码> → open.js；/api/share → api/share.js；X-SGX-Runtime: share
src/gate.js         门：只认 styrigx.com；/s/* 谁都能开；/api/share* 只许管理员（访客 403、没会话 401）
src/auth.js         会话：本 Worker 自己一份（锁屏会话问网关 AuthVerifier / AUTH，账号会话问账号 Worker AccountVerifier / ACCOUNT_VERIFIER）
src/open.js         打开短链：普通 → 302；带会话 → 请网关 ShareIssuer 签访客会话 → 302（去掉码）；失败统一 302 /?lock=1；限速
src/api/share.js    POST /api/share { list | create | revoke }（管理员 + 账号会话；同源，子站只许 create + reuse）
src/lib/links.js    规则（码、有效期、会话档位、目标：站内路径或 styrigx.com / 三个子站的 https 地址）、复用查询和 D1 语句
src/lib/cors.js     /api/share 的跨源：只认 blog / daymark / curio 三个子站 Origin，预检 OPTIONS、Allow-Credentials、Vary: Origin
migrations/         D1 styrigx-share 的表结构（0001_share_links.sql：share_link、share_fail）
```

- 钥匙和会话：本 Worker 不持任何钥匙、不绑认证库。带会话的短链由网关签一把「短链钥匙」（临时 LockKey，link=true，没有临时码），
  点开时由网关签 visitor 会话 + 钥匙票（和锁屏输临时码进门同一套代码，`workers/auth-gateway/src/share-issuer.js`），
  经服务绑定 `ISSUER`（entrypoint `ShareIssuer`，只有本 Worker 绑定）调用。
- 作废：带会话的短链先请网关作废钥匙（写作废标记），拿它进来的访客下一个请求就进不来；再在 D1 记 revoked_at。
- 数据：D1 `styrigx-share`（绑定 `D1_SHARE_LINK`）；预览 D1 是所有 Worker 的预览共用的测试库 `styrigx-test-preview`，登记在 `[env.preview]`（迁移记录表 `d1_migrations_share`；passkey-e2e 部署预览前会跑这套迁移；还没有部署预览 Worker 的 CI job）。
- 部署：`.github/workflows/deploy.yml` 的 `deploy-share-worker`，顺序 账号 → 短链 → 网关 → Pages（在账号之后：账号会话问账号 Worker 的 `AccountVerifier`；在网关之前：网关上线时短链已不再问网关要账号会话）；先迁移 D1 并查 `d1_migrations` 确认，再部署，再冒烟。
  token `styrigx-share-deploy`（GitHub 环境 `STYRIGX_SHARE_DEPLOY`，只允许 main）。
- 子站顶栏分享按钮（2026-10-24，共享外壳 share.js）：管理员点它 → 跨源 POST `{action:'create', reuse:true, to:当前页, hours:24, session:43200}`；
  同一页、同档位、还剩 ≥ 12 小时的有效短链直接复用（不签新钥匙，临时钥匙列表不变长）。
- 测试：`tests/workers/share/`；边缘测试台 `tests/web/e2e/edge-flow.spec.js` 的 R9。
