# space/：Platform 骨架契约

> 依据：《space 目录架构规范 v1.11（定稿）》，Gray 2026-11-13 定。
> 本文件是 Platform（Space）内部目录与依赖的**唯一出处**。旧文档（`docs/architecture/overview.md` §6–7 的 L0–L6、`docs/architecture/repo-structure.md`）和旧规则（`scripts/check/check-layers.mjs`）与本文件冲突的，以本文件为准，旧的那边跟着改。
> 能用脚本检查的规矩都由 `check-layers.mjs` 在 CI 里拦，不靠自觉。

## 0. 三级命名与架构关系

```
Styrigx（整个 Styrigx，拉到最大是一个生态系统）
┌─────────────────────────────────────────────┐
│ Platform（平台，Space）                      │
│ 所有产品共同依赖的平台基础                    │
│ ┌─────────────────────────────────────────┐ │
│ │ Products（产品）                         │ │
│ │ Curio · Daymark · Blog                   │ │
│ │ 构建于 Platform 之上                     │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ Services（服务，Workers）                    │
│ 独立服务体系                                 │
│ 根据需要向 Platform 和 Products 提供服务，    │
│ 不构成它们的必然依赖                         │
└─────────────────────────────────────────────┘
```

- **Platform 是 Products 的基础依赖**：Products 必须建立在 Platform 之上，不能独立于 Platform。
- **Services 是可选的能力依赖**：可被 Platform 或 Products 调用，也可以独立存在。Products 可以独立于 Services。
- **归属与依赖是两回事**：目录表达归属（组件是什么），不表达依赖（它为谁服务）。服务关系会变，目录不跟着变。

目录映射：

```
/
├── space/          Platform
│   └── web/        Hugo 站；Products 住在这里：content/、layouts/、assets/、data/ 各按 blog/、curio/、daymark/ 分
└── workers/        Services（放仓库根，表达它的独立性；规范见 workers/README.md）
```

本文件只管 Platform 内部（`space/web` + `space/scripts`）。和 Services 的交界处（接口、路由、会话、版本）两边说法要一致。

**Platform 包括**：顶栏、终端、AI 窗、调色板、鉴权、锁屏、共用播放器，以及首页（`/`）和状态页。
**Products 只有三个**：`blog`、`curio`、`daymark`。

## 1. 目标骨架

```
space/
├─ README.md                    本文件
├─ web/                         唯一的 Hugo 站
│  ├─ assets/
│  │  ├─ common/                Platform
│  │  │  ├─ css/                入口 CSS 与外壳样式（frame.css、tokens.css、input.css、tw-input.css）
│  │  │  └─ js/                 库按功能分组，外壳在 frame/ 下（见 §1.1），含共用播放器 music-core.js、music-player.js
│  │  ├─ blog/   css/  js/      博客
│  │  ├─ curio/  css/  js/      奇趣（音乐浏览界面在这，播放器不在）
│  │  └─ daymark/ css/ js/      日刻
│  ├─ layouts/
│  │  ├─ _default/              默认模板
│  │  ├─ partials/
│  │  │  ├─ common/             Platform 的 partials
│  │  │  └─ blog/  curio/  daymark/
│  │  ├─ blog/  curio/  daymark/   各产品页面模板
│  │  ├─ shell/                 Platform 的页面模板（共用播放器页）
│  │  └─ index.html  404.html  alias.html  …   根模板（归 Platform）
│  ├─ content/                  按产品分
│  ├─ data/
│  │  ├─ common/                Platform 数据（i18n、frame/i18n、调色板、功能开关、站点、导航、版本号……）
│  │  └─ blog/  curio/  daymark/
│  ├─ i18n/  static/  archetypes/  hugo.yaml
└─ scripts/
   ├─ lib/                      共享脚本库
   ├─ blog/  curio/  daymark/   各产品脚本
   ├─ build/                    构建类（build-css、build-search-index）
   ├─ check/                    检查类（check-frontend、check-layers 与它的 retired-names.json、check-worker-routes、kv-budget、health-gate、verify-core-routes）
   ├─ gen/                      生成类（gen-csp、gen-palettes、gen-common、gen-ui-cookie-contract）
   └─ deploy/                   部署类（deploy-rollback 与它的 json、ci-local.sh）
```

> `scripts/build/` 是本文件对规范 §4 的补充：build-css、build-search-index 既不是检查、生成，也不是部署，硬塞进三类之一反而找不到（见 §5 例外的同一原则）。脚本逐个归类在挪 scripts/ 那个 PR 里定，PR 里列清单。

### 1.1 `assets/common/js/` 分组

一个概念一个文件，文件名就是它干的事；同类放一个目录。分两类（目录改名定稿 v1.6 §3）：**外壳**（套在每个页面外面、自己会画界面）放 `frame/` 下；**库和数据**（不自己画外壳，谁都能用）直接放 `js/` 下。

| 组 | 落点 | 放什么 |
|---|---|---|
| `core/` | `js/core/` | 无依赖的小工具：util、b64、events、sgx、key-names；页面跳转的统一入口 navigate |
| `i18n/` | `js/i18n/` | i18n、lang-boot、lang-path |
| `prefs/` | `js/prefs/` | prefs、prefs-write、storage、cloud-sync、profile、ui-cookie、ui-cookie-read |
| `ui/` | `js/ui/` | toast、dialog-behavior、layout-mode、palette-scheme、scheduler；外壳的 modal-sheet、sheet、vk、scrollfx、favicon |
| `features/` | `js/features/` | features、feat-flags.d.ts |
| `auth/` | `js/auth/` | 原 `js/auth/` 三个文件 + sudo + 进站守卫 guard（原 `shell/space/guard.js`） |
| `music/` | `js/music/` | 共用播放器：music-core、music-player（第 7 步定） |
| `topbar/` | `js/frame/topbar/` | 顶栏：panel、head-buttons、quick-panel |
| `nav/` | `js/frame/nav/` | nav、navhistory、layout |
| `term/` | `js/frame/term/` | 终端：原 `shell/term/` 整个子目录 + terminal、suggest |
| `ai/` | `js/frame/ai/` | panel |
| `apps/` | `js/frame/apps/` | 首页、状态页（daymark-today 是首页卡片，跟首页走）；全站公共启动 core（只有页面入口用它）；页面入口在 `apps/entries/` |
| `status/` | `js/frame/status/` | uptime、view |
| `account/` | `js/frame/account/` | 账号卡片、账号命令层；identity 并进 `account/identity/` |

**分层**（check-layers 规则 1–4、6，下层不许 import 上层；层名按组名，`frame/` 下按 `frame/` 下一级目录，`account/identity/` 算 `account`）：基础层 `core/ i18n/ prefs/ ui/ features/ status/` 只引基础层，且不许有鉴权接口；`auth/` 只引基础层和自己；功能组 `term/ account/ nav/ ai/ topbar/ music/` 可引基础层、`auth/` 和彼此，不许引 `apps/`；`apps/` 不许引 `apps/entries/`。**common 的库不许依赖外壳**（规则 28）：`js/` 下 `frame/` 以外的文件不许 import `frame/` 下的文件。`assets/common/js/` 下只允许上表这些落点（规则 26），另加根目录的 `tsconfig.json`。

## 2. 落点：新文件放哪

先问「是哪个产品的？」，再问「是什么类型？」：

| 是谁的 | JS | CSS | 页面模板 | partial | 数据 | 脚本 |
|---|---|---|---|---|---|---|
| Platform | `assets/common/js/<库>/`、`assets/common/js/frame/<外壳组>/` | `assets/common/css/` | 根模板或 `layouts/common/` | `layouts/partials/common/` | `data/common/` | `scripts/{build,check,gen,deploy}/` |
| 产品 X | `assets/X/js/` | `assets/X/css/` | `layouts/X/` | `layouts/partials/X/` | `data/X/` | `scripts/X/` |

- 不许在同一层混用两种分法：`assets/`、`layouts/partials/`、`data/`、`scripts/` 的顶层只能是上表里的目录（加 §1 列出的根文件）。
- 产品接 Platform 的适配代码留在产品里（`assets/curio/js/sgx/`、`assets/daymark/js/sgx/`），不搬进 `common/`。
- 跨层功能按性质拆：共用能力进 Platform，数据与接口进 Services，浏览界面进产品（音乐就是这么拆的）。

## 3. 依赖规矩（红线）

1. **Platform 不依赖 Products**：`assets/common/`、`layouts/partials/common/`、`layouts/common/`、根模板、`data/common/` 不 import、不 `partial`、不 `resources.Get`、不读 `site.Data.<产品>` 任何产品的东西。Platform 调 Services 的接口（如首页读 `/daymark/api/today`）不算依赖产品。
2. **Products 之间不互相引用**：产品 X 的 JS / 模板不 import、不 `partial`、不 `resources.Get` 产品 Y 的东西。判的是被引用的对象属于哪个产品，不是目录名里有没有 `sgx/`。
3. **产品可以用 Platform**。
4. 前端不得 import `space/web/assets/` 以外的文件（前后端隔离）。
5. 现有安全规则照旧（会话 cookie 名、解锁状态不进 storage、鉴权接口只在 `auth/` 组等），随 check-layers 重写平移到新路径，不降级。

## 4. 检查

`scripts/check/check-layers.mjs` 拦这几类，CI 必过：

| 规则 | 拦什么 |
|---|---|
| 23 | Platform 依赖产品（§3 第 1 条） |
| 24 | 产品之间互相引用（§3 第 2 条） |
| 25 | 前端引用 `space/web/assets/` 以外的文件，或引用不存在的文件（§3 第 4 条） |
| 26 | 落点：文件不在 §1 / §2 允许的目录里 |
| 27 | 例外表：没写原因、或已经用不上的例外 |
| 28 | common 的库（`assets/common/js/` 下 `frame/` 以外）依赖外壳 `frame/`（§1.1） |
| 1–9 | 旧的前端分层与安全规则（§3 第 5 条），拆 lib 那个 PR 换成新分组的说法 |

- 23–25 扫 `assets/**` 的 JS（import、export from、动态 import()）和 CSS（@import），以及 `layouts/**` 模板里的 `partial` / `partialCached` / `template`、`resources.Get` / `GetMatch` / `Match`、`site.Data.<键>` / `index site.Data "<键>"`。只认字符串字面量，变量拼出来的路径查不到，靠评审。
- 26 查 `space/web/{assets,layouts,data}`、`space/scripts` 下每个 git 里的文件。白名单是 check-layers 里的 `ALLOWED_PLACES`，和本文件 §1 一致，改骨架两边同一个 PR 改。
- **待迁移表** `scripts/check/layers-pending.json`：迁移开始时（main 567bf9ce）不在目标位置的 156 个文件，暂不报 26。**只许删不许加**：挪走的文件必须同一个 PR 从表里删掉（表里的文件不在了、或已在目标位置都会报错）；新文件一律放目标位置。表空了迁移才算完。

## 5. 例外

严格执行是默认。规范实在处理不了的情况允许灵活处理，但**例外要写下来、说清楚原因，不悄悄绕过**：

- 每条例外同时写两处：本节的例外表，和 `scripts/check/layers-exceptions.json`（每条 `{rule, file, ref?, reason, since}`；没写 `reason` 的例外不放行，用不上的例外也报错，规则 27）。只对 23–26、28 生效，旧规则 1–22 不开例外口子。
- 例外只针对具体文件或具体一条引用，不开整目录的口子。
- 加例外和改代码同一个 PR，PR 正文里写明，由 Gray 合并即认可。

| 文件 / 引用 | 违反哪条 | 原因 | 加入日期 / PR |
|---|---|---|---|
| `web/assets/jsconfig.json` | 26（落点） | 横跨整个 `assets/` 的 JS 路径配置：`baseUrl` 为 `.`（即 `assets/` 本身），覆盖 Platform 的 `common/js/` 和 curio、daymark、blog 的 `js/`；放进任一层都会断掉其它层的路径解析 | 2026-11-13 #450 |

## 6. 迁移（进行中）

只挪位置、不改逻辑、不改外观、不改路由。每挪一处一个 PR：本地全套测试 + CI 全绿 + `public/` 对照（HTML 只允许资源路径和指纹变、压缩后的 JS/CSS 内容一致；动到界面的另附截图）才算完。迁移 PR 开着的时候，其它分支不动 `space/`。

| 顺序 | 一处 | 状态 |
|---|---|---|
| 0 | 本文件 + check-layers 加 23–27（红线 + 落点 + 待迁移表 + 例外表）；顺手修掉现有的两处红线：文章排序 `partials/blog/posts-sorted.html` 首页和奇趣都在用，挪进 `partials/common/` | 已合（#444） |
| 1 | `assets/js/` → `assets/common/js/`（整体挪，不拆） | 已合（#445） |
| 2 | 拆 `lib/` 和 shell 平铺文件，按 §1.1 分组 | 已合（#446） |
| 3 | `assets/css/` → `assets/common/css/` | 已合（#447） |
| 4 | `layouts/partials/` 的 Platform 部分 → `partials/common/` | 已合（#448） |
| 5 | `data/` 的 Platform 部分 → `data/common/`；`palettes.yaml` 改名 `data/common/palette-source.yaml`，避开和 `data/common/palette-list.json` 撞键 | 已合（#449） |
| 6 | `scripts/` 根目录 → `build/`、`check/`、`gen/`、`deploy/`；`space/` 外面（`package.json`、`.github/workflows/`、workers 的 README / wrangler.toml 注释 / `csp-hashes.js` 文件头）只改路径字符串、不改逻辑，PR 里逐个列出 | 已合（#450） |
| 6.5 | 目录改名（目录改名定稿 v1.6）：`shell/` → `common/`（assets、partials、data 三处）；common 分库与外壳 `frame/`，加规则 28；common 三处文件名审查 | 进行中（#451） |
| 7 | 共用播放器进 Platform，路由 `/curio/music/player/` 不变：模板 `layouts/common/player.html` 套主站 baseof、直接用主站 `main.css`（页脚仍亮 curio）；`.mu-*`/`.mp-*` 样式进共享外壳 `@frame music`（奇趣音乐页经 frame.css 用同一份）；文案进 `data/common/i18n`；脚本进 `assets/common/js/music/`，网址从 `/curio/js/…` 变成 `/js/music/…`；截图逐像素对照（只差时钟；手机页脚多了主站底部渐隐，按平台对齐保留） | 已完成 |
| 8 | 旧文档对齐：overview.md §6–7、repo-structure.md 改为指向本文件 | 未开始 |

> D1–D4（palettes 撞键、播放器怎么进 Platform、scripts 碰到 space/ 外的路径、落点怎么拦）Gray 2026-11-13 按默认方案定，已写进 §4、§6。
