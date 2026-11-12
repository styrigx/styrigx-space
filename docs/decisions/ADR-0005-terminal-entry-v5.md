# ADR-0005：v5 终端与进站——一个终端、唯一入口 `sudo styrigx`、三处上锁

| 项 | 值 |
|---|---|
| 状态 | 已采纳（已实施）；§2.2.3–§2.2.4 的 sudo 段已被 ADR-0006 取代 |
| 日期 | 2026-11-11（v5 S8 合并） |
| 决策者 | Sloan Gray |
| 关联 | ADR-0002（锁屏方案演进）、ADR-0003（门归网站、账号管授权）；SGX-SPEC-001、SGX-SEC-001、SGX-DES-002 |

## 1. 背景

1.1 进站 v3（ADR-0002）之后，站内有四个各自独立的终端：锁屏 tty1（`entry@space:~$`）、主页首屏 tty2、盾牌下拉 tty3（`styrigx@space:~#`）、账号下拉 tty5（`root@account:~#`），外加 AI 窗口里的 `$` 命令（tty4）。四份历史、四套命令表、四种入口；同一件事（比如上锁、看分享链接）在不同窗口里命令字不同。

1.2 整站未进站时只显示锁屏，访客什么也看不到；而真正需要保护的只有三类东西：AI（花钱、可读私密召回）、听歌（版权音频）、监控（运行数据）。

1.3 临时钥匙（tempkey）与「分享链接自动签链接钥匙」两套机制并存，作废、到期、清理各写一遍。

## 2. 决定

### 2.1 一个终端

2.1.1 tty1 / tty2 / tty3 / tty5 合成一个终端：一个会话、一份历史（sessionStorage）、一张命令表（`space/web/assets/shell/js/shell/term/cmds/`）。AI 窗口（tty4）不动，`$` 开头的输入照旧走同一张命令表、自己的历史。

2.1.2 窗口形态：桌面是居中大窗（宽 `min(1040px, 86vw)`、高 `72vh`，与顶栏留空）；手机是整块卡片。下拉式（Quake）否决。

2.1.3 入口：顶栏 `>_` 终端按钮（所有人可见）、`Ctrl / ⌘ K`、NAVIGATE 页脚「Ctrl K 终端 ›」、盾牌、任何上锁部件。主页首屏不再嵌终端（v5 S7 换成 neofetch 风格的 about 卡；S8 删掉了嵌入终端的代码路径与 `.sgx-term--home` 样式）。

### 2.2 唯一入口 `sudo styrigx`

2.2.1 所有正式进站（访客、分享链接会话）都只有一个入口：在终端里敲 `sudo styrigx`，用解锁密码或通行密钥在终端内验证。没有锁屏界面，也不再跳盾牌 / 账号窗口验证。

2.2.2 解锁流程：上锁部件（或盾牌）→ 打开终端并预填 `sudo styrigx`（不替人回车）→ 验证通过 → 终端自动收起 → 播原进站开机动画（保留不改）→ 回到原页面。旧地址 `?entry=…`（分享链接失效时网关回的 `/?entry=1`、旧书签）同样打开终端预填；`?entry=sudo` 直接执行。

2.2.3 **〔sudo 段已被 ADR-0006 取代：`sudo -v` 删除，复验改为 `sudo <命令>` 每次重验；`sudo styrigx reset` 由救援入口取代；进站凭据并入 styrigx 的 `passwd` / `passkey`〕** 钥匙命令（命令字不变）：`sudo styrigx` 进站；`lock` 只锁本机；`lock --all` 所有设备回访客；`sudo -v` 再验证 3 分钟（reauth 只认解锁密码 / 通行密钥）；`sudo styrigx reset` 进 reset 层（恢复钥匙，`reset@space:~#`，不变）。解锁凭据管理：`lock passwd`、`lock passkey [add | rm <n>]`（与账号的 `passwd` / `passkey` 区分）。

2.2.4 **〔已被 ADR-0006 取代：`sudo root` → `su root`（仅 wheel，输 root 的凭据）；身份栈存服务端，`exit` 弹一层〕** 账号是第二层，在钥匙之后：`sudo root` 登录账号；`passwd`、`passkey [add | rm <n>]`、`device [rm <n> | rm --all]`、`app [rm <n>]`、`sub …`；`exit` 登出回上一层。

### 2.3 提示符按身份（`by`），服务端说了算

| 身份 | 来源 | 提示符 |
|---|---|---|
| nobody | 没有进站会话（访客） | `nobody@space:~$` |
| link | 进站会话 by=`link`（点开带会话的分享链接） | `nobody@space:~#` |
| styrigx | 进站会话 by=`password` / `passkey` | `styrigx@space:~#` |
| root | 已进站且 `sudo root` 登录了账号 | `root@account:~#` |

2.3.1 身份只认服务端（`GET /api/lock-session-check` 与网关注入的 `data-sgx-lock-session`；`shell/term/core/who.js`）。首帧按页面标记画，标了 `valid` 才问服务端细分 link / styrigx / root。前端 MUST NOT 自存身份。

2.3.2 进站会话票的 by 白名单：`password`、`passkey`、`link`（`workers/space-core/src/core/realms.js` `TICKETS.LockSessionTicket.bys`）。网关写给账号 Worker 的 `X-Styrigx-Space-By` 只取这三个值，账号 Worker 的读端（`workers/account/src/lib/gateway.js`）用同一份白名单，其余值（含 v5 前的 `tempkey`）读成空串；`tests/workers/account/gateway-identity.test.mjs` 核对两边一致。

2.3.3 分享链接会话（link）权限：能看三处上锁内容；不能新建 / 管理分享、不能动解锁凭据、不能 `sudo -v`。

2.3.4 `man` 按身份列命令：nobody 只列 `find`，敲 `ask` 回「AI 已上锁，先 sudo styrigx；搜关键词用 find」；进站后 `ask <问题>` 打开 AI 代发，`find` 不再列出。`help` 删除，由 `man` 取代（敲 `help` 回 `command not found: help · try man`）。

### 2.4 整站放开，三处上锁

2.4.1 页面与静态文件一律公开（v5 S3）。网关的访问表 `ROUTE_ACCESS`（`workers/space-core/src/gate.js`）是唯一决定「接口要不要进站会话」的地方：表里逐条写出的「方法 + 路径」公开，其余 `/api/*` 一律要进站会话（fail closed）。

2.4.2 上锁的三处部件：AI 窗口（模型小矩形换锁标，点击打开终端）、奇趣听歌（访客可看歌单 / 封面，进站（含链接会话）可播，上传与管理 = 账号 + `curio.write`；访客点播放打开终端）、旷野监控卡（`/api/status`）。锁由服务端拦（401），前端遮罩只是外观；任何接口回 401 没进站都派发 `sgx:sudo`，顶栏终端接住并预填 `sudo styrigx`。

2.4.3 关键词搜索从 AI 拆出（v5 S4）：`find <词>` 走公开的 `GET /api/find`，读四站的 KV 索引，不走模型，按 IP 限速；只给 nobody。

### 2.5 顶栏 E：盾牌与头像

2.5.1 顶栏：盾牌 · 调色 · 导航四格 │ `>_` 终端 · 头像。

2.5.2 盾牌不开任何窗口，是吉祥物兼状态标志：访客（nobody，含 link）点 → 打开终端预填 `sudo styrigx`；已进站（styrigx / root）点 → 打开终端问「退出进站会话 [y/N]」（y = `lock`，回车 / n 不动）。一来一回对应。

2.5.3 头像：未进站时是死按钮、纯吉祥物（不跳终端、不开窗）；进站后点头像开账号窗口。没有账号页网址（账号 = 头像弹窗）。

2.5.4 导航面板保留「分享本页」，去掉 lock 按钮（上锁由终端 `lock` / 盾牌承担）。

### 2.6 分享链接取代临时钥匙

2.6.1 临时钥匙整块删除（v5 S1 + 收尾 #387）：接口 `/api/lock-tempkey*`、`tempkey` 表、`share_link.key_id` 列（迁移 `0002_drop_tempkey.sql`）、pepper 绑定都已删；by=`tempkey` 的旧票上线即作废。

2.6.2 分享链接 `/s/<码>` 可选带进站会话：服务端签 by=`link`、`linkId = share_link.id` 的进站会话，`Max-Age = min(会话档, 链接剩余时间)`。每次验会话都查 `share_link` 这一行：作废 / 到期 / 已清理 → 下一个请求即失效；纪元（`lock --all`、改密码、删通行密钥）照常让它失效。链接里只有码，没有票。

2.6.3 命令：`share`、`share add`、`share rm <n>`、`share rm --all`；新建要用钥匙进站（link 会话不能发），列表 / 作废要 reauth。不做延期。

2.6.4 清理：过期或作废满 7 天的行，由 `styrigx-status` 现有的每日任务经服务绑定调 `styrigx-space-core` 的命名入口 `ShareJanitor.purgeShareLinks` 删除，不新增 Cron Trigger。

### 2.7 代理订阅 `sub`（sub v3.1）

2.7.1 账号命令（`sudo root` 之后）一条 `sub` 加子命令：`sub`（状态）、`sub show [name]`、`sub add <name>`、`sub upload <name>`、`sub mv <old> <new>`、`sub rm <name>`、`sub enable | disable <name>`、`sub key`、`sub token reset`（S9：原 `sub on | off`、`sub token` 改名，没有兼容）。`show` / `key` / `token reset` 要 reauth。

2.7.2 后端 `styrigx-proxy-rules`：输出一律 age 加密到用户公钥；令牌由服务端用自己的钥匙封存，`sub show` 可重印；`sub add` 同名改链接时先试拉一次，成功才替换。机场源每 6 小时由该 Worker 自己的 Cron 刷新。

## 3. 分期（均已合并）

| 期 | 内容 | PR |
|---|---|---|
| S1 | 链接会话改绑 `share_link`（by=link），删临时钥匙后端 | #382 |
| S2 | 每日清理挂 `styrigx-status` | #383 |
| S3 | 整站放开，三处上锁 | #384 |
| S4 | 关键词搜索 `find` / `GET /api/find` | #385 |
| S5 | 终端合一（命令、会话、提示符、窗口形态） | #388 |
| sub v3.1 | 单条 `sub` 指令 + 令牌封存可重印 | #390 |
| S6 + S7 | 顶栏 E、盾牌、头像、AI 锁；主页 hero + about 卡 | #391 |
| 收尾 | 删 `tempkey` 表、`share_link.key_id`、pepper 绑定；回滚下限 | #387、#389 |
| S8 | 删死代码、文档与本 ADR、冒烟清单 | 本 PR |

## 4. 后果

4.1 正面：一个终端、一份历史、一张命令表；访客能看整站，真正敏感的三处由服务端拦；进站只有一条路，说明与测试都只写一遍；临时钥匙与链接钥匙两套机制合成一套。

4.2 负面 / 代价：
- 已签发的 by=`tempkey` 会话在 S1 上线时全部作废（拥有者重新进站一次）。
- 页面公开后，页面里出现的任何数据都对访客可见：新增数据接口 MUST 先决定是否进 `ROUTE_ACCESS` 的公开清单（默认要进站会话）。个人使用数据（屏幕时间）因此不上主页。
- 链接会话最长 7 天，长于钥匙进站的 12 小时，由签发者选档位（同 ADR-0002）。

4.3 遗留：接口路径仍为 `/api/lock-*`；输入行的秘密模式表里仍有 `temp`（tempkey 时代的模式名，无调用方，留给输入行的后续修改一并清理）。

## 5. 冒烟

合并后的真机冒烟清单：`docs/operations/v5-smoke.md`。
