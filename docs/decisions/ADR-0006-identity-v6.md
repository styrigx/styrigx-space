# ADR-0006：v6 身份统一——一个签发者、root / 普通用户、权限 = 组

| 项 | 值 |
|---|---|
| 状态 | 已采纳（P1–P3 已实施，P4 收尾中）；以定稿 v5.5（2026-11-11 20:12，冻结）为准 |
| 日期 | 2026-11-11 |
| 决策者 | Sloan Gray |
| 关联 | 取代 ADR-0003 §2.3、ADR-0005 §2.2.3–§2.2.4（sudo 段）；SGX-SPEC-004（路由盘点）、SGX-SPEC-005（迁移对照）、SGX-SPEC-006（STEPUP / APP 去向） |

## 1. 背景

1.1 v5 有两套会话（站点核心签的进站会话、账号 Worker 签的账号会话）、两把恢复钥匙（`SGX_SPACE_RECOVERY_KEY`、`SGX_ACCOUNT_RECOVERY_KEY`）、两套复验（`sudo -v` 与 `sudo root reauth`），概念互相重叠；分享短链与「给别人权限」又是第三套机制。

1.2 方案经草案 v2、Muse 两轮审查与 Gray 2026-11-11 03:11 / 03:23 / 03:24 确认，定稿 v3。

## 2. 决定

### 2.1 一个签发者

`@` 前的所有身份由账号 Worker `styrigx-account` 统一签发与管理（类比 PAM + `/etc/passwd`）；网关只判定、不签发。会话是 D1 里的不透明 id（`account_sessions.id` = 令牌的 SHA-256），客户端 token 不带 uid、组或栈；cookie HttpOnly、Secure、SameSite。网关经服务绑定 `ACCOUNT_VERIFIER.admit()` 拿结论，不信客户端 claim。

### 2.2 用户

- **root**（uid 0）：唯一超级用户，什么都能干（root ⊇ styrigx），不配个人资料；日常只管用户、凭据、授权与批量 / 结构删除（定稿 v5.5 §二）。**代码级禁止公开登录**：访客发起的签发绝不签 uid 0，公开登录端点拒收 root 凭据；admit 也拒绝「栈底是 root 但不是救援会话」的会话。
- **普通用户**：可多个，由 root 增删授权；**styrigx**（uid 1000）是第一个，日常态是 `styrigx@space`。新用户从 1001 起。
- root 与普通用户凭据完全独立（各自的密码、通行密钥；通行密钥显示名区分 styrigx / root）。
- 提示符 `<用户>@space:<路径>`；未登录提示符保持现状。头像 = whoami（定稿 v5.5 §七）：访客头像点击预填 `su `；普通用户（uid 1001 起）显示站长的头像，只作装饰、不可点击；站长 styrigx 与 root 点击打开同一张账号页（只留个人信息卡、设备卡、一个退出按钮 `lock`）。
- 徽章（顶栏盾标，四档；定稿 v5.5 §七）：点击按当前身份还能晋升到哪一档预填，只预填、回车才生效——访客 `su `、普通用户 `exit`、站长 `su root`、root `exit`。徽章与头像是两个东西。

### 2.3 权限 = 组（fail closed）

- 组：`wheel`（可 su root）、`sudoers`（可 sudo）、`listen`、`ai`、`status`、`curio-write`、`daymark-write`（上传、编辑、单条内容删除）。删除不做组：**批量 / 结构删除只属 root**。
- styrigx 默认：wheel、sudoers、listen、ai、status、curio-write、daymark-write。新用户默认无组。
- **普通用户**（uid 1001 起，含临时用户）只给只读组 `listen`、`ai`、`status`，代码拒绝加入 wheel、sudoers、写组；写接口只给站长 styrigx 与 root（定稿 v5.5 §四，取代原「临时用户」一条）。
- 权限层级 = man 索引顺序：root → 站长 styrigx → 普通用户 → 访客，自上而下递减；后台数据控制（用户与组、设备会话、代理、导入导出、批量删除）一律 root 档，站长用 sudo 提权（定稿 v5.5 §四）。
- 访问档：`public` / `user`（任一已登录身份）/ 组名 / `owner`（站长 = styrigx，P2）/ `root`；每条路由一档，未列入一律拒绝（SGX-SPEC-004）。判断全站只有一处：`workers/account/src/core/groups.js` `permits()`，顺序固定（定稿 v4 §三，P2 实现）：① 救援会话只放白名单路由 / action，其余一律拒、不往下走；② root 一律放行；③ 按档。admit 没有任何绕过 `permits` 的 root 快速路径。
- 原来要复验的操作一律改成 sudo 每次重验（= root 档）。

### 2.4 身份切换（P2 实现）

- `su <用户>`：输目标用户的凭据；访客可 su 到普通用户。`su root`：仅 wheel，输 root 的凭据。普通用户态不能 su 到另一个普通用户（先 exit）。
- `sudo <命令>`：sudoers 每次输**自己的**凭据，借 root 执行一条；不发票据、**不压栈**（删 `sudo -v` 与 `sudo root reauth`）。只有 su 压栈。
- `exit` 弹一层（root → 普通用户 → 访客）；`lock` 清空整个栈并删服务端会话行。
- 身份栈存服务端（`account_session_stack`，挂在会话下），最多三层（访客 → 普通用户 → root，schema 用 CHECK 写死）。
- `who` 显示栈路径（如 `root (via styrigx)`）；普通用户只看自己，root 看全部。`groups` 同理；`whoami` 任何人。

### 2.5 时长（Gray 2026-11-11 03:24 定稿）

- styrigx（普通用户）层 **30 天滑动续期**。admit 只读；**只在剩余有效期低于一半时才续写，每会话每天至多一次**（`core/identity-session.js` `shouldRenew`）。
- root 层最长 **1 小时**；**前台空闲 15 分钟**弹回到 styrigx（Page Visibility：页面隐藏 / 锁屏时暂停计时；实现太重则放宽到 30 分钟）。
- 救援会话 **15 分钟**，不续期。

### 2.6 用户管理（root，P2 实现）

- `useradd <名> [-e YYYY-MM-DD] [-G 组]`：生成 16 位以上随机一次性密码，只显示一次，库里只存哈希；Gray 线下发；首登强制改密码，一次性密码 24 小时过期。**`-e` 按 Linux 语义：该日 00:00（Asia/Shanghai）起失效**（可用到前一天结束），存 UTC 时间戳。
- `userdel <名>`：同时清会话、凭据、组。`usermod -aG|-rG <组> <名>`。`passwd <名>`：同样发一次性密码、首登强制改。
- 到期：自动禁用并作废会话，宽限期后自动删除。
- 站长 styrigx 用 `passwd`、`passkey` 改自己的凭据；普通用户（uid 1001 起）只能 `passwd` 改自己的密码，不能管通行密钥（定稿 v5.5 §八）。**`passwd` 改自己的密码须先输当前密码**，root 替别人重置不用；通行密钥自带 WebAuthn 验证，不另加。
- `passwd` / `passkey` 指向 root 时须当前会话栈顶是 root（`su root` 或救援）；`sudo passwd root`、sudo 增删 root 通行密钥一律拒绝（定稿 v5.5 §十）。

### 2.7 epoch

凭据、组、期限任何变更都让该用户 epoch +1，会话里存快照，严格相等才有效。**自己改密码 / 通行密钥时当前会话续命**（快照刷新，其他会话作废）；**root 替别人重置则该用户会话全部作废**（`core/users.js`）。

### 2.8 恢复（救援，P3 实现）

以定稿 v5.2 §九为准（P3 改写本节；原「D1 哈希 + 终端生成新钥匙」与「未决：存放方案」两处作废）：

- 恢复钥匙**一把，只管 root**，放 **Cloudflare Secrets Store**（每账号只能一个 Store，与其他 Secret 同库）：`SGX_ACCOUNT_RESCUE_KEY`（Gray 2026-11-11 05:21 定名，05:23 已在现有 Store 建好，Workers 范围，32 位以上随机值）。Gray 在 dashboard 设值、换值，改完运行时即时生效，不用重部署；平时不动，不定期轮换，每次救援后换值。账号 Worker 只加绑定。
- 访客走救援入口（命令 `rescue`，Gray 2026-11-11 13:17 定），输恢复钥匙，Worker 读 Store 做 constant-time 比对，通过则签 **15 分钟一次性 root 会话**（单用户模式），不续期；会话带 rescue 标志。
- 指纹：签发成功时在 D1 `account_recovery_key`（复用 P1 的表）记该值哈希（不存明文），永久保留；同值再用直接拒绝；指纹写失败则拒绝救援（fail-closed）。
- 白名单：`passwd`、`passkey`、`whoami`、`groups`、`exit`、`lock`，**不含换钥匙**；按 §2.3 先于 root 放行检查（`precedence()` 一处）。救援栈只有 root 一层，**exit 直接回访客**。
- 救援成功后提示 Gray 去 dashboard 换新值；重置后相关用户 epoch +1；救援入口单独限流（渐进延迟）+ 审计（`account_user_audit`）。
- 代码纪律：Worker 运行时绑定只有 `get()`；代码不出现 Store 写 / 删调用，合并前 grep 静态检查（单测 `tests/workers/account/v6-rescue.test.mjs`）。Edit 权限风险在部署用的 CF token（范围待确认，必要时收窄）。
- 全丢：能登 Cloudflare 就设新值，不做破窗。
- 两把旧钥匙（`SGX_SPACE_RECOVERY_KEY`、`SGX_ACCOUNT_RECOVERY_KEY`）P4 删。
- 普通用户忘密码由 root 重置。

### 2.9 安全细节

- 防枚举：用户不存在与凭据错误同一错误、同一耗时路径；不提示某用户有哪些验证方式。
- 限流两维：按 IP 硬上限（6 次 / 分钟）；按 uid 渐进退避（1s → 5s → 30s → 5min），不硬锁；通行密钥不计入 uid 冷却。admit 只读，认证失败才写计数。
- 哈希：沿用现有加盐 + pepper 快速哈希（Worker 免费档 10 ms CPU，不用 bcrypt / argon2）；在线防猜靠限流。每条密码记 `pepper_id`。
- admit：一次 D1 查询（会话 + 栈 + 用户 + 组 + epoch 一次 JOIN）。
- 审计（`account_user_audit`）：useradd / userdel / usermod / passwd、su、sudo、救援、登录失败；记 uid、命令、时间、IP 前缀；保留 90 天。

### 2.10 存储

账号 D1 `styrigx-account` 内新增 8 张表（`account_users`、`account_user_groups`、`account_user_password`、`account_user_passkey`、`account_sessions`、`account_session_stack`、`account_user_audit`、`account_recovery_key`），不新增 D1。凭据迁移见 SGX-SPEC-005：现账号凭据 → root；进站密码与进站通行密钥 → styrigx（通行密钥只改挂 uid，RP 不变，userHandle 逐字节照抄）；头像、偏好、设备 → styrigx。D1 是唯一真相来源：备份走 D1 Time Travel / 导出，写进运维笔记（P3）。

### 2.11 信任域与密钥终局

- LOCK（进站）：并入账号 Worker 会话，P4 删站点核心的签发。
- STEPUP、APP：本体已删（v3 / 账号拆分）；继任者（锁侧复验、账号复验、重置票、应用授权）按 SGX-SPEC-006 逐条处理。应用授权整套删除（`app allow|deny`、账号页应用授权卡、授权接口与判定代码、APP 子应用令牌、`account_grant` 表）；子站写接口只按路由档（curio-write / daymark-write）拦（定稿 v5.5 §十二）。
- 签名钥匙：v6 会话是随机令牌、不签名，APP 令牌已删：`SGX_ACCOUNT` 与 `SGX_SPACE` 两对 P4 一并删，站内不再有签名钥匙；两把 `*_RECOVERY_KEY` P4 删。P4 后账号 Worker 的 Secrets Store 只剩 `SGX_ACCOUNT_PASSWORD_PEPPER` 与 `SGX_ACCOUNT_RESCUE_KEY`（定稿 v5.5 §十二）。
- pepper 两把（`SGX_SPACE_PASSWORD_PEPPER`、`SGX_ACCOUNT_PASSWORD_PEPPER`）：迁到 styrigx 的进站密码哈希是 space pepper 做的（`pepper_id = 'space'`）。**方案 a 定稿（Gray 2026-11-11）**，实现要求见 §2.12 (b)。 全站最终只留 `SGX_ACCOUNT_PASSWORD_PEPPER` 一把，旧 space pepper P4 连代码、绑定一并删（定稿 v5.5 §十）。
- 分享短链 `/s/<码>`（一段）整套删除，给别人权限改为 root 建带期限的普通用户；代理订阅 `/s/<令牌>/<来源名>`（两段，另一个主机）保留。删前盘点 `share_link` 有效链接逐个处理。

### 2.12 P2 硬要求（Gray 2026-11-11）

**(a) user 档的 uid 只取服务端会话。** 所有 user 档 handler（SGX-SPEC-004 里档为 `user` 的路由，以及 action 另定为 `user` 的 action）要操作「自己」的数据时，uid **只取 admit 返回的服务端会话结论**，绝不取客户端参数、查询串、请求头或请求体里的 uid / 用户名。P2 每条 user 路由都要有一条测试：请求里带他人 uid（参数 / body 各一）→ 被拒或被忽略（仍只作用于会话本人），不能读写到他人的数据。

**(b) pepper 方案 a 定稿。**
- 每条密码哈希记 `pepper_id`（`account` = `SGX_ACCOUNT_PASSWORD_PEPPER`，`space` = `SGX_SPACE_PASSWORD_PEPPER`）；验证时**按这条记录的 `pepper_id` 取对应 pepper**，不猜、不两把轮流试；`pepper_id` 不认识或对应 pepper 缺失 → fail closed。
- 登录成功且 `pepper_id = 'space'` 时，用账号 pepper 重算哈希，同一次写入把 `pepper_id` 改成 `account`。
- 旧 space pepper 保留到**所有活跃用户都已迁完**（库里不再有 `pepper_id = 'space'` 的活跃用户）为止，**P4 才删**（先核代码与绑定）。（定稿 v5.5 §十取代：P4 连代码、绑定一并删，Gray 2026-11-11 17:25「pepper合一把」。）
- 账号 Worker 需加绑 `SGX_SPACE_PASSWORD_PEPPER`（Secrets Store 绑定，只加绑定、不碰值）。P1 没有 v6 用户的密码验证（新会话没有签发入口，admit 只读），用不到这把 pepper，所以**绑定放在 P2**，随 `su` 验密一起加进 `workers/account/wrangler.toml`。（P2a 已加。）

### 2.13 P2a 实现要点（2026-11-11）

- 入口：`POST /api/identity`（网关 public、转发给账号；每个 action 一档，救援白名单 = whoami / passwd / passkey-* / groups / exit / lock）。
- 会话 cookie `sgx-session`：`Path=/; HttpOnly; Secure; SameSite=Lax`，只发给 styrigx.com 本主机（不写 Domain：子站都在同一主机路径下）。
- `su <用户>` 只签普通用户；`issueSession` 代码级拒签 uid 0；`su root` 只压栈（≤ 1 小时）；`idle` 只弹 root 层；`sudo` 每次验自己的凭据、不压栈、不发票据，只能借 root 跑 useradd / userdel / usermod / passwd <名> / groups / who，`passwd` / `passkey` 一律 `root-creds`。
- 数据按 uid：头像在 KV 按键前缀分（styrigx 键不变）；偏好 / 数字健康（v6 P4 随数字健康整套删除，定稿 v5.5 §四）/ 旧设备表的 uid 列在 `workers/account/migrations/0007_v6_uid_columns.sql`（2026-11-11 Gray 批准，部署 job 执行）；代码一律按 uid 读写。v6 的「设备」= 自己的 `account_sessions`。
- 审计加 root 改名片（`profile`）；批量 / 结构删除在奇趣 / 日刻接口 Worker，它们接上新会话（割接，§2.15）时写 `rm-bulk`。

### 2.14 P2c 对齐定稿 v5（2026-11-11）

- 名片 `GET /api/profile` 真正公开（§五）：网关访问表与账号 `PUBLIC_API` 都列为 public，接口不再要任何会话；只回名片四项 + 头像版本号 + 时间。PUT 不变（站长 + root）。
- `sudo <命令>`（§六）：除身份命令外，`command = { method, path, body? }` 可借 root 执行**账号 Worker 内**任何一条路由表里的接口（`api/sudo-route.js`，同进程直接调处理函数，这一次调用里 v6 结论是 root、`sudoBy` = 真正执行的人）。仍是每次验自己的凭据、不发票据、不压栈。拒绝：`/api/identity` 本身、`/api/account/keys` / `reset`（root 凭据，`root-creds`；sudo 不能动 root 的凭据，栈顶必须是 root）、`/api/account/session` / `reauth`（旧登录 / 复验票）。别的 Worker 的接口（站点核心、奇趣、日刻）不在账号 Worker，sudo 够不到（`not-here`）；它们和 `/api/account/grants`、`/proxy` 还只认旧会话，割接时接上 v6 后 sudo 才对它们生效。
- 到期（§八）：到期满 **30 天**宽限期（`core/user-expiry.js` 的 `EXPIRED_USER_GRACE_MS`，定稿没给数，Hark 定）自动删除，删法同 userdel；永不删 root / styrigx。不加 Cron：styrigx-status 每日一轮（03:41 CST）经服务绑定 `JOB_ACCOUNT` 调 `AccountJanitor.purgeExpiredUsers`，另在 useradd 前懒清理一次。
- userdel / 到期删除的用户行改留墓碑（`#deleted-<uid>`、禁用）：**uid 永不复用**，免得新用户继承旧 uid 下的头像 / 偏好等数据（数字健康 v6 P4 已删，定稿 v5.5 §八）；名字可再 useradd。
- 审计（§十）：sudo 借 root 的每一条写 `sudo <方法> <路径> [action]`（uid = 真正执行的人）；root 改名片写 `profile set …`（sudo 借来的记执行人并标 `via sudo`）；到期删除写 `expire userdel <名>`（uid null）。
- admit 先拒不认识的档，再做 root 快速放行（与 permits 第 0 步一致，`core/admit.js admitDecision`）。

### 2.15 割接（2026-11-11）

- 入口改 su（§七）：访客头像点了预填 `su `（不再是死按钮）；盾牌、上锁的地方（`sgx:sudo`）、旧锁屏地址 `?entry=1` / `#sec` 同一行；访客入口文案（旷野锁卡按钮、lockedHint、AI 窗口锁着的提示）跟着写 su。`?entry=sudo` 照旧直接跑旧的 `sudo styrigx`。su（含 su root）的密码提示同 Linux su：`Password:`；sudo 仍是 `[sudo] password for <自己>:`。
- 别的 Worker 的接口接上 v6：判断仍只在账号 Worker（`ROUTE_ACCESS` + `permits` / `precedence`），别处只传方法、公开地址路径和 action。
  - 网关自己的 `/api/share`（root）、`/api/space-audit`（root）：旧进站会话不成立时问 `newSessionConclusion`（经 `ACCOUNT_VERIFIER.admit`）；v6 root 不要锁侧复验。
  - 账号 `/api/account/grants`、`/api/account/proxy`（root）：v6 放行时不要旧账号 session / reauth 票；sudo 借来的 root 也算（sudo 对它们自动生效）。
  - 奇趣 / 日刻接口 Worker：守卫（entry / music）与写门槛（requireScope / requireAccount）在旧会话不够时经网关 `SpaceVerifier.admit(cookie, method, path, {action}?)` 问；有 v6 身份但档不够 → 403 `forbidden`，没有 → 照旧 401。`album.del`（root）按 op 再问一次；公开读的私密行 / canWrite 按路由表新加的 action `private`（= 本站写组）。
  - `AccountVerifier.admit` 收 action：路由必须真列了这个 action 才按它判（`levelOf` 对没有 actions 的路由会退回路由档，RPC 这里不许退），回答带回 action，调用方核对（旧版本不认 action 时不会被当成 action 的结论）。
- root 的特权内容操作留痕：奇趣导出 / 导入（`export` / `import`）、删整张专辑 / 整个专题（`rm-bulk`）、分享新建 / 作废（`share`）经 `AccountVerifier.auditRoot` 写 `account_user_audit`（账号侧重新判会话，只认真 root 层、救援不算，命令字白名单）；应用授权 `app allow|deny`、代理订阅 `sub <action>` 在账号 Worker 直接写（sudo 记真正执行的人 + `via sudo`）。
- 新旧并存：旧会话的判定与规则原样（有旧会话够用时不问 v6）；旧 `sudo styrigx` / `sudo root` / `sudo -v` 都还在，P4 删。

## 3. 分阶段（分步割接，不是兼容层）

新旧并存跑、救援跑通再删旧；不做新旧格式互转，不加开关。

| 阶段 | 内容 |
|---|---|
| P1 | 新表；迁移对照表与脚本（不写生产）；组模型与集中权限判断；路由盘点表；admit 新路径与旧路径并存（网关在请求带新会话 cookie、旧进站会话不成立时问 `AccountVerifier.admit`）；epoch bump；审计；STEPUP / APP 映射；本 ADR。旧入口、旧会话、旧命令不动 |
| P2 | su、sudo、exit、lock、useradd / userdel / usermod / passwd <名>、groups、who；身份栈；前台空闲计时；头像 = whoami；接口改认新结论 |
| P3 | 绑定 `SGX_ACCOUNT_RESCUE_KEY`（Gray 已在 Store 建好）+ 救援入口 `rescue`；端到端跑通（含真机） |
| P4 | P3 合并后直接做，不设观察期（定稿 v5.5 §十三）：删分享短链（任其失效）、站点核心进站签发、STEPUP、sudo root reauth、sudo -v、lock passwd / passkey、旧恢复钥匙、旧 pepper、两对签名钥匙、旧账号会话；收尾：应用授权整套删、旧校验收尾、旧 space-core 8 张表与 share_link / share_fail / account_grant、数字健康整套删除、不再使用的文案删除、v5 旧文档加取代标注 |
| 2g | P4 之后：sessions 设备列与 `sgx-device` 设备标记、设备列表全站视图、子站认 sudo 借来的 root（定稿 v5.5 §十三） |

回滚：每段单独 PR；P4 前在 dashboard 演练一次重部署上一版 Worker，作为最后手段。外观改动先截图给 Gray 批；不 force-push。

## 4. 实施记录

| 日期 | 变更 | PR |
|---|---|---|
| 2026-11-11 | P1：身份表、组与路由盘点、admit 新路径、epoch、审计、迁移脚本与对照表、STEPUP / APP 映射；路由盘点 17 条存疑 Gray 定稿（`GET /curio/api/export` 改 root）；§2.12 P2 硬要求 | #395 |
| 2026-11-11 | P2a：permits 三步顺序（救援 → root → 档）、owner 档（名片 PUT）、`/api/identity`（su / sudo / exit / idle / lock / passwd / passkey / groups / who / useradd / userdel / usermod / passwd <名>）、身份栈写操作、两维限流、防枚举、pepper 绑定、数据按 uid（迁移待批）；§2.13 | P2a |
| 2026-11-11 | P2b：身份命令进全站终端、提示符与头像跟 v6 身份 | #398 |
| 2026-11-11 | P2c：名片 GET 公开、sudo 借 root 执行账号 Worker 内任一接口、到期满 30 天自动删除（墓碑、uid 不复用）、root 特权内容操作审计、admit 先拒未知档；§2.14 | P2c |
| 2026-11-11 | P3：账号 Worker 绑定 `SGX_ACCOUNT_RESCUE_KEY`；`POST /api/identity` action `rescue`（读 Store 恒定时间比对 → 15 分钟一次性 root 救援会话；`account_recovery_key` 记指纹、同值复用拒、指纹写失败拒；单独限流 + 审计）；终端 `rescue`；§2.8 改为与定稿 v5.2 §九一致（Secrets Store，删「未决」） | P3 |
| 2026-11-11 | 割接：访客入口改 su（头像 / 盾牌 / 上锁处预填 `su `）、su 的提示 `Password:`；网关 / 账号 / 奇趣 / 日刻其余路由接 v6 会话（admit 带 action、`private` action）、root 特权内容操作经 `auditRoot` 留痕；§2.15 | 割接 |
| 2026-11-11 | P4 前端删旧：分享短链 / 分享磁贴、进站签发、旧账号会话与旧账号指令 | #409 |
| 2026-11-11 | P4 后端删除：旧进站 / 分享 / 旧账号会话 | #410 |
| 2026-11-11 | P4 收尾：应用授权整套删除、旧校验收尾（`conclusion()`）、旧进站 8 张表与一次性迁移脚本删除 | #411 |
| 2026-11-11 | P4-2：数字健康整套删除（上报、接口、展示、`/wellbeing/` 跳转；drop SQL `docs/ops/v6-p4-drop-wellbeing.sql`）、应用授权前端残留、不再使用的文案、文档对齐定稿 v5.5 | P4-2 |

## 5. 后果

5.1 正面：一个签发者、一把恢复钥匙、一套复验（sudo）；权限可按人收放（组 + 期限），取代分享短链；会话可即时吊销（D1 行 + epoch）。

5.2 代价：Gray 要记两套凭据（styrigx、root）；分享从「一键链接」变成 `useradd` + 线下发一次性密码；P1–P3 期间新旧两套并存，代码量暂时增加。
