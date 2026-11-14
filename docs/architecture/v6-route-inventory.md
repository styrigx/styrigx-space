# v6 路由全量盘点（P1 交付物）

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SPEC-004 |
| 版本 | 0.5 |
| 日期 | 2026-11-11 |
| 状态 | 已定（v6 P1，Gray 2026-11-11 定稿 17 条存疑；P2 改名片 PUT 档、加 /api/identity；割接加 action private、其余 Worker 接 v6；P4 删旧入口 20 条；P4 收尾删应用授权；P4-2 删数字健康两条） |


> 状态：P1 定稿（2026-11-11，Gray 已定 17 条存疑），基线 main 05abe443。机器可读的唯一来源是 `workers/account/src/core/route-access.js` 的 `ROUTE_ACCESS`；
> 本页由它生成，`tests/workers/account/identity-route-access.test.mjs` 核对两边一致、并核对每个 Worker 的路由表都在表里（漏一条 CI 红）。
> 相关：ADR-0006（v6 身份统一）、`docs/architecture/v6-identity-migration.md`。

## 规则

1. 档（`core/groups.js` `ACCESS_LEVELS`）：**public**（谁都行）/ **user**（任一已登录身份，含无组的临时用户）/ **组名**（wheel、sudoers、listen、ai、status、curio-write、daymark-write）/ **webmaster**（站长 = styrigx 的 uid，P2）/ **root**。判断全站只有一处：`core/groups.js` `permits()`，顺序固定（P2，定稿 v4 §三）：① 救援会话只放标了「救援可用」的路由 / action，其余一律拒、不往下走；② root 一律放行；③ 按档。
8. 救援白名单：路由标「救援可用」；一条路由多个 action 的，只放列出的那几个（`rescueActions`，判断用 `rescueOf()`）。
2. 未列入的接口一律拒绝（fail closed）；页面与静态文件（不在 `/api/`、`/<子站>/api/` 下）一律 public，不进表。
3. 路径参数只有两种：`/s/:token/:source`（代理主机，两段 = 代理订阅）、`/avatar/:file`。主站 `/s/:code`（一段 = 分享短链）v6 P4 删除，两段的代理订阅不受影响。
4. 一个接口多个 action 的，「档」是进接口的最低一档，「action 另定」列出更高的档，由接口读完 body 后按同一张表判断。网关 admit 只看路由这一档。
5. 删除两级：**单条内容删除归写组**；**批量 / 结构删除只属 root**。
6. 原来要再验证（sudo -v、sudo root reauth、账号复验）的操作 → v6 **sudo 每次重验 = root 档**。
7. 「去向」写着 P3 / P4 的是割接后要删的旧入口：P1–P3 照旧按老规则跑（旧会话判定不变），表里写的是**新会话**的档。
9. **private**（割接）：公开读接口里的私密行与 canWrite 提示。GET 的档是 public（谁都能读公开部分），「action 另定」里的 `private` 是能看私密行的那一档（= 本站写组）；子站接口 Worker 读完路由后按 action `private` 问 admit，不自己比组。

## 摘要

| 档 | 路由数 |
|---|---|
| public | 24 |
| user | 5 |
| ai | 2 |
| status | 1 |
| listen | 3 |
| curio-write | 8 |
| daymark-write | 6 |
| webmaster | 1 |
| root | 5 |
| **合计** | **55**（另有 11 个只经服务绑定 / RPC 的入口；P2c 加 AccountJanitor，P4 删 ShareJanitor） |

按 Worker：站点核心 6、账号 11、奇趣 20、日刻 13、代理 6（P4 删旧入口 20 条、应用授权与数字健康之后）。有 action 另定档的接口 11 个（curio music、identity；割接加的 `private`：curio items / links / movies / photo / icon / music、daymark quotes / collections 的 GET；2c 加 `POST /api/ai` 的 `private`）。

P2 变更（2026-11-11）：`PUT /api/profile` root → **webmaster**（站长 styrigx + root，其余拒）；新增 `POST /api/identity`（v6 身份命令，public 入口，每个 action 一档，救援只放 whoami / exit / lock / passwd / passkey-* / groups）。

P2c 变更（2026-11-11，对齐定稿 v5）：
- `GET /api/profile` 真正公开：账号 Worker 不再要进站 / v6 会话，网关访问表（`workers/space-core/src/gate.js`）与账号 `PUBLIC_API` 都加了这一条；只回名片四项 + 头像版本号 + 时间。档本来就是 public，表不变。
- `sudo`（`POST /api/identity` action `sudo`）的 `command` 可以是 `{ method, path, body? }`：借 root 执行**账号 Worker 内**任何一条表里的接口（`api/sudo-route.js`）。拒绝：`/api/identity` 本身、`/api/account/keys` 与 `/api/account/reset`（root 凭据，403 root-creds）、`/api/account/session` 与 `/api/account/reauth`（旧登录 / 复验票）。别的 Worker 的接口 sudo 够不到（400 not-here）。
- 新的只经服务绑定入口 `AccountJanitor.purgeExpiredUsers`（到期满 30 天自动删除，styrigx-status 每日一轮经 JOB_ACCOUNT 调）。

割接变更（2026-11-11，ADR-0006 §2.15）：
- 档不变；奇趣 / 日刻公开读的 8 个 GET 加 action `private`（= curio-write / daymark-write，见规则 9）。
- 新会话从此在这些接口真正生效（之前网关 admit 放进门、接口仍只认旧会话）：`/api/share`、`/api/space-audit`（root）；`/api/account/grants`、`/api/account/proxy`（root，sudo 也能借）；奇趣全部写接口（curio-write）、`export` / `import`（root）、music `album.del`（root）、听歌（listen）；日刻全部写接口（daymark-write）、`DELETE collections`（root）。
- `AccountVerifier.admit(cookie, method, path, { action })`：路由列了这个 action 才按它判，回答带回 action；子站经网关 `SpaceVerifier.admit` 转来。root 的特权内容操作经 `AccountVerifier.auditRoot` 留痕（`rm-bulk` / `import` / `export` / `share`）。
- 旧会话（进站会话 / 账号会话 + 作用域）照旧并存，P4 删。

2b 变更（2026-11-11，割接后续；档不变）：
- 页面状态 `data-sgx-lock-session`：旧进站会话有效，**或** v6 新会话有效 → `valid`（网关 `gate.js pageStateOf`；v6 判定经 `AccountVerifier.admit` 问 `GET /api/prefs` 这条 user 档路由，救援会话不算）。云同步、名片等只在 valid 页面跑的逻辑对纯 v6 登录照常跑。
- 网关关口、`/api/share`、`/api/status`、`/api/ai`、`/api/space-audit`：有 v6 身份但档不够 → **403 forbidden**（同子站接口 Worker）；没有身份仍 401。`/api/status`（status）、`/api/ai`（ai）接口本身也认 v6（之前只认旧进站会话）。

2c 变更（2026-11-11，割接后续；路由档不变）：
- `POST /api/ai` 加 action `private` = **webmaster**（站长 styrigx + root，permits 第 2 步放行 root）：AI 回答召回私密条目、能切模型。网关 `api/ai.js aiConclusionHeaders` 先按 v6 问这一条（`core/identity-admit.js AI_PRIVATE` / `v6AiPrivate`），够就只写 `X-Styrigx-Account-Session: 1`；不够回退旧账号会话（P4 删）。`GET /api/ai`（模型列表的 canChoose）问同一条，与 POST 一致。私密内容跨奇趣 / 日刻 / 博客，对应旧「账号会话」（= 站长本人），所以定 webmaster 而不是某一个写组。
- 前端：当前页 `su` 成功（含 su 成任何 v6 用户）→ 页面标记就地切成 `valid`（终端身份 `who.onV6` → 顶栏 `switchPageSession`，发 window `sgx:session { ok, live: true }`），云同步强制拉一次、名片重取、AI 窗口解锁、服务状态卡重取、NAVIGATE STATUS 重取、守卫补绑自动回锁；`exit` / `lock` 回访客（或只剩救援会话）就地切回 `locked`。不整页刷新。规则同网关 `pageStateOf`（旧进站会话或非救援 v6 身份）。
- 奇趣 / 日刻「登录账号后可编辑」改「su 登录后可编辑」（中英文），入口改成 `su`（`data-sec-open`，打开终端预填 su ）。

P3 变更（2026-11-11，定稿 v5.2 §九；路由档不变）：
- `POST /api/identity` 加 action `rescue` = **public**（访客的救援入口；已登录 → 409 exit-first；救援会话里再调 → permits 第 1 步拒）：输恢复钥匙，账号 Worker 读 Secrets Store `SGX_ACCOUNT_RESCUE_KEY` 恒定时间比对，通过签 15 分钟一次性 root 会话（rescue 标志、不续期）；`account_recovery_key` 记钥匙指纹（SHA-256，不存明文），同值再用直接拒，指纹写失败拒绝救援。救援白名单不变（whoami / exit / lock / passwd / passkey-* / groups），`rescue` 不在其中。

2d 变更（2026-11-11，割接后续；路由档不变）：
- 前端终端 `sub`、`app`（`POST /api/account/proxy`、`/api/account/grants`，root 档）接 v6：v6 root 直接做（不看旧账号会话、不跑旧 `sudo root reauth`）；v6 普通用户提示「当前用户没有这个权限 · 先 su root」；访客（所有要身份的命令）提示「没有登录 · 先 su <用户>」。旧会话路径不变（P4 删）。
- 奇趣 / 日刻 / 博客的全站终端挂 v6 身份层（su / su root / sudo / exit / lock / whoami …），同主站。

2e 变更（2026-11-11，割接后续；路由档不变，服务端不改）：
- 前端终端 `passkey` / `passkey ls` / `passkey add` / `passkey rm <n>` 接 v6：有 v6 会话（普通用户 / su root / 救援）→ `POST /api/identity` 的 `passkey-list` / `passkey-add-challenge` / `passkey-add` / `passkey-delete`（user 档，按服务端会话 uid 管栈顶那个用户自己的；定稿 v5.2 §八、§九白名单）；不要 root、不跑旧 `sudo root reauth`。`sudo passkey …` 前端直接回 rootCreds（服务端 sudo 本来就回 403 root-creds，定稿 §十）。旧会话路径不变（P4 删）。

P4 变更（2026-11-11，定稿 v5.3 §十三 P4 行）：删旧入口 20 条——进站接口 `lock-now`（GET / POST）、`lock-entry`、`lock-session-check`、`lock-password`、`lock-passkey`、`lock-credentials`、`lock-reauth`、`lock-all-devices`、`lock-reset`、`space-auth`；分享短链 `/s/:code`（GET / HEAD）与 `/api/share`（GET / POST）；旧账号会话 `GET /api/account`、`/api/account/session`、`/api/account/reauth`、`/api/account/reset`、`/api/account/keys`。`/s/` 只剩代理主机两段的订阅。`GET /api/space-audit` 保留（档 root 不变）。只经服务绑定的入口删 `AccountVerifier.authorize`、`SpaceVerifier.session`、`ShareJanitor.purgeShareLinks`。下文 P1–2e 各节与「已定」一节的旧路由是当时的记录。

P4-3 变更（2026-11-11，定稿 v5.5 §五、§七）：`PUT` / `DELETE /api/avatar`、`POST /api/prefs` user → **webmaster**（全站一份配置，归站长，读写都落到 styrigx 那份）；`POST /api/identity` 的 `passkey-*` user → **webmaster**；`POST /api/account/devices` user → **webmaster**（`list` webmaster 站长直读、`revoke` / `revoke-all` root，站长 `sudo device rm …`），列表改为全站视图并按 2g 设备标记 `sgx-device` 合并同一台设备。路由数不变。

2026-11-12：`POST /api/identity` 的 `passwd` / `passkey-*` 加身份核对——请求的 `as`（uid）和服务端认定的不一致 → 409 `identity`（带 `user` 和 `lapsed`：`timeout` / `gone` / 空），不执行。档位与路由数不变。

P4 收尾（2026-11-11，定稿 v5.3 §十二，Gray 19:41）：应用授权整套删除——`POST /api/account/grants`（app allow | deny）删去（58 → 57 条，root 6 → 5）；奇趣 / 日刻写入只按 v6 会话加组判定，`SpaceVerifier.conclusion()` 一并删除。

档名改名（2026-11-12，Gray）：站长档 `owner` 改名 **webmaster**（root 管系统，webmaster 拥有这个站）；本表与 `ROUTE_ACCESS` 一起换，whoami 的 `owner` 字段同改 `webmaster`，userdel 保护站长的 403 回 `target: webmaster`。各档条数、权限不变。

P4-2（2026-11-11，定稿 v5.5 §四、§五）：数字健康整套删除——`POST /api/wellbeing`、`GET /api/wellbeing` 删去（57 → 55 条，public 25 → 24、user 6 → 5），网关访问表与账号 `PUBLIC_API` 的 `GET /api/wellbeing`、转发表 `/api/wellbeing` 一并删；无身份访问 `/api/wellbeing` 现按未列入的 `/api/*` 处理。

### 已定（Gray 2026-11-11）

盘点时拿不准的 17 条，Gray 2026-11-11 定稿；表里「已定」列与 `ROUTE_ACCESS` 的 `decided` 字段一致（P4 删 `lock-all-devices` 后剩 16 条，P4-2 删数字健康两条后剩 14 条）。改了档的两处：P1 `GET /curio/api/export` 由 curio-write 改为 **root**；P2（定稿 v4）`PUT /api/profile` 由 root 改为 **webmaster** = 站长（styrigx）+ root（root 由 permits 放行），其余一律拒。其余按原拟定值定稿。

| 路由 | 定稿 | 理由 |
|---|---|---|
| `POST /api/account/devices` | user → **webmaster**（P4-3：list webmaster、revoke / revoke-all root） | P2：管自己的会话；P4-3 按定稿 v5.5 §五 / §七改为后台控制、全站视图 |
| `POST /api/account/proxy` | root | 全放 root，不加新组 |
| `PUT` / `DELETE /api/avatar` | user → **webmaster**（P4-3） | P2 按 uid 分；P4-3 按定稿 v5.5 §五 / §七改为一份配置、写入 webmaster |
| `GET /api/profile` | public | 资料本身是公开数据（主页名片） |
| `PUT /api/profile` | **webmaster**（P2 定稿 v4；P1 为 root） | 站长（styrigx）+ root（root 由 permits 放行），其余一律拒；名片只有一份，属于站长 |
| `GET` / `POST /api/prefs` | user；POST → **webmaster**（P4-3） | P2 加 uid；P4-3 按定稿 v5.5 §五 / §七改为一份配置、写入 webmaster，普通用户只能看 |
| `GET /curio/api/items` / `links` / `movies` | public | 私密行只给写组 curio-write |
| `GET /curio/api/export` | **root**（原拟 curio-write） | 导出全部收藏含私密 |
| `GET /daymark/api/quotes` | public | 私密句子只给写组 daymark-write |
| `DELETE /daymark/api/collections` | root | 删整个专题 = 结构删除 |

user 档的硬要求（ADR-0006 · P2）：所有 user 档 handler 的 uid 只取服务端会话，绝不取客户端参数 / 请求体；P2 每条 user 路由都要有「传他人 uid 被拒 / 被忽略」的测试。

另外两处定义性偏离：多了一档 **user**（定稿只写 public / 组名 / root；无组的临时用户也要能 passwd 改自己的密码、读自己的会话，不加这一档就只能给它一个组）；`/api/account/session` 的登录 action 记为 **wheel**（它就是 v5 的 `sudo root`，v6 = `su root`）。

## 全表

### 站点核心 styrigx-space-core（网关自己的接口、分享短链）

| 方法 | 路径 | 档 | action 另定 | 删除 | 去向 | 说明 | 已定 |
|---|---|---|---|---|---|---|---|
| POST | `/api/ai` | **ai** | `private` → webmaster |  | 保留 | AI 对话（转 styrigx-ai /ask）；私密召回与切模型只给 webmaster（2c） |  |
| GET | `/api/ai` | **ai** |  |  | 保留 | AI 可选模型列表（转 styrigx-ai /models） |  |
| GET | `/api/find` | **public** |  |  | 保留 | 关键词搜索，只回公开页面元数据（IP 限流） |  |
| GET | `/api/geo` | **public** |  |  | 保留 | 只回调用者自己的城市 / 时区 |  |
| GET | `/api/status` | **status** |  |  | 保留 | 状态页 / 监测页（转 styrigx-status /summary） |  |
| GET | `/api/space-audit` | **root** |  |  | 保留 | 进站凭证使用审计（含 IP 前缀） |  |

### 账号 styrigx-account（经网关 FORWARDING 转发）

| 方法 | 路径 | 档 | action 另定 | 删除 | 去向 | 说明 | 已定 |
|---|---|---|---|---|---|---|---|
| POST | `/api/identity` | **public**（救援可用：`whoami`、`exit`、`lock`、`passwd`、`passkey-*`、`groups`） | `passwd` / `groups` / `who` → user；`passkey-list` / `passkey-add-challenge` / `passkey-add` / `passkey-delete` → webmaster（P4-3）；`sudo-challenge` / `sudo` → sudoers；`useradd` / `userdel` / `usermod` / `passwd-user` → root；`whoami` / `su-challenge` / `su` / `exit` / `idle` / `lock` / `rescue` → public |  | 保留（P2 新增） | v6 身份命令：whoami / su / sudo / exit / lock / passwd / passkey / groups / who / useradd / userdel / usermod / passwd <名>；P3 救援入口 rescue |  |
| POST | `/api/account/devices` | **webmaster** | `list` → webmaster；`revoke` / `revoke-all` → root（P4-3） |  | 保留 | 设备会话（全站视图：列出全站会话，2g 按 sgx-device 合并同一台设备） | 定稿 v5.5 §五：列表与踢出属后台控制，root 档（站长 sudo），列表为全站视图；§七：站长打开账号页时设备卡列表直接可读 → list webmaster、revoke / revoke-all root |
| POST | `/api/account/proxy` | **root** |  |  | 保留 | 代理订阅管理 sub（转 styrigx-proxy ProxyAdmin；含令牌、age 公钥） | Gray 2026-11-11 定 root，不加新组 |
| PUT | `/api/avatar` | **webmaster** |  |  | 保留 | 换站点头像（全站一份配置，归站长 styrigx） | 定稿 v5.5 §五：avatar、prefs 写入 webmaster（站长 + root）；§七：全站只有一份配置 |
| DELETE | `/api/avatar` | **webmaster** |  | 单条 → 写组 | 保留 | 删站点头像（回默认） | 定稿 v5.5 §五：同上 |
| GET | `/avatar/:file` | **public** |  |  | 保留 | 头像图片（页面路径） |  |
| GET | `/api/profile` | **public** |  |  | 保留 | 站点个人资料（公开数据） | Gray 2026-11-11 定 public：资料是公开数据（KV_PROFILE 只放公开数据） |
| PUT | `/api/profile` | **webmaster** |  |  | 保留 | 改站点个人资料（站长资料，不是每个用户一份） | Gray 2026-11-11 定稿 v4：站长（styrigx）+ root（root 由 permits 放行），其余一律拒；名片只有一份，属于站长 |
| GET | `/api/prefs` | **user** |  |  | 保留 | 读设置云同步（全站一份配置，归站长 styrigx；普通用户只能看） | Gray 2026-11-11 定 user：P2 加 uid（uid 只取服务端会话） |
| POST | `/api/prefs` | **webmaster** |  |  | 保留 | 写设置云同步（全站一份配置） | 定稿 v5.5 §五：avatar、prefs 写入 webmaster（站长 + root） |

### 奇趣接口 styrigx-curio-core（styrigx.com/curio/api/*，不经网关）

| 方法 | 路径 | 档 | action 另定 | 删除 | 去向 | 说明 | 已定 |
|---|---|---|---|---|---|---|---|
| GET | `/curio/api/items` | **public** | `private` → curio-write |  | 保留 | 设备 / 游戏列表（私密行只给 curio-write，见 decided） | Gray 2026-11-11 定 public：私密行只给 curio-write |
| POST | `/curio/api/items` | **curio-write** |  | 单条 → 写组 | 保留 | device.* / game.*：add / edit / order；del 是单条 |  |
| GET | `/curio/api/links` | **public** | `private` → curio-write |  | 保留 | 收藏列表（私密行同上） | Gray 2026-11-11 定 public：私密行只给 curio-write |
| POST | `/curio/api/links` | **curio-write** |  | 单条 → 写组 | 保留 | cat.* / link.*；link.del 单条；cat.del 只删空分类（非空 409），按单条算 |  |
| GET | `/curio/api/movies` | **public** | `private` → curio-write |  | 保留 | 电影列表 | Gray 2026-11-11 定 public：私密行只给 curio-write |
| POST | `/curio/api/movies` | **curio-write** |  | 单条 → 写组 | 保留 | movie.add / edit / del（单条） |  |
| GET | `/curio/api/photo` | **public** | `private` → curio-write |  | 保留 | 设备照片 / 海报（私密设备的照片只给 curio-write） |  |
| POST | `/curio/api/photo` | **curio-write** |  |  | 保留 | 上传照片 / 海报 |  |
| DELETE | `/curio/api/photo` | **curio-write** |  | 单条 → 写组 | 保留 | 删一张照片 |  |
| GET | `/curio/api/icon` | **public** | `private` → curio-write |  | 保留 | 网站图标缓存（私密收藏的图标只给 curio-write） |  |
| GET | `/curio/api/preview` | **curio-write** |  |  | 保留 | 添加收藏时抓标题 / 图标（算在写里） |  |
| GET | `/curio/api/export` | **root** |  |  | 保留 | 导出全部收藏（含私密） | Gray 2026-11-11 定 root：导出全部收藏含私密 |
| POST | `/curio/api/import` | **root** |  |  | 保留 | 批量导入书签（v5 要账号复验 → v6 sudo 每次重验 = root） |  |
| GET | `/curio/api/music` | **public** | `private` → curio-write |  | 保留 | 歌单（不含音频地址；canWrite 提示给 curio-write） |  |
| POST | `/curio/api/music` | **curio-write** | `album.del` → root | 单条 → 写组 | 保留 | album.add / edit、track.edit / del（单条）；album.del 连曲目一起删 = 结构删除 |  |
| GET | `/curio/api/music-cover` | **public** |  |  | 保留 | 专辑封面 |  |
| POST | `/curio/api/music-play` | **listen** |  |  | 保留 | 签播放令牌（听歌） |  |
| GET | `/curio/api/music-stream` | **listen** |  |  | 保留 | 取音频（令牌 + Range） |  |
| HEAD | `/curio/api/music-stream` | **listen** |  |  | 保留 | 同上 |  |
| POST | `/curio/api/music-upload` | **curio-write** |  |  | 保留 | 上传音轨 / 封面 |  |

### 日刻接口 styrigx-daymark-core（styrigx.com/daymark/api/*，不经网关）

| 方法 | 路径 | 档 | action 另定 | 删除 | 去向 | 说明 | 已定 |
|---|---|---|---|---|---|---|---|
| GET | `/daymark/api/today` | **public** |  |  | 保留 | 今日一句（首页 / 锁屏跨站读） |  |
| HEAD | `/daymark/api/today` | **public** |  |  | 保留 | 同上 |  |
| OPTIONS | `/daymark/api/today` | **public** |  |  | 保留 | CORS 预检 |  |
| PUT | `/daymark/api/today` | **daymark-write** |  |  | 保留 | 设为今日 |  |
| GET | `/daymark/api/quotes` | **public** | `private` → daymark-write |  | 保留 | 句子列表（私密句子只给 daymark-write，见 decided） | Gray 2026-11-11 定 public：私密句子只给 daymark-write |
| POST | `/daymark/api/quotes` | **daymark-write** |  |  | 保留 | 新增句子 |  |
| PUT | `/daymark/api/quotes` | **daymark-write** |  |  | 保留 | 改句子 |  |
| DELETE | `/daymark/api/quotes` | **daymark-write** |  | 单条 → 写组 | 保留 | 删一句（日记条目） |  |
| GET | `/daymark/api/collections` | **public** | `private` → daymark-write |  | 保留 | 百味专题列表（含私密句子的部分只给 daymark-write） |  |
| POST | `/daymark/api/collections` | **daymark-write** |  |  | 保留 | 新建专题 |  |
| PUT | `/daymark/api/collections` | **daymark-write** |  |  | 保留 | 改专题 / 重排专题里的句子 |  |
| DELETE | `/daymark/api/collections` | **root** |  | 结构 → root | 保留 | 删整个专题（句子本身不删）= 结构删除 | Gray 2026-11-11 定 root：删整个专题 = 结构删除 |
| GET | `/daymark/api/days` | **public** |  |  | 保留 | 按日浏览 |  |

### 代理订阅 / 规则集 styrigx-proxy（proxy.styrigx.com，不经网关）

| 方法 | 路径 | 档 | action 另定 | 删除 | 去向 | 说明 | 已定 |
|---|---|---|---|---|---|---|---|
| GET | `/s/:token/:source` | **public** |  |  | 保留 | 代理订阅下载：令牌 + age 密文就是凭证（两段，保留） |  |
| HEAD | `/s/:token/:source` | **public** |  |  | 保留 | 同上 |  |
| GET | `/:rules` | **public** |  |  | 保留 | 规则集反代（core/sources.js 白名单里的来源路径） |  |
| HEAD | `/:rules` | **public** |  |  | 保留 | 同上 |  |
| GET | `/healthz` | **public** |  |  | 保留 | 健康检查（任意方法 200；styrigx-status 每分钟测） |  |
| GET | `/` | **public** |  |  | 保留 | 同上 |  |

### 只经服务绑定 / RPC（不进访问表，门在调用方）

| Worker | 入口 | 调用方 | 说明 |
|---|---|---|---|
| ai | `POST /ask` | space-core POST /api/ai（AI_SERVICE） | 回答本身；门在网关（ai 组） |
| ai | `GET /find` | space-core GET /api/find | 关键词搜索（公开） |
| ai | `GET /models` | space-core GET /api/ai | 模型列表（ai 组） |
| ai | `GET /healthz` | styrigx-status 监测 | 健康检查 |
| status | `GET /summary` | space-core GET /api/status（STATUS） | 监测数据（status 组） |
| account | `AccountService.fetch` | space-core FORWARDING（ACCOUNT） | 上表 /api/account*、/api/avatar*、/api/profile、/api/prefs、/api/identity、/avatar/* |
| account | `AccountVerifier.admit / auditRoot` | space-core（ACCOUNT_VERIFIER） | v6 会话判定（只读）/ root 特权操作留痕（v6 P4 起 authorize 删除） |
| space-core | `SpaceVerifier.admit / auditRoot` | curio-core、daymark-core（SPACE） | admit / auditRoot 原样转给账号 Worker（v6 P4 起 session、ShareJanitor、conclusion 删除） |
| account | `AccountJanitor.purgeExpiredUsers` | styrigx-status 每日一轮（JOB_ACCOUNT） | 到期满 30 天的用户自动删除（v6 P2c，定稿 v5 §八） |
| proxy-rules | `ProxyAdmin.*` | account POST /api/account/proxy（PROXY） | 代理订阅管理（root 档在调用方） |
| curio-core / daymark-core / ai | `HourlyJob.run` | styrigx-status 每小时一轮 | 搜索索引 / 照片清理等定时任务 |
