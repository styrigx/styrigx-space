# 代理订阅服务 设计稿 v1.10

Hark · 2026-11-10 02:45 CST · 正文按 v1.7「每源一条链接」整篇重写，不再有覆盖项。P1 已按本稿上线（main `225888e9`），文中 SQL、常量、错误类别与线上代码一致（唯一例外：§5 改机场链接，线上 `updateAirportUrl` 仍是先清再拉，P2 改）。

## 0. 目标与边界

- 每个机场订阅、每份上传的配置文件各做成一份 mihomo provider，手机（CMFA）一个来源一个 provider，定时拉取。不合并、不加前缀、不跨源去重。
- 下载链路用 age 加密：Worker 只有公钥，只能加密；私钥只在手机上。
- 管理有两条路：命令行（任何已登录的 tty 都能做完所有事，不跳页）和图形单页（`open ~/proxy` 或账号页入口）。
- 不建新 Worker、不开新子域名、不新增付费。外观沿用账号页现有组件。

## 1. 两把钥匙

| 钥匙 | 在哪 | 保护什么 | 方向 |
|---|---|---|---|
| age 私钥 / 公钥 | 私钥在手机 CMFA；公钥存 D1 | 下载链路：各源的成品 `sources.armor` | 单向（Worker 只能锁） |
| `SGX_PROXY_DB_KEY` | Cloudflare Secrets Store（Gray 建，Hark 不碰值） | D1 里的原料：机场链接 `url_enc`、各源上次好节点 `last_nodes_enc` | 双向（Worker 要解开去拉机场），AES-256-GCM，附加数据 = `行 id + 字段`（改名不影响解密） |

- 算法：原生 age X25519（自写最小实现：WebCrypto 的 X25519/HKDF/HMAC + `node:crypto` 的 chacha20-poly1305，需 `nodejs_compat`）。不用 typage（137 KB，CPU 超免费档）。
- 公钥只收 `age1…`（X25519）。`age1pq1…`（ML-KEM-768 混合）暂不开放，提示里写明原因。
- 私钥在 CMFA「Meta 特性 > Age 密钥 > X25519」手机内生成，不经电脑。

## 2. 放哪

**proxy-rules Worker（`styrigx-proxy-rules`，proxy-rules.styrigx.com）**——所有数据都在这里
- `GET/HEAD /s/<令牌>/<来源名>`：订阅下载，只回该源的 age 密文。
- 规则集路由不变：`/MetaCubeX/...`、`/styrigx/mihomo-rules/release/...`。
- `scheduled()`：每 6 小时刷新（`0 */6 * * *`，本 Worker 自带的 Cron，见定时任务规则的例外）。
- 命名入口：`ProxyAdmin`（状态、公钥、令牌、来源增删改开关、立即刷新）；`ProxyRefresher`（每个源单独一次调用，各算各的 CPU，经自身服务绑定 `SELF`）。只经 Service Binding 调用。
- 绑定：D1 `styrigx-proxy`、`SGX_PROXY_DB_KEY`、Rate Limiting `RL_SUB`、`SELF`。

**account Worker（`styrigx.com/api/account/proxy`）**——只做门卫
- 挂在已有的 `/api/account` 下（网关一条已覆盖子路径，不加转发条目）；`POST { action }` 风格同 `/api/account/grants`。
- 校验进站会话 + 账号会话；`key`、`link` 另要 reauth（3 分钟有效，只认解锁密码或通行密钥）。
- 不绑 D1、不绑 DB_KEY，不留任何订阅数据；经服务绑定 `PROXY` 调 `ProxyAdmin`。

**公网无刷新入口**：proxy-rules 的 fetch 路由不注册任何刷新或管理路径。测试：公网请求 `/internal/*`、`/api/*` 一律 404。

## 3. 存储（D1 `styrigx-proxy`，独立库，只绑 proxy-rules）

选 D1 不选 KV：强一致，锁和「只写更新的版本」各是一条条件 UPDATE。

```sql
-- 单值配置：'pubkey' | 'token_hash' | 'ua' | 'ua_checked'
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 来源：一个机场或一份上传文件 = 一行 = 一条下载路径 /s/<令牌>/<name>
CREATE TABLE sources (
  id             TEXT PRIMARY KEY,               -- 随机 id（加密附加数据用它）
  name           TEXT NOT NULL UNIQUE,           -- [A-Za-z0-9_-]{1,32}，大小写敏感，进 URL
  type           TEXT NOT NULL CHECK (type IN ('airport', 'file')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  host           TEXT,                           -- 机场域名（明文，界面显示用）
  url_enc        TEXT,                           -- 机场完整链接，DB_KEY 加密
  last_nodes_enc TEXT,                           -- 上次好的节点（JSON），DB_KEY 加密
  node_count     INTEGER NOT NULL DEFAULT 0,
  last_ok_at     INTEGER,
  last_error     TEXT,                           -- 只记错误类别
  armor          TEXT NOT NULL DEFAULT '',       -- 下载成品：age 密文（空 = 还没有，下载 404）
  gen            INTEGER NOT NULL DEFAULT 0,     -- 成品生成时间（毫秒），只写更新的
  created_at     INTEGER NOT NULL
);

-- 刷新锁（单行）
CREATE TABLE lock (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  owner   TEXT,
  expires INTEGER NOT NULL DEFAULT 0
);
INSERT INTO lock (id, owner, expires) VALUES (1, NULL, 0);
```

| 数据 | 形式 |
|---|---|
| 公钥 | 明文 |
| 下载令牌 | 只存 SHA-256 |
| 机场链接、各源节点 | DB_KEY（AES-256-GCM）加密 |
| 来源名、类型、开关、机场域名、节点数、时间、错误类别 | 明文 |
| 成品 `sources.armor` | age 加密 |

- 源文件一律不落库：机场下载的、用户上传的，都只在内存里抽 `proxies:`，机场自带的规则、分组丢弃。
- 上限（`core/sub/config.js`）：来源最多 20 个；**每源**节点最多 1000（P0：1000 节点加密 p50 4.3 ms）；机场下载与上传文件各 2 MB；机场链接 2048 字符。
- 迁移只预置 `lock` 一行；`sources` 新行 `armor` 为空、`gen=0`，之后只用 UPDATE 写成品。
- 迁移文件 `workers/proxy-rules/migrations/0001_init.sql`，与现有 D1 同一套部署流程。

## 4. 刷新流水线（cron、手动、改动后自动，三者同一份代码）

协调这一次（`runRefresh`）：
1. 抢锁：`UPDATE lock SET owner=?, expires=now+60s WHERE id=1 AND expires<now`，影响 0 行就返回「正在刷新」。
2. 没有公钥：返回「未设置公钥」，什么都不写。
3. 读 `sources` 中开启的源。有机场源才定 UA：读 `meta.ua`，只在 `ua_checked` 超过 24 小时才查 `MetaCubeX/mihomo` releases/latest，失败沿用上次（起始 1.19.33）。
4. 每个源并行（`Promise.allSettled`）交给 `ProxyRefresher.refreshSource`，各算各的 CPU；协调这次只做抢锁、读列表、发调用、放锁。
5. 放锁：`UPDATE lock SET expires=0 WHERE id=1 AND owner=?`。

每个源（`refreshSourceById`，开头再核一次锁仍在 owner 手里，不在就什么都不做）：
1. 机场源：解密链接 → 拉取（超时 15 秒、2 MB）→ 只抽 `proxies:`（机场返回节点链接列表时，base64 或明文，把 hysteria2、vless、vmess、trojan、ss、tuic 链接转成 mihomo 节点；认不出的行跳过，一个都没有才报原「不是有效的 Clash YAML」；sing-box JSON、Surge/QuanX 不支持，Gray 2026-11-12 01:01）→ 成功就用 DB_KEY 加密存 `last_nodes_enc`、更新节点数和时间；失败记 `last_error`（类别），然后用上次好的节点。
2. 文件源：直接用 `last_nodes_enc`。
3. 源内重名加 ` #2`、` #3`（provider 内不能重名）；不加来源前缀，不跨源去重。
4. 生成该源的 `proxies:` YAML（带生成时间），用公钥 age 加密。
5. 写成品，一条语句同时核对版本和锁：
   `UPDATE sources SET armor=?, gen=? WHERE id=? AND gen<? AND EXISTS (SELECT 1 FROM lock WHERE id=1 AND owner=?)`
6. 明文只在内存里，不进日志；错误只有类别：`fetch`、`status`、`size`、`format`、`empty`、`too-many`、`no-pubkey`、`config`。

**一个源出错**（含超过 1000 节点 `too-many`）：只记这个源的 `last_error`。机场源有上次好的节点就照旧用它重新出成品，没有就不写，`armor` 保持原样（从没成功过则为空，下载 404）；不截断，不清空。上传文件超限、格式不对：上传当场报错，什么都不存，原有节点和成品不动。其他源照常。

**自动刷新的时机**：换公钥（每个源都重加密，文件源用 `last_nodes_enc`，机场源顺带重拉）、加或改机场链接、上传、开关、删源之后。刷新完成前手机拉到的仍是旧成品，入口显示「更新中」。改名（`sub-mv`）不刷新，见 §5。

## 5. 来源操作规则

- 名称是 Gray 自己起的短名：`[A-Za-z0-9_-]`，1–32 位，大小写敏感；它就是下载路径的最后一段，不保密。
- 加机场：输入链接，保存后界面只显示域名，不回完整 URL。
- 同名即更新：同名再加机场链接 = 改链接；同名再上传文件 = 覆盖。都沿用原 id。改机场链接二次确认时显示新旧域名。类型不同一律报错 `type`（机场名拿来上传、文件名拿来加机场链接都一样）。
- **改机场链接先试拉，成功才替换**：新链接只在内存里拉一次（同 §4 的超时、体积、抽 proxies、每源上限）。成功：一条 UPDATE 同时换 `host`、`url_enc`、`last_nodes_enc`、节点数并清 `last_error`，然后只为这个源出一次成品，直接用刚存的 `last_nodes_enc`，不再重拉机场（只拉一次）。失败：什么都不换，旧链接、旧节点、旧成品原样保留，源不断，只回错误类别给前端（「新链接拉取失败：fetch，未更换」），不写 `last_error`。**P1 线上现状是先清旧节点和成品再重拉（`updateAirportUrl`），与此不符，P2 后端 PR 一并改。**
- 来源数上限 20：加第 21 个（新名字的机场或上传）报 `too-many-sources`（业务失败 422），什么都不存；同名更新不算新增，不受此限。
- 删源：二次确认；删掉那一行（链接、节点、成品一起没了），该源下载立即 404。
- 开关：`off` 后不再刷新该源，下载 404；链接或文件、成品都保留，`on` 后恢复并刷新一次。
- 改名（`sub-mv <旧名> <新名>`，Gray 02:26 定）：只改 `sources.name`，沿用 id、成品、上次好节点、开关。**不刷新**：来源名不写进文件内容，原成品就是新路径的内容，改完立即生效。后果：下载路径从 `/s/<令牌>/<旧名>` 变成 `/s/<令牌>/<新名>`，旧路径立即 404，手机里那个 provider 的 url 要换；令牌不变，其他源不受影响。新名已存在报错不覆盖；旧名不存在报错；新旧相同不动作。
- 上传文件不自动更新，换节点就重新上传。
- 手写节点（如 Cloudy Xray、WARP MASQUE）不单列类型：写成只含 `proxies:` 的 YAML 当文件上传。

## 6. 下载与令牌

- 一个令牌，所有来源共用：第 n 个源的地址是 `https://proxy-rules.styrigx.com/s/<令牌>/<来源名>`。
- 令牌 32 字节随机，base64url；只存 SHA-256，常量时间比较。
- 一律 404、不区分：令牌格式不对、令牌错、还没生成过令牌、来源名不合法、来源不存在、来源关着、该源没有成品。`Cache-Control: no-store`；直接回内容，不 302；下载不读 DB_KEY。
- 限流两层：WAF 现有规则（150 次/10 秒/IP）；Worker 内 `RL_SUB` 按 IP，错令牌也计数，超了 429。
- 泄露：别人只拿到 age 密文。
- **令牌只显示一次**：生成或替换时把令牌交给前端一次，之后服务端也拿不回原文（只存哈希）。前端就在那一刻把**当前全部来源的完整 URL**逐条印出（带复制）；以后加的新源，地址 = 同一前缀 + 新名，自己拼。所以令牌要在生成时存好（建议存进 Samsung Pass），丢了只能替换。
- **替换令牌 = 所有来源的链接同时失效**：重置只换 `meta.token_hash`，各源成品不动，但旧令牌下的每一条 `/s/<旧令牌>/<来源名>` 立即 404，手机里每个 provider 的 url 都要换。替换前的确认写明「旧链接（全部 N 个来源）立即失效」。

## 7. 管理接口（`POST /api/account/proxy { action }` → Service Binding → `ProxyAdmin`）

| action | 参数 | 鉴权 | 之后 |
|---|---|---|---|
| `status` | — | 会话 | 回公钥头尾、有没有令牌、各源（名称、类型、域名、开关、节点数、上次成功、错误类别、有无成品） |
| `key` | `pubkey` | 会话 + reauth | 自动刷新重加密 |
| `link` | — | 会话 + reauth | 回新令牌（只这一次）和下载前缀；前端拼出各源 URL |
| `add` | `name, url` | 会话 | 加机场 / 同名改链接（先试拉，成功才换），回新旧域名；自动刷新 |
| `upload` | `name, text` | 会话 | 上传 / 同名覆盖；自动刷新 |
| `mv` | `from, to` | 会话 | 只改名，不刷新（P2 加） |
| `on` / `off` | `name` | 会话 | 自动刷新 |
| `rm` | `name` | 会话（前端 y/N） | 自动刷新 |
| `refresh` | — | 会话 | 回逐源结果 |

`ProxyAdmin` 的业务失败原样回 422 `{ ok:false, error }`。

## 8. 前端（P2；终端部分依终端统一设计稿 v1.5）

### 8.0 终端原则
- 一个引擎、一张命令注册表，五个 tty：tty1 锁屏、tty2 主页（首屏 + Ctrl K 抽屉）、tty3 盾牌下拉、tty4 AI（`$ ` 前缀才是命令）、tty5 账号下拉。
- 只有 tty1 按入口限制（白名单：解锁相关、help、man、clear、tty）；tty2/3/4/5 用全表，所以 `sub-*` 在这四个 tty 都能用。
- 鉴权照旧在服务端；前端白名单只管体验。
- 命令行能做完所有事，从不跳页：reauth、y/N、遮挡输入、选文件、复制都在原地。
- `cd`/`ls`/`pwd` 只在命令行里走虚拟目录；唯一跳 GUI 的是 `open <路径>`。
- 每条命令一页 man；`help` 只留简短列表。

### 8.1 命令（tty2–tty5，已登录）
| 命令 | 做什么 | 鉴权 |
|---|---|---|
| `sub` | 看状态：公钥头尾、令牌有没有、上次刷新、各源名称/类型/节点数/状态 | 会话 |
| `sub-key` | 设置 / 更换公钥（前端校验格式），完成后自动重加密 | reauth |
| `sub-link` | 没有就生成，已有就问是否替换（提示全部来源旧链接立即失效）；印出令牌和当前每个来源的完整 URL，各带复制，只这一次 | reauth |
| `sub-add <名称>` | 输入机场链接（遮挡不回显）；同名即更新，确认时显示新旧域名 | 会话 |
| `sub-upload <名称>` | 弹系统文件选择，传本地 YAML，字符进度条；同名即覆盖 | 会话 |
| `sub-mv <旧名> <新名>` | 只改名，不刷新；确认时显示新旧路径（令牌遮挡）并提示手机要换这一条 url | 会话 |
| `sub-on <名称>` | 打开来源 | 会话 |
| `sub-off <名称>` | 关闭来源（下载 404，数据保留） | 会话 |
| `sub-rm <名称>` | 删除来源（y/N） | 会话 |
| `sub-refresh` | 立即刷新，逐源回显结果 | 会话 |

共 10 条。增删改、开关、换公钥后自动刷新一次，回显「更新中」，完成后打印结果。

### 8.2 目录与 open
- 代理订阅目录是 `~/proxy`（在 `~` 下，不在 `~/account/apps` 下）。任何位置用 `cd ~/proxy`；在 `~` 下也可以 `cd proxy`。`ls ~/proxy` 列出来源（名称、类型、域名或「文件」、节点数、状态）。
- `open ~/proxy`（在 `~` 下可写 `open proxy`）打开代理订阅图形单页。

### 8.3 man
- 10 条命令各一页：NAME / SYNOPSIS / DESCRIPTION / 鉴权 / NOTES（自动刷新、令牌只显示一次、同名即更新、改名后旧路径失效）。
- `man sub` 另带 SEE ALSO 列出全部 `sub-*`。格式同现有锁屏 `man space`，q 退出。

### 8.4 账号页入口（放在「应用授权」下面，只是 GUI 链接）
- 正常：`代理订阅 · 3 个来源 · 6h 前 ›`
- 异常：`1 个异常`；未配置：`未设置`；没公钥：`未设置公钥`；刷新中：`更新中`。

### 8.5 图形单页（样式同账号安全、应用授权，复用现有行、子页、开关、确认框，不加新颜色或字体）
1. 公钥（第一位）：只显示头尾；「更换」= 粘贴 → 校验 → reauth → 保存 → 自动重加密。没公钥时提示先设。
2. 下载令牌：有没有；「生成 / 替换」需 reauth，生成那一刻列出每个来源的完整 URL（各带复制），只显示这一次；替换前提示全部来源的旧链接立即失效。
3. 来源列表：名称、机场域名或「文件」、节点数、状态、开关；展开看错误、改名、删除（二次确认）。
4. 按钮：「+ 机场链接」「+ 上传文件」「立即刷新」「‹ 返回」。

## 9. 代码目录（P1 已有 + P2 待加）

```
workers/proxy-rules/src/
├── api/sub.js               下载 /s/<令牌>/<来源名>
├── api/rules.js             规则集
├── rpc/proxy-admin.js       ProxyAdmin：状态、公钥、令牌、来源、刷新
├── rpc/proxy-refresher.js   ProxyRefresher：单源刷新
├── core/sub/
│   ├── config.js            上限、名称规则、错误类别
│   ├── admin.js             管理操作（P2 加 rename）
│   ├── pipeline.js          流水线（协调 + 单源）
│   ├── lock.js              刷新锁
│   ├── airport.js           拉机场
│   ├── parse.js             抽 proxies、源内重名加 #n、生成 provider 文本
│   ├── ua.js                UA
│   └── store.js             D1 读写
├── lib/{age.js, aes.js, token.js, vendor/js-yaml.mjs}
└── migrations/0001_init.sql

workers/account/src/api/account/proxy.js   门卫：会话、reauth、转发（P2 加 mv）
assets/js/shell/term/cmds/sub/*.js         sub-* 命令（P2，注册进统一命令表）
assets/js/shell/term/man/sub*.js           man 页（P2）
（单页组件放现有账号子页目录，P2）
```

## 10. 风险

- 免费档每次调用 CPU 10 ms：每源单独一次 `ProxyRefresher` 调用只解决多个源加起来超的问题，**解决不了单个源本身超**。本地估算单源 1000 节点约 12 ms（抽 proxies + 加密），已超。P2 冒烟用 1000 节点源在线上实测 CPU，两处都测：刷新（`ProxyRefresher`）和改机场链接的试拉（`sub-add` 同名，也要解析 YAML + 加密），另测上传：超 10 ms 就把 `MAX_NODES` 降到实测不超的值（预计 500–800），上传与拉取的报错同步改；不等用户撞上。
- 改动后自动刷新期间，手机拉到的仍是旧成品。
- 令牌丢了只能替换，替换会让全部来源的链接一起换。

## 11. 分期

- P0（完成 2026-11-10）：原生 X25519 CPU 实测；CMFA 真机解出。
- P1（已上线，#371 后 main `225888e9`）：proxy-rules 后端、account 门卫、规则仓 release 路径。
- 终端统一（设计稿 v1.5，T1–T6）。
- P2：`sub-*` 注册进命令表（含 `sub-mv` 与后端 `mv`）、man 页、`~/proxy` 目录、账号页入口与图形单页，先截图给 Gray。
- P4：ADR、文档、冒烟清单交 Muse。

## 12. 待 Gray 定

- 入口名「代理订阅」，放「应用授权」下面（已默认采用）。
- （令牌只显示一次：P1 已按此上线，不再列为待定。）

## 13. 修订记录
- v1.1–v1.4：换公钥重加密、并发锁、同名更新、改动即刷新、KV 改 D1 等。
- v1.5：终端原则、`sub-*` 命名。
- v1.6：P0 结论（原生 age X25519、PQ 暂不开放、上限约 1000）。
- v1.7：每源一条链接、成品挪进 `sources`、不加前缀、接口挂 `/api/account/proxy`（文首覆盖项形式）。
- v1.10：改链接只拉一次（试拉结果直接出成品）；CPU 实测加试拉与上传；文首注明唯一例外；版本号。
- v1.9：改机场链接先试拉、成功才替换（P2 改后端）；类型不同一律报错；来源上限 20 的报错；CPU 单源超限按实测降 `MAX_NODES`；§12 去掉已定项。
- v1.8：正文按 v1.7 整篇重写，去掉覆盖项；与 P1 线上代码对齐（每源单独刷新调用、20 源上限、错误类别）；五个 tty；`sub-mv` 定义；10 条命令；`sub-link` 印令牌 + 各源完整 URL；超限保留旧成品；替换令牌全部来源失效；`cd ~/proxy`。
