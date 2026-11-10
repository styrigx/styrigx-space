# 术语表

| 项 | 值 |
|---|---|
| 文档编号 | SGX-DOC-001 |
| 版本 | 1.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |

本表按主题分组。「代码名」一列是代码里的标识符、cookie 名或接口路径，便于 grep。

## 1. 站点与组件

| 术语 | 英文 / 代码名 | 定义 |
|---|---|---|
| 主站 | space，`styrigx.com/`、`/zh/` | 首页终端与旷野页所在的站点；也是全部子站的外壳提供者 |
| 子站 | subsite：`/blog/`、`/curio/`、`/daymark/` | 和主站同一个 Hugo 站、同一次构建、同一个 Pages 项目，按路径前缀区分 |
| 博客 | blog | 子站，文章与专题 |
| 奇趣 | curio | 子站：发现（收藏）、设备、游戏、电影、音乐 |
| 日刻 | daymark | 子站：句子收藏与「今日一句」 |
| 旷野 | wild，`/wild/` | 主站的二级页，收拢服务状态、关于、屏幕时间等子页 |
| 外壳 | shell | 四站共用的顶栏、导航抽屉、快捷面板、终端抽屉、AI 窗、盾牌与账号下拉；源码在 `space/web/assets/js/shell/` 与 `layouts/partials/shell-*` |
| 站点核心 | `styrigx-space-core`（`workers/space-core/`） | 挂在 `styrigx.com/*` 的 Worker：进站会话的唯一签发与校验方、页面关口、分享链接、接口路由与转发。旧称「网关」「鉴权网关」（`styrigx-auth-gateway`） |
| 接口 Worker | `styrigx-curio-core`、`styrigx-daymark-core` | 子站数据接口，挂 `styrigx.com/<站>/api/*` |
| 账号 Worker | `styrigx-account` | 账号系统；没有公开路由，只经站点核心的服务绑定进入 |
| 合站 | — | 2026-11 起主站和三个子站合成一个仓库、一个 Hugo 站（见 ADR-0001） |

## 2. 进站（space）侧

| 术语 | 英文 / 代码名 | 定义 |
|---|---|---|
| 进站 | entry | 通过锁屏取得进站会话的动作。只有拥有者能进站 |
| 锁屏 | lock screen，提示符 `entry@space:~$` | 没有有效进站会话时页面显示的终端；命令 `sudo styrigx` |
| 进站会话 | LockSessionTicket，cookie `sgx-space-session` | 回答「是否已进站」的唯一状态源；`Domain=.styrigx.com`，四站共用 |
| 进站凭证 | — | 解锁密码与进站通行密钥的统称（界面曾叫「锁屏凭证」） |
| 解锁密码 | unlock password，`/api/lock-password` | 进站凭证之一；哈希用 pepper `SGX_SPACE_PASSWORD_PEPPER` |
| 通行密钥 | passkey（WebAuthn） | 进站凭证之一（`/api/lock-passkey`）；账号侧另有一套账号通行密钥，两者互不相通 |
| 临时钥匙 | tempkey | 已删除（v5）：原先拥有者签发的明文码，可在锁屏换进站会话；接口、表、pepper 都已删，by=tempkey 的旧票不认 |
| 分享链接 | share link，`/s/<码>`、`/api/share` | 指向站内页面的短链；可选带会话，点开即获得进站会话（by=link，按 `share_link` 这一行验，作废 / 到期即失效） |
| 链接钥匙 | link key | 分享链接自动签发的临时钥匙（`link=1`）：没有明文码、不出现在临时钥匙列表 |
| 恢复钥匙 | recovery key，`SGX_SPACE_RECOVERY_KEY` | 进站侧唯一的恢复手段，只能换取 reset 票；不能进站、不能 reauth。旧称「进站凭证」「SpaceKey」 |
| 盾牌 | shield，提示符 `styrigx@space:~#` | 顶栏盾牌图标打开的下拉：进站凭证、临时钥匙、分享链接、立即锁屏 |
| 立即锁屏 | lock now，`/api/lock-now` | 清除本机的进站会话与短票；只影响当前设备 |
| 所有设备回锁屏 | lock all devices，`/api/lock-all-devices` | 进站纪元 +1，所有设备的进站会话失效；需要 reauth |

## 3. 账号（account）侧

| 术语 | 英文 / 代码名 | 定义 |
|---|---|---|
| 账号 | account，身份 `root` | 授权主体。账号会话与进站会话相互独立 |
| 账号会话 | session，cookie `sgx-account-session` | `sudo root` 登录后签发，30 天滑动续期 |
| 账号密码 / 账号通行密钥 | AccountPassword / AccountPasskey | 登录与 reauth 只认这两把；pepper `SGX_ACCOUNT_PASSWORD_PEPPER` |
| 恢复密钥 | RecoveryKey，`SGX_ACCOUNT_RECOVERY_KEY` | 账号侧恢复手段，只换 reset 票 |
| 应用授权 | grant，表 `account_grant` | 账号对某个作用域（scope）的授权，如 `curio.write`；一个应用一行 |
| 网关结论 | conclusion | 站点核心问过账号 Worker 后交给下游的授权结果（RPC 对象或 `X-Styrigx-Account-*` 头） |
| 登录标记 | `sgx-account-signed-in` | 非 HttpOnly、值恒为 `1` 的显示用 cookie，只决定首帧提示符；服务端从不读它 |

## 4. 安全通用

| 术语 | 英文 / 代码名 | 定义 |
|---|---|---|
| 票 | ticket | Ed25519 签名的 cookie 值，签名串为 `<cookie 名>\|<票内容>`，不同 cookie 的票互相冒充不了 |
| reauth | 再验证 | 在已有会话上再证明一次身份，换取 3 分钟的短票；进站侧 `sgx-space-reauth`，账号侧 `sgx-account-reauth` |
| reset | 重置 | 用恢复钥匙 / 恢复密钥换取 3 分钟的 reset 票，只能重设凭证，不签会话 |
| 纪元 | epoch | 存在 D1 的计数器；票里的纪元与库里不等即失效。用于「让所有设备掉线」 |
| by | — | 票里记录的验证方式：`password`、`passkey`、`link`、`space`、`recovery-key` |
| fail closed | — | 读取失败、配置缺失时按「拒绝 / 已配置」处理，绝不按放行处理 |
| pepper | — | 密码哈希时额外拼入的服务端秘密（Secrets Store），不与盐同存 |

## 5. 界面

| 术语 | 英文 / 代码名 | 定义 |
|---|---|---|
| 提示符 | prompt | 终端风格界面前缀，如 `styrigx@space:~$`；规则见 SGX-DES-002 |
| 环境提示符 | env prompt，`sgx-envps-*` | 锁屏、盾牌、reset、账号下拉以外的所有提示符，按账号登录状态二选一 |
| Auto 控件 | Auto | 快捷面板里「EN \| Auto \| 中文」「Mobile \| Auto \| DeX」两行三段选择 |
| 布局模式 | layout，`data-sgx-layout` | `phone` / 桌面（DeX）；Auto 时按设备判定 |
| 调色板 | palette | 22 套预设，每套 1 个背景色 + 6 个前景色；见 SGX-DES-001 |
| AI 窗 | Gray AI，`.sgx-ai-*` | 右下浮钮展开的对话窗；手机上是悬浮卡 |

## 6. 流程

| 术语 | 定义 |
|---|---|
| L 系列 | 进站 v3 的落地 PR 序列：L0（#334）、L1（#335）、L2（#337）、L2b（#338）、L3（#340） |
| 命名 v2 | 账号命名改造（P2 #328、P3 #329），一个概念一个词 |
| ADR | Architecture Decision Record，架构决策记录，见 `decisions/` |
