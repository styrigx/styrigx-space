# 进站与账号安全模型 V3

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SEC-001 |
| 版本 | 1.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |
| 依据 | 进站 v3（L0–L3，#334 #335 #337 #338 #340）、账号命名 v2（#328 #329）、#357（账号会话 30 天滑动）；决策见 ADR-0002、ADR-0003 |

## 1. 范围

本规范定义谁能进站、谁能做哪些敏感操作、各种会话活多久。cookie 格式与状态机见 SGX-SPEC-001。本文只写 Secret 的**名字**，MUST NOT 写任何值。

## 2. 原则

2.1 **门归网站，账号管授权**。进站会话（`sgx-space-session`）只回答「能不能进来」；账号会话（`sgx-account-session`）只回答「能不能写、能不能看私密内容」。两套票据由不同的 Worker、不同的签名钥匙签发，互相 MUST NOT 替代。

2.2 **一次验证只签一张票**。登录只签会话；reauth 只签 reauth 票；恢复只签 reset 票。

2.3 **reauth 只认长期凭证**。reauth MUST 只接受解锁密码 / 通行密钥（进站侧）或账号密码 / 账号通行密钥（账号侧）。临时钥匙、分享链接、恢复钥匙 / 恢复密钥 MUST NOT 签出 reauth 票。

2.4 **恢复只开 reset**。恢复钥匙 / 恢复密钥只能换取 3 分钟的 reset 票；reset 票只能重设凭证，MUST NOT 签发会话。

2.5 **fail closed**。缺签名钥匙 → 503 `config`；凭证读取失败 → 按「已配置」或 503；纪元推不动 → 不执行删除。

## 3. 凭证

| 侧 | 凭证 | 存储 / Secret 名 | 用途 |
|---|---|---|---|
| 进站 | 解锁密码 | D1 `styrigx-space-core`；pepper `SGX_SPACE_PASSWORD_PEPPER` | 进站、reauth |
| 进站 | 通行密钥（WebAuthn） | D1 `styrigx-space-core` | 进站、reauth |
| 进站 | 分享链接 | D1 `share_*` 表（会话按 `share_link` 这一行验，by=link） | 点开即进站（可选） |
| 进站 | 恢复钥匙 | Secrets Store `SGX_SPACE_RECOVERY_KEY` | 只换 reset 票 |
| 进站 | 签名钥匙对 | `SGX_SPACE_PRIVATE` / `SGX_SPACE_PUBLIC` | 签 / 验三张进站票 |
| 账号 | 账号密码 | D1 `styrigx-account`；pepper `SGX_ACCOUNT_PASSWORD_PEPPER` | 登录、reauth |
| 账号 | 账号通行密钥 | D1 `styrigx-account` | 登录、reauth |
| 账号 | 恢复密钥 | `SGX_ACCOUNT_RECOVERY_KEY` | 只换 reset 票 |
| 账号 | 签名钥匙对 | `SGX_ACCOUNT_PRIVATE` / `SGX_ACCOUNT_PUBLIC` | 签 / 验三张账号票 |

3.1 进站侧的 Secret 只绑在 `styrigx-space-core`，账号侧的只绑在 `styrigx-account`。站点核心源码 MUST NOT 出现 `SGX_ACCOUNT_*`（`check-layers.mjs` 规则 16）。

3.2 WebAuthn 的 `rpId`、origin（`SGX_RP_ID`、`SGX_ORIGIN`）、user handle 与 cookie 属性是技术红线：改动 MUST 单独立项并经拥有者批准。

## 4. 会话时长

| 票 | 时长 | 续期 |
|---|---|---|
| 进站会话（解锁密码 / 通行密钥） | 12 小时 | 不续期 |
| 进站会话（临时钥匙） | min(钥匙剩余, 12 小时) | 不续期 |
| 进站会话（分享链接） | min(链接会话档位, 钥匙剩余)；档位 30 min / 1 h / 3 h / 12 h / 1 d / 3 d / 7 d | 不续期 |
| 进站 reauth | 3 分钟 | 不续期 |
| 进站 reset | 3 分钟 | 不续期 |
| 账号会话 | 30 天 | **滑动**：剩余不到 15 天时，账号接口的响应重签；30 天不用自然过期 |
| 账号 reauth | 3 分钟，绑定本机 deviceId | 不续期 |
| 账号 reset | 3 分钟 | 不续期；`finish` 后作废 |

4.1 2026-11-09 之前签发的 400 天账号会话在第一次使用时重签为 30 天；`lastSeen` 超过 30 天的旧设备视为过期一次（#357）。

4.2 临时钥匙有效期：1–24 小时，或 3 / 7 / 15 / 30 天；同时有效最多 20 把。分享链接有效期同档，同时有效最多 20 条。

## 5. 进站侧操作矩阵（盾牌 `styrigx@space:~#`）

| 操作 | 接口 | 服务端要求 | 界面 |
|---|---|---|---|
| 浏览四站页面 | — | 进站会话（任意 by） | — |
| 立即锁屏 | `POST /api/lock-now` | 无；**只锁当前设备**（清本机进站会话、reauth、reset 票） | 不验证 |
| 新建分享链接（含快捷面板「分享本页」） | `POST /api/share { create }` | 进站会话（不收分享链接进来的会话：by=link → 403 link） | 不验证 |
| 分享链接列表 / 作废 | `POST /api/share { list \| revoke }` | 进站会话 + reauth | 进层前 `sudo styrigx reauth` |
| 解锁密码设 / 改 / 删 | `POST /api/lock-password` | 进站会话 + reauth（或 reset 票） | 进站凭证层，进层前 reauth |
| 通行密钥增 / 改名 / 删 | `POST /api/lock-passkey` | 进站会话 + reauth（或 reset 票；reset 下不能改名） | 同上 |
| 所有设备回锁屏 | `POST /api/lock-all-devices` | 进站会话 + reauth | 同上 |
| reauth | `/api/lock-password` / `/api/lock-passkey` 带 `reauth:true` | 进站会话；**只认解锁密码或通行密钥** | `sudo styrigx reauth [passkey\|password]` |
| reset | `POST /api/lock-reset { verify }` | 恢复钥匙（无需会话） | 锁屏 `sudo styrigx reset` |

5.1 用 reauth 票改了进站凭证（改 / 删密码、删通行密钥）时，进站纪元 +1：**其他设备回锁屏**，本机的会话与 reauth 票按新纪元重签，不掉线。

5.2 reset 票下的写入不推纪元；拥有者在 reset 终端里选择 `all`（推纪元，所有设备回锁屏）或 `none`。第一次配置进站凭证照旧推纪元。

5.3 最后一把进站凭证 MUST NOT 被删除。

5.4 临时钥匙的明文码只在创建时返回一次，服务端只存哈希；作废后用它进站的会话在下一个请求即失效。分享链接的钥匙没有码。

5.5 限速：解锁密码每连错 5 次冷却一轮（30 秒起翻倍，封顶 1 小时）；恢复钥匙单 IP 连错 5 次锁 15 分钟，全局只减速不封锁；无会话的写接口经 `ANON_LIMITER`（每分钟 20 次），绑定缺失时 MUST fail closed（503）。

## 6. 账号侧操作矩阵（账号下拉）

| 操作 | 接口 | 要求 |
|---|---|---|
| 查看状态 | `GET /api/account` | 进站会话 |
| 登录 `sudo root` | `POST /api/account/session { passkey \| password }` | 进站会话；账号密码或账号通行密钥 |
| 退出 | `POST /api/account/session { end }` | 无 |
| reauth `sudo root reauth` | `POST /api/account/reauth` | 进站会话 + 账号会话；只认账号密码 / 账号通行密钥 |
| 账号安全：改密码、增 / 删 / 改名通行密钥 | `POST /api/account/keys` | 进站会话 + 账号会话 + reauth（`passkey-list` 只要会话） |
| 设备列表 / 单独退出一台 | `POST /api/account/devices { list \| revoke }` | 进站会话 + 账号会话 |
| 退出所有其他设备 | `POST /api/account/devices { revoke-all }` | + reauth |
| 应用授权：列表 / 取消 | `POST /api/account/grants { list \| revoke }` | 进站会话 + 账号会话（取消只降权，不要 reauth） |
| 应用授权：授予 | `POST /api/account/grants { add }` | + reauth |
| 重置 `sudo root reset` | `POST /api/account/reset { recovery-key }` → `password-set` / `passkey-*` → `finish { signOut }` | 进站会话 + 恢复密钥；`signOut` ∈ `all` / `others` / `none`，界面默认 `others` |

6.1 账号 Worker 只认站点核心写的 `X-Styrigx-Space-Session: 1` 身份头；进站会话 MUST NOT 被当作账号认证。

6.2 改了账号钥匙：session 纪元 +1，本机 session 与 reauth 按原样重签，其他设备的设备行删除。

6.3 错误码约定：没有进站会话 401 `session`；没有账号会话 401 `account`；需要 reauth 403 `reauth`；reset 票无效 401 `reset`；作用域不足 403 `scope`。

## 7. 审计

7.1 恢复钥匙每次使用（成功 / 失败）在 D1 `styrigx-space-core` 记一行（`GET /api/space-audit` 可读，需要账号会话）。

7.2 账号侧事件记在 `account_audit`（列 `event` = `<入口>-<action>`，如 `reset-recovery-key`、`keys-passkey-add`）。

7.3 日志 MUST NOT 记录钥匙、密码、cookie 值；上游错误信息里的 API key MUST 脱敏。
