# v6 身份统一：STEPUP / APP 调用点与去向（P1）

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SPEC-006 |
| 版本 | 0.1 |
| 日期 | 2026-11-11 |
| 状态 | P4 已按本表删除；P1 时的「去向」与定稿冲突处以下文「P4 结果」与定稿 v5.5 为准 |


> 状态：P1（2026-11-11），基线 main 05abe443。**P1 不删任何东西**，只列清单；删除在 P4，删前再 grep 一遍、干净才删。
> 相关：ADR-0006、`docs/specs/v6-route-inventory.md`。

## 0. P4 结果（定稿 v5.5 §九、§十二）

- 安全设置类 → sudo 每次重验；改自己的凭据走 `passwd` / `passkey`（指向 root 时须栈顶 root，定稿 §十）。`sudo -v`、`sudo root reauth`、锁侧 / 账号复验票删除。
- lockreset → root 重置；恢复只剩救援 `rescue`：钥匙 `SGX_ACCOUNT_RESCUE_KEY` 放 Cloudflare Secrets Store，D1 `account_recovery_key` 只记指纹（定稿 §九）。两把旧恢复钥匙删除。
- `/api/root-auth` → 删（不恢复）。
- 子应用（APP 的继任）：**应用授权整套删除**——`app allow|deny`、账号页应用授权卡、授权接口与判定代码、APP 子应用令牌、`account_grant` 表；不转换成 `usermod`，子站写接口只按路由档（curio-write / daymark-write）拦；奇趣 / 日刻 `_auth.js` 只留 v6 判定，`conclusion()` 删除（定稿 §十二）。
- 签名钥匙 `SGX_ACCOUNT`、`SGX_SPACE` 两对删除，站内不再有签名钥匙（定稿 §十二）。

## 1. 结论先行

- 全仓 grep `sgx-stepup` / `STEPUP` / `stepup.js` / `verifyStepupCookie` / `sgx-app` / `stepup-required`（排除博客正文与构建产物）：**20 处、10 个文件，运行时代码 0 处**。两个信任域本体（`/api/stepup`、`/api/app-token`、`SGX_STEPUP_*`、`SGX_APP_*`、`sgx-stepup` / `sgx-app` cookie）已在进站 v3 / 账号拆分时删除，`tests/workers/space-core/lock-reauth.test.mjs` 有「删除」断言守着。剩下的 20 处全是退役守卫、删除断言和过期注释。另有 3 篇博客正文（2026-10-11 钥匙规范白皮书 v1 / v2）提到它们，是历史文章，不动。
- 真正要处理的是它们的**继任者**：STEPUP 的职责现在由三套票承担——锁侧复验 `LockReauthTicket`（`sgx-space-reauth`，`sudo -v`）、账号复验 reauth 票（`sgx-account-reauth`，`sudo root reauth`）、重置票（`sgx-space-reset` / `sgx-account-reset`，恢复钥匙）；APP 的职责由账号的应用授权（`account_grant` + 作用域 `curio.write` …）+ 网关结论承担。下面逐条列调用点与 v6 去向。
- 去向四类（定稿 §十、Muse 复盘 3）：**安全设置类 → sudo 每次重验**；**lockreset → root 重置**；**/api/root-auth root 代开 → 删**；**子应用入口与前端 403 复验重试 → 改**。

## 2. 字面引用（20 处 / 10 个文件）

| 文件 | 处数 | 是什么 | 去向 |
|---|---|---|---|
| `.github/workflows/deploy.yml` | 2 | 退役名单注释（:79）；Secrets 禁用名单（:1016，含 `SGX_STEPUP_PRIVATE`、`SGX_APP_PRIVATE`） | 留（守卫） |
| `space/scripts/retired-names.json` | 1 | legacy 名单里的 `SGX_STEPUP_KEY` | 留（守卫） |
| `tests/blog/url-map.json` | 2 | 博客旧文的标题锚点（`65-…-stepup`） | 留（历史文章） |
| `tests/space/ui/account/frontend-session.test.mjs` | 1 | 断言 lock-now 不再发 `sgx-stepup` / `sgx-app` | 留（删除断言） |
| `tests/workers/space-core/lock-reauth.test.mjs` | 5 | 断言 `/api/stepup`、`/api/app-token`、`stepup.js`、`SGX_STEPUP_*` / `SGX_APP_*` 都不在 | 留（删除断言） |
| `tests/workers/space-core/realms.test.mjs` | 1 | 网关源码不许出现的名字表 | 留（守卫） |
| `tests/workers/space-core/session-security.test.mjs` | 2 | `/api/stepup` 无会话 401（路由不存在） | 留 |
| `tests/workers/space-core/auth-2101.test.mjs` | 3 | 文件头注释描述 2.10 时代的 stepup 行为（用例本身已改测 reset 票） | P4 随锁屏旧测试一起清注释 |
| `tests/workers/space-core/auth-2102.test.mjs` | 2 | 同上 | P4 清注释 |
| `tests/workers/space-core/auth-211.test.mjs` | 1 | 同上 | P4 清注释 |

`lockreset` 字样另有 `tests/workers/space-core/old-names.test.mjs`（旧名禁用）和若干锁屏重置测试，跟着 C 组（下文）走。`/api/root-auth` 只剩 `tests/workers/space-core/space-audit.test.mjs:205` 的「旧路径 404」断言：**已删，留断言**。

## 3. 继任者调用点

### A. 锁侧复验（`LockReauthTicket` / `sgx-space-reauth` / `sudo -v`）——安全设置类 → sudo 每次重验 / 改自己的凭据

| 位置 | 用途 | v6 去向 |
|---|---|---|
| `workers/space-core/src/core/tickets.js`、`core/realms.js` | 签 / 验 LockReauthTicket、票表 | P4 删（随 `SGX_SPACE_*`） |
| `workers/space-core/src/core/lock-manage.js` `checkLockManage` | 锁屏凭证管理门（reauth 票 + 进门，或 reset 票） | P4 删；v6 改自己的凭据 = `passwd` / `passkey`（user 档，改密码须先输当前密码） |
| `workers/space-core/src/api/lock-password.js`（`verify { reauth:true }`、`set` / `change` / `remove`） | 签复验票、改进站密码 | 签票部分 P4 删；改密码 → `passwd`（styrigx 自己） |
| `workers/space-core/src/api/lock-passkey.js`（`auth { reauth:true }`、`register` / `list` / `rename` / `delete`） | 同上（通行密钥） | → `passkey`（styrigx 自己） |
| `workers/space-core/src/api/lock-reauth.js` | 票状态 / 清票 | P4 删（`sudo -v` 删除） |
| `workers/space-core/src/api/lock-all-devices.js` | `lock --all`（要复验） | → 作废自己的会话（user 档；Gray 2026-11-11 定：不要 sudo） |
| `workers/space-core/src/api/share.js` + `core/link-keys.js` `checkLinkReauth` | 分享链接 list / revoke 要复验 | P4 随分享整套删（root `useradd -e` 取代） |
| `workers/space-core/src/api/lock-now.js` | 上锁时清复验票 | P4 删；v6 `lock` 清栈并删服务端会话行 |
| 前端 `space/web/assets/js/shell/space/reauth.js`、`api.js`、`keys.js`、`links.js`、`layer.js`、`session.js`、`paths.js`、`term/cmds/keys/sudo.js`（`sudo -v`）、`auth/passkey-assert.js`、`auth/post-json.js`（`reauthExpired`） | 终端里的复验流程与 403 reauth 重试 | P2 改：复验 → `sudo <命令>` 每次输自己的凭据；P4 删旧流程 |

### B. 账号复验（reauth 票 / `sgx-account-reauth` / `sudo root reauth`）——安全设置类 → sudo 每次重验

| 位置 | 用途 | v6 去向 |
|---|---|---|
| `workers/account/src/core/reauth.js`、`api/account/reauth.js`、`core/config.js` `TICKET.reauth` | 签 / 验 / 清 reauth 票 | P4 删 |
| `workers/account/src/core/authorize.js`（`opts.reauth`）、`rpc/account-verifier.js` | 授权结论里的 `reauth` 位 | P4 删字段；v6 结论带 uid + 组 |
| `workers/space-core/src/core/conclusion.js`、`core/account-rpc.js` | 把 `reauth` 交给下游 | P4 删字段 |
| `workers/account/src/api/account/keys.js` | 改账号（= root）钥匙要 reauth | → root 档（救援可用），sudo 每次重验 |
| `workers/account/src/api/account/devices.js`（`revoke-all`） | 退出其他设备要 reauth | → 作废自己的会话（user 档） |
| `workers/account/src/api/account/grants.js`（`add`） | 重新授权要 reauth | → `usermod -aG`（root） |
| `workers/account/src/api/account/proxy.js`（`show` / `token` / `key`） | 代理订阅敏感读要 reauth | → root 档（Gray 2026-11-11 定：root，不加新组） |
| `workers/curio-core/src/app.js` `REAUTH_ROUTES`（`POST /api/import`）、`api/_auth.js` | 批量导入要账号复验 | → root 档（sudo） |
| `workers/daymark-core/src/api/_auth.js` | 读结论里的 reauth 位（当前没有接口要它） | P4 删字段 |
| 前端 `space/web/assets/js/shell/account/reauth.js`、`api.js`（`reauth`、`ERR.reauth`）、`cmd/layer.js`（`withReauth`、只做再验证、`sgx-account-reauthed` 事件给奇趣导入）、`cmd/keys.js`、`cmd/devices.js`、`cmd/grants.js`、`proxy.js`、`session.js`、`topbar-panel.js`（`#acct=reauth`）、`term/man/pages.js` | 403 reauth → 弹复验 → 自动重试一次 | P2 改：403 → 提示 `sudo` 重验后重试；P4 删旧流程 |

### C. 重置（lockreset 的继任：`sgx-space-reset` / `sgx-account-reset` / 恢复钥匙）——lockreset → root 重置

| 位置 | 用途 | v6 去向 |
|---|---|---|
| `workers/space-core/src/api/lock-reset.js`、`api/space-auth.js`、`core/space-check.js`、`core/lock-reset-switch.js`（只剩测试引用）、`api/lock-credentials.js`（reset 票可读）、`core/lock-manage.js`（`allowReset`） | `sudo styrigx reset`：进站恢复钥匙换 reset 票 | P3 救援入口（恢复钥匙直接签 15 分钟一次性 root 会话）取代；styrigx 忘密码 → root `passwd styrigx`；P4 删 |
| `workers/account/src/core/reset.js`、`api/account/reset.js`、`core/recovery-key.js` | `sudo root reset`：账号恢复密钥换 reset 票 | 同上（恢复钥匙合一：救援钥匙 `SGX_ACCOUNT_RESCUE_KEY` 放 Secrets Store，D1 `account_recovery_key` 只记指纹，定稿 v5.5 §九） |
| 前端 `space/web/assets/js/shell/space/reset.js`、`account/` 里的 reset 层 | 重置终端层 | P3 改为救援入口；P4 删 |

### D. root 代开（`/api/root-auth`）——删

已删（账号拆分 PR3）；`tests/workers/space-core/space-audit.test.mjs` 断言旧路径 404。v6 没有可代开的进站会话，不恢复。

### E. 子应用（APP 的继任：`account_grant` + 作用域 + 网关结论）——子应用入口与 403 重试 → 改

| 位置 | 用途 | v6 去向 |
|---|---|---|
| `workers/account/src/core/scopes.js`、`core/grants.js`、`api/account/grants.js` | 作用域表、app allow / deny | P2：子应用权限改由组表达（`curio-write`、`daymark-write`；listen / ai / status 同理）；`app allow|deny` 随应用授权整套删除（定稿 v5.5 §十二，不转成 `usermod`）；P4 删 `account_grant` |
| `workers/account/src/gate.js` `scopeDenial`（avatar / prefs / profile）、`api/wellbeing.js`（数字健康 v6 P4 整套删除，定稿 v5.5 §四） | 账号数据写要作用域 | P2 改按路由表的档（见盘点） |
| `workers/space-core/src/core/conclusion.js`、`rpc/space-verifier.js` `conclusion()` | 子站接口 Worker 问结论（scopes） | P2 改：结论带 uid + 组（来自 `AccountVerifier.admit`） |
| `workers/curio-core/src/api/_auth.js`（`requireScope`、`SCOPE_WRITE`）、`_write.js` `guardWrite`、`preview.js`、`music.js` | 写要 `curio.write` | P2 改：写组 `curio-write`；结构删除 root |
| `workers/daymark-core/src/api/_auth.js`、`_write.js` | 写要 `daymark.write` | P2 改：`daymark-write`；删专题定 root（Gray 2026-11-11，结构删除） |
| 前端 `space/web/assets/js/shell/account/cmd/grants.js`（`app allow|deny`）、`cmd/layer.js` `entry({ app })` / `topbar-panel.js`（奇趣 / 日刻的 `sudo root &app=…` 入口）、`space/web/layouts/partials/curio/signin.html`、`space/web/layouts/daymark/section.html` | 子应用「去授权」入口 | P2 改：缺组时提示 `su`（或请 root 加组）；外观改动先截图给 Gray |

## 4. 数字

- 字面引用：20 处 / 10 个文件（另 3 篇博客正文）；运行时代码调用 0。
- 继任者：A 组 9 个后端位置 + 11 个前端文件；B 组 11 个后端位置 + 10 个前端文件；C 组 9 个后端文件 + 前端 reset 层；D 组已删；E 组 12 个后端位置 + 5 个前端 / 模板文件。
- 去向：安全设置类 → sudo / 改自己的凭据（A、B）；lockreset → root 重置 + P3 救援（C）；root 代开 → 已删（D）；子应用入口与 403 重试 → 改（A、B 的前端，E）。
