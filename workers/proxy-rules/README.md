# styrigx-proxy-rules

## 职责

两件事，都在自定义域名 `proxy-rules.styrigx.com`：

1. **规则集加速反代**：只放行登记过的来源里的规则集文件，其他路径一律 404，不当开放代理用。响应头全部重建：只带 Content-Type（按后缀）、Cache-Control、ETag、Last-Modified、CORS 和本 Worker 的诊断头（`X-Proxy-Rules-*`），上游的 CSP、HSTS、Set-Cookie 等一律不透传。不验会话、不发 cookie。每个上游等响应头最多 8 秒，超时换下一个。
2. **代理订阅**（设计稿 v1.7）：把几个机场订阅和上传的配置文件，每个来源各自抽出 `proxies:`、用手机的 age 公钥加密，手机 CMFA 按 `/s/<令牌>/<来源名>` 一源一个 provider 拉取（`age-secret-key` 解密）。Worker 只有公钥，只能加密。

| 来源 | 文件（`src/core/sources/`） | 放行的路径 | 上游顺序 | 边缘缓存 |
|---|---|---|---|---|
| [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) `meta` 分支 | `metacubex.js` | `geo/geosite`、`geo/geoip` 下的 `.mrs` `.yaml` `.list`（名字允许 `!` 等，如 `geolocation-!cn`） | jsDelivr → raw.githubusercontent | 24 小时（`stale-while-revalidate` 7 天） |
| [styrigx/mihomo-rules](https://github.com/styrigx/mihomo-rules) `release` 分支（自有仓，机器人每天生成；main 是原料） | `own-repo.js` | `geosite`、`geoip` 下的 `.mrs` `.yaml`；名字只许 `[a-z0-9-]`（首尾不能是 `-`）；`manifest.json`、`.list`、大写、子目录都不放行 | raw.githubusercontent → jsDelivr（jsDelivr 的分支缓存会滞后） | 1 小时（`stale-while-revalidate` 1 天） |

MetaCubeX 的路径、上游顺序和缓存时长是现有客户端配置在用的，MUST 保持不变。

## 入口

`src/index.js`（`wrangler.toml` 的 `main`）只再导出：默认 handler（`app.js`：`fetch` + `scheduled`）、命名入口 `ProxyAdmin`（管理 RPC，account Worker 的 `PROXY` 绑定调）、`ProxyRefresher`（只给自己的 `SELF` 绑定调，一个源一次调用）。

```
src/
├─ index.js                 入口：只接线
├─ app.js                   默认 handler { fetch, scheduled（每 6 小时刷新）}
├─ router.js                路径登记表和分发（/、/healthz → 405 → /s/ 订阅 → 规则集来源 → 404）
├─ secrets.js               读 SGX_PROXY_DB_KEY
├─ api/
│  ├─ healthz.js            健康检查
│  ├─ rules.js              规则集：缓存 → 上游 → 写缓存
│  └─ sub.js                订阅下载 /s/<令牌>/<来源名>
├─ rpc/
│  ├─ proxy-admin.js        ProxyAdmin：状态、公钥、令牌（重印 / 换新）、来源增删改（改动后自动刷新；手动刷新入口随 sub-refresh 取消）
│  └─ proxy-refresher.js    ProxyRefresher：刷新一个源（锁在调用方手里才做）
├─ core/
│  ├─ sources.js            规则集来源登记表
│  ├─ sources/              metacubex.js、own-repo.js
│  └─ sub/
│     ├─ config.js          常量（名字规则、每源 1000 节点、2 MB、15 秒、锁 60 秒）
│     ├─ admin.js           管理操作
│     ├─ pipeline.js        刷新流水线（抢锁 → 每源一次调用 → 放锁）
│     ├─ airport.js         拉机场（超时、体积上限、只 https）
│     ├─ parse.js           只抽 proxies（源内重名加 #2）、成品正文
│     ├─ lock.js            刷新锁
│     ├─ ua.js              mihomo/<版本> UA（24 小时问一次 GitHub）
│     └─ store.js           D1 读写
└─ lib/
   ├─ age.js                最小 age X25519 加密（WebCrypto + node:crypto chacha20-poly1305）
   ├─ aes.js                库内字段 AES-256-GCM
   ├─ token.js              下载令牌、SHA-256、常量时间比较
   ├─ vendor/js-yaml.mjs    js-yaml 4.3.2 原样内置（部署不装 npm 依赖）
   ├─ upstream.js / cache.js / response-headers.js / content-type.js / http.js
```

## 路由

| 路径 | 方法 | 结果 |
|---|---|---|
| `/`、`/healthz` | 任意 | 200 `styrigx-proxy-rules ok`（styrigx-status 每分钟测 `/healthz`） |
| `/MetaCubeX/meta-rules-dat/meta/geo/<geosite\|geoip>/<名字>.<mrs\|yaml\|list>` | GET、HEAD | 命中缓存直接回；否则依次试上游，都不行回 404 / 502 |
| `/styrigx/mihomo-rules/release/<geosite\|geoip>/<名字>.<mrs\|yaml>` | GET、HEAD | 同上 |
| `/s/<令牌>/<来源名>` | GET、HEAD | 先限流（429）；令牌对、来源开着且有成品 → 200 age 密文（`no-store`）；其他一律 404，不跳转 |
| 其他 | GET、HEAD | 404（公网没有任何管理 / 刷新路径） |
| 任意（`/`、`/healthz` 除外） | 其他方法 | 405 |

HEAD 不读也不写缓存。

## 绑定

| 绑定 | 资源 | 用途 |
|---|---|---|
| `D1_PROXY` | D1 `styrigx-proxy` | 公钥、令牌（哈希 + 封存）、来源、成品、刷新锁 |
| `SGX_PROXY_DB_KEY` | Secrets Store | 库内字段加密钥匙 |
| `SELF` | 本 Worker 的 `ProxyRefresher` | 刷新时一个源一次调用（免费档每次 CPU 10 ms） |
| `RL_SUB` | Rate Limiting（30 次 / 60 秒 / IP） | `/s/` 兜底限流；外层还有 WAF 规则（150 次 / 10 秒 / IP，表达式已含本域名） |

规则集缓存用边缘默认缓存 `caches.default`。`compatibility_flags = ["nodejs_compat"]`（age 加密要 `node:crypto`、`Buffer`）。

## 钥匙

| 钥匙 | 在哪 | 保护什么 |
|---|---|---|
| age 公钥（`age1…` X25519；PQ 暂不开放） | D1 `meta.pubkey`（私钥只在手机 CMFA「Meta 特性 › Age 密钥」） | 下载成品 `sources.armor` |
| `SGX_PROXY_DB_KEY`（base64 的 32 字节） | Secrets Store，只绑本 Worker | D1 里的机场链接 `url_enc`、各源节点 `last_nodes_enc`（AES-256-GCM，附加数据 = 行 id + 字段）、封存的下载令牌 `meta.token_sealed`（附加数据 `meta:token`） |

下载令牌在 `meta` 存两份，同一次 batch 写：`token_hash`（SHA-256，下载只比它、常量时间，下载不读 DB_KEY）和 `token_sealed`（DB_KEY 封存的原文，终端 `sub show` 经 account reauth 后重印）。`sub token reset` 换新令牌，旧链接立即失效。

## 数据与迁移

D1 `styrigx-proxy`：`migrations/0001_init.sql`（`meta`、`sources`、`lock`，预置锁行）。源文件不落库，只抽 `proxies:`。部署：`.github/workflows/deploy.yml` 的 `deploy-proxy-rules-worker`（先 `d1 migrations apply styrigx-proxy`，再部署、冒烟，失败回滚代码），独立部署，不等也不挡网关和 Pages。测试：`tests/workers/proxy-rules/`（`proxy-rules.test.mjs` MetaCubeX、`own-repo.test.mjs` 自有仓、`sub.test.mjs` 代理订阅、`layout.test.mjs` 目录结构）；account 侧门卫在 `tests/workers/account/api-proxy.test.mjs`。
