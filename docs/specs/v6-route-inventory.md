# v6 路由全量盘点（P1 交付物）

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SPEC-004 |
| 版本 | 0.3 |
| 日期 | 2026-11-11 |
| 状态 | 已定（v6 P1，Gray 2026-11-11 定稿 17 条存疑；P2 改名片 PUT 档、加 /api/identity） |


> 状态：P1 定稿（2026-11-11，Gray 已定 17 条存疑），基线 main 05abe443。机器可读的唯一来源是 `workers/account/src/core/route-access.js` 的 `ROUTE_ACCESS`；
> 本页由它生成，`tests/workers/account/identity-route-access.test.mjs` 核对两边一致、并核对每个 Worker 的路由表都在表里（漏一条 CI 红）。
> 相关：ADR-0006（v6 身份统一）、`docs/specs/v6-identity-migration.md`、`docs/specs/v6-stepup-app-map.md`。

## 规则

1. 档（`core/groups.js` `ACCESS_LEVELS`）：**public**（谁都行）/ **user**（任一已登录身份，含无组的临时用户）/ **组名**（wheel、sudoers、listen、ai、status、curio-write、daymark-write）/ **owner**（站长 = styrigx 的 uid，P2）/ **root**。判断全站只有一处：`core/groups.js` `permits()`，顺序固定（P2，定稿 v4 §三）：① 救援会话只放标了「救援可用」的路由 / action，其余一律拒、不往下走；② root 一律放行；③ 按档。
8. 救援白名单：路由标「救援可用」；一条路由多个 action 的，只放列出的那几个（`rescueActions`，判断用 `rescueOf()`）。
2. 未列入的接口一律拒绝（fail closed）；页面与静态文件（不在 `/api/`、`/<子站>/api/` 下）一律 public，不进表。
3. 路径参数只有三种：`/s/:code`（主站，一段 = 分享短链）、`/s/:token/:source`（代理主机，两段 = 代理订阅）、`/avatar/:file`。**/s/ 一段与两段分开列**：P4 删分享只动一段的那两行，两段的代理订阅不受影响。
4. 一个接口多个 action 的，「档」是进接口的最低一档，「action 另定」列出更高的档，由接口读完 body 后按同一张表判断。网关 admit 只看路由这一档。
5. 删除两级：**单条内容删除归写组**；**批量 / 结构删除只属 root**。
6. 原来要再验证（sudo -v、sudo root reauth、账号复验）的操作 → v6 **sudo 每次重验 = root 档**。
7. 「去向」写着 P3 / P4 的是割接后要删的旧入口：P1–P3 照旧按老规则跑（旧会话判定不变），表里写的是**新会话**的档。

## 摘要

| 档 | 路由数 |
|---|---|
| public | 38 |
| user | 9 |
| ai | 2 |
| status | 1 |
| listen | 3 |
| curio-write | 8 |
| daymark-write | 6 |
| owner | 1 |
| root | 10 |
| **合计** | **78**（另有 11 个只经服务绑定 / RPC 的入口） |

按 Worker：站点核心 21、账号 18、奇趣 20、日刻 13、代理 6。割接后要删的旧入口 20 条（P3 / P4）。有 action 另定档的接口 6 个（lock-password、lock-passkey、account/session、account/reset、curio music、identity）。

P2 变更（2026-11-11）：`PUT /api/profile` root → **owner**（站长 styrigx + root，其余拒）；新增 `POST /api/identity`（v6 身份命令，public 入口，每个 action 一档，救援只放 whoami / exit / lock / passwd / passkey-* / groups）。

### 已定（Gray 2026-11-11）

盘点时拿不准的 17 条，Gray 2026-11-11 定稿；表里「已定」列与 `ROUTE_ACCESS` 的 `decided` 字段一致。只有一处改了档：`GET /curio/api/export` 由 curio-write 改为 **root**；其余按原拟定值定稿。

| 路由 | 定稿 | 理由 |
|---|---|---|
| `POST /api/lock-all-devices` | user | v6 只作废自己的会话，不保留复验 |
| `POST /api/account/devices` | user | 管自己的会话；root 看全部由 who 做（P2） |
| `POST /api/account/proxy` | root | 全放 root，不加新组 |
| `PUT` / `DELETE /api/avatar` | user | P2 按 uid 分 |
| `GET /api/profile` | public | 资料本身是公开数据（主页名片） |
| `PUT /api/profile` | **owner**（P2 定稿 v4；P1 为 root） | 站长（styrigx）+ root（root 由 permits 放行），其余一律拒；名片只有一份，属于站长 |
| `GET` / `POST /api/prefs` | user | P2 加 uid |
| `POST /api/wellbeing` | user | P2 加 uid 列 |
| `GET /api/wellbeing` | public | 合计公开；明细只给本人（按 uid，不按组） |
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
| POST | `/api/ai` | **ai** |  |  | 保留 | AI 对话（转 styrigx-ai /ask） |  |
| GET | `/api/ai` | **ai** |  |  | 保留 | AI 可选模型列表（转 styrigx-ai /models） |  |
| GET | `/api/find` | **public** |  |  | 保留 | 关键词搜索，只回公开页面元数据（IP 限流） |  |
| GET | `/api/geo` | **public** |  |  | 保留 | 只回调用者自己的城市 / 时区 |  |
| GET | `/api/status` | **status** |  |  | 保留 | 旷野状态卡 / 监测页（转 styrigx-status /summary） |  |
| GET | `/api/space-audit` | **root** |  |  | P4（审计并入 account_user_audit） | 进站凭证使用审计（含 IP 前缀） |  |
| POST | `/api/lock-now` | **public** |  |  | P4（v6 lock 清栈并删服务端会话行） | 只清本机会话（幂等、不验证） |  |
| GET | `/api/lock-now` | **public** |  |  | P4 | 只回 405（立即锁定只收 POST） |  |
| GET | `/api/lock-entry` | **public** |  |  | P4 | 锁屏问设了哪些进站凭证（只回布尔） |  |
| GET | `/api/lock-session-check` | **public** |  |  | P4 | 前端问「进站了吗」；v6 由 whoami / GET /api/account 取代 |  |
| POST | `/api/lock-password` | **public** | `set` → user；`change` → user；`remove` → user |  | P4（v6：su styrigx / passwd） | 进站密码：verify 公开（登录）；set / change / remove 改的是 styrigx 自己的密码 |  |
| POST | `/api/lock-passkey` | **public** | `register` → user；`list` → user；`rename` → user；`delete` → user |  | P4（v6：su styrigx / passkey） | 进站通行密钥：challenge / auth 公开（登录）；增删改列的是 styrigx 自己的通行密钥 |  |
| GET | `/api/lock-credentials` | **user**（救援可用） |  |  | P4 | 列进站凭证是否已设置 |  |
| POST | `/api/lock-reauth` | **user** |  |  | P4（sudo -v 删除） | sudo -v 的票状态 / 清票 |  |
| POST | `/api/lock-all-devices` | **user** |  |  | P4（v6：lock / 改密码作废其他会话） | lock --all：自己的全部会话回访客 | Gray 2026-11-11 定 user：v6 只作废自己的会话，不保留复验 |
| POST | `/api/lock-reset` | **public** |  |  | P3（恢复钥匙合一 + 救援入口） | 恢复钥匙换 reset 票（sudo styrigx reset） |  |
| POST | `/api/space-auth` | **public** |  |  | P3 | 进站恢复钥匙校验（前端已不用） |  |
| GET | `/s/:code` | **public** |  |  | P4（整套删；删后一段 404，两段仍走代理订阅） | 分享短链：码就是凭证（一段） |  |
| HEAD | `/s/:code` | **public** |  |  | P4 | 同上（链接预览探测） |  |
| GET | `/api/share` | **root** |  |  | P4 | 只回 405（管理只收 POST） |  |
| POST | `/api/share` | **root** |  |  | P4（删前盘点有效链接逐个处理） | 分享链接新建 / 列表 / 作废；v6 给别人权限改为 root useradd -e |  |

### 账号 styrigx-account（经网关 FORWARDING 转发）

| 方法 | 路径 | 档 | action 另定 | 删除 | 去向 | 说明 | 已定 |
|---|---|---|---|---|---|---|---|
| GET | `/api/account` | **public** |  |  | 保留 | 账号终端状态（访客也要读提示符状态） |  |
| POST | `/api/identity` | **public**（救援可用：`whoami`、`exit`、`lock`、`passwd`、`passkey-*`、`groups`） | `passwd` / `passkey-list` / `passkey-add-challenge` / `passkey-add` / `passkey-delete` / `groups` / `who` → user；`sudo-challenge` / `sudo` → sudoers；`useradd` / `userdel` / `usermod` / `passwd-user` → root；`whoami` / `su-challenge` / `su` / `exit` / `idle` / `lock` → public |  | 保留（P2 新增） | v6 身份命令：whoami / su / sudo / exit / lock / passwd / passkey / groups / who / useradd / userdel / usermod / passwd <名> |  |
| POST | `/api/account/session` | **public** | `passkey-challenge` → wheel；`passkey` → wheel；`password` → wheel |  | P4（v6 su / exit） | 旧 sudo root 登录；v6 = su root（wheel + root 凭据），root 不能从访客直接登录 |  |
| POST | `/api/account/reauth` | **root** |  |  | P4（sudo root reauth 删除，改 sudo 每次重验） | sudo root reauth（3 分钟票） |  |
| POST | `/api/account/reset` | **public**（救援可用） | `password-set` → root；`passkey-list` → root；`passkey-add-challenge` → root；`passkey-add` → root；`passkey-delete` → root；`finish` → root |  | P3（救援入口直接签 15 分钟一次性 root 会话） | 恢复密钥换 reset 票；之后的写只在救援会话里 |  |
| POST | `/api/account/keys` | **root**（救援可用） |  |  | 保留 | 账号钥匙 = root 的密码 / 通行密钥（v6 迁为 root 凭据） |  |
| POST | `/api/account/devices` | **user** |  |  | 保留 | 已登录设备 = 自己的会话（v6 who 只看自己） | Gray 2026-11-11 定 user：管自己的会话；root 看全部由 who 做（P2） |
| POST | `/api/account/grants` | **root** |  |  | P2 起子应用权限改由组表达（curio-write / daymark-write …） | 应用授权 app allow \| deny（归 root，定稿 §十） |  |
| POST | `/api/account/proxy` | **root** |  |  | 保留 | 代理订阅管理 sub（转 styrigx-proxy-rules ProxyAdmin；含令牌、age 公钥） | Gray 2026-11-11 定 root，不加新组 |
| PUT | `/api/avatar` | **user** |  |  | 保留 | 换自己的头像（v6 头像 = whoami，按 uid） | Gray 2026-11-11 定 user：P2 按 uid 分（uid 只取服务端会话，ADR-0006 P2 硬要求） |
| DELETE | `/api/avatar` | **user** |  | 单条 → 写组 | 保留 | 删自己的头像（回默认） | Gray 2026-11-11 定 user：同上 |
| GET | `/avatar/:file` | **public** |  |  | 保留 | 头像图片（页面路径） |  |
| GET | `/api/profile` | **public** |  |  | 保留 | 站点个人资料（公开数据） | Gray 2026-11-11 定 public：资料是公开数据（KV_PROFILE 只放公开数据） |
| PUT | `/api/profile` | **owner** |  |  | 保留 | 改站点个人资料（站长资料，不是每个用户一份） | Gray 2026-11-11 定稿 v4：站长（styrigx）+ root（root 由 permits 放行），其余一律拒；名片只有一份，属于站长 |
| GET | `/api/prefs` | **user** |  |  | 保留 | 读自己的设置云同步（偏好归 styrigx，按 uid） | Gray 2026-11-11 定 user：P2 加 uid（uid 只取服务端会话） |
| POST | `/api/prefs` | **user** |  |  | 保留 | 写自己的设置云同步 | Gray 2026-11-11 定 user：同上 |
| POST | `/api/wellbeing` | **user** |  |  | 保留 | 数字健康上报（只记自己的） | Gray 2026-11-11 定 user：P2 加 uid 列（uid 只取服务端会话） |
| GET | `/api/wellbeing` | **public** |  |  | 保留 | 区域合计公开；明细（书名 / 文章名）只给本人 | Gray 2026-11-11 定 public：合计公开，明细只给本人（按 uid，不按组） |

### 奇趣接口 styrigx-curio-core（styrigx.com/curio/api/*，不经网关）

| 方法 | 路径 | 档 | action 另定 | 删除 | 去向 | 说明 | 已定 |
|---|---|---|---|---|---|---|---|
| GET | `/curio/api/items` | **public** |  |  | 保留 | 设备 / 游戏列表（私密行只给 curio-write，见 decided） | Gray 2026-11-11 定 public：私密行只给 curio-write |
| POST | `/curio/api/items` | **curio-write** |  | 单条 → 写组 | 保留 | device.* / game.*：add / edit / order；del 是单条 |  |
| GET | `/curio/api/links` | **public** |  |  | 保留 | 收藏列表（私密行同上） | Gray 2026-11-11 定 public：私密行只给 curio-write |
| POST | `/curio/api/links` | **curio-write** |  | 单条 → 写组 | 保留 | cat.* / link.*；link.del 单条；cat.del 只删空分类（非空 409），按单条算 |  |
| GET | `/curio/api/movies` | **public** |  |  | 保留 | 电影列表 | Gray 2026-11-11 定 public：私密行只给 curio-write |
| POST | `/curio/api/movies` | **curio-write** |  | 单条 → 写组 | 保留 | movie.add / edit / del（单条） |  |
| GET | `/curio/api/photo` | **public** |  |  | 保留 | 设备照片 / 海报 |  |
| POST | `/curio/api/photo` | **curio-write** |  |  | 保留 | 上传照片 / 海报 |  |
| DELETE | `/curio/api/photo` | **curio-write** |  | 单条 → 写组 | 保留 | 删一张照片 |  |
| GET | `/curio/api/icon` | **public** |  |  | 保留 | 网站图标缓存 |  |
| GET | `/curio/api/preview` | **curio-write** |  |  | 保留 | 添加收藏时抓标题 / 图标（算在写里） |  |
| GET | `/curio/api/export` | **root** |  |  | 保留 | 导出全部收藏（含私密） | Gray 2026-11-11 定 root：导出全部收藏含私密 |
| POST | `/curio/api/import` | **root** |  |  | 保留 | 批量导入书签（v5 要账号复验 → v6 sudo 每次重验 = root） |  |
| GET | `/curio/api/music` | **public** |  |  | 保留 | 歌单（不含音频地址） |  |
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
| GET | `/daymark/api/quotes` | **public** |  |  | 保留 | 句子列表（私密句子只给 daymark-write，见 decided） | Gray 2026-11-11 定 public：私密句子只给 daymark-write |
| POST | `/daymark/api/quotes` | **daymark-write** |  |  | 保留 | 新增句子 |  |
| PUT | `/daymark/api/quotes` | **daymark-write** |  |  | 保留 | 改句子 |  |
| DELETE | `/daymark/api/quotes` | **daymark-write** |  | 单条 → 写组 | 保留 | 删一句（日记条目） |  |
| GET | `/daymark/api/collections` | **public** |  |  | 保留 | 百味专题列表 |  |
| POST | `/daymark/api/collections` | **daymark-write** |  |  | 保留 | 新建专题 |  |
| PUT | `/daymark/api/collections` | **daymark-write** |  |  | 保留 | 改专题 / 重排专题里的句子 |  |
| DELETE | `/daymark/api/collections` | **root** |  | 结构 → root | 保留 | 删整个专题（句子本身不删）= 结构删除 | Gray 2026-11-11 定 root：删整个专题 = 结构删除 |
| GET | `/daymark/api/days` | **public** |  |  | 保留 | 按日浏览 |  |

### 代理订阅 / 规则集 styrigx-proxy-rules（proxy-rules.styrigx.com，不经网关）

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
| account | `AccountService.fetch` | space-core FORWARDING（ACCOUNT） | 上表 /api/account*、/api/avatar*、/api/profile、/api/prefs、/api/wellbeing、/api/identity、/avatar/* |
| account | `AccountVerifier.authorize / admit` | space-core（ACCOUNT_VERIFIER） | 旧授权结论 / v6 新会话判定（只读） |
| space-core | `SpaceVerifier.session / conclusion` | curio-core、daymark-core（SPACE） | 旧进站会话结论（P4 后改问账号） |
| space-core | `ShareJanitor.purgeShareLinks` | styrigx-status 每日一轮（JOB_SPACE） | 清过期分享链接（P4 随分享删） |
| proxy-rules | `ProxyAdmin.*` | account POST /api/account/proxy（PROXY） | 代理订阅管理（root 档在调用方） |
| curio-core / daymark-core / ai | `HourlyJob.run` | styrigx-status 每小时一轮 | 搜索索引 / 照片清理等定时任务 |
