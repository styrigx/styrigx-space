# space/：Platform 骨架契约

> 依据：《space 目录架构规范 v1.11（定稿）》，Gray 2026-11-13 定。
> 本文件是 Platform（Space）内部目录与依赖的**唯一出处**。旧文档（`docs/architecture/overview.md` §6–7 的 L0–L6、`docs/architecture/repo-structure.md`）和旧规则（`scripts/check-layers.mjs`）与本文件冲突的，以本文件为准，旧的那边跟着改。
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
│  │  ├─ shell/                 Platform
│  │  │  ├─ css/                入口 CSS 与 shell 样式（shell.css、tokens.css、input.css、tw-input.css）
│  │  │  └─ js/                 按功能分组（见 §1.1），含共用播放器 music-core.js、music-player.js
│  │  ├─ blog/   css/  js/      博客
│  │  ├─ curio/  css/  js/      奇趣（音乐浏览界面在这，播放器不在）
│  │  └─ daymark/ css/ js/      日刻
│  ├─ layouts/
│  │  ├─ _default/              默认模板
│  │  ├─ partials/
│  │  │  ├─ shell/              Platform 的 partials
│  │  │  └─ blog/  curio/  daymark/
│  │  ├─ blog/  curio/  daymark/   各产品页面模板
│  │  ├─ shell/                 Platform 的页面模板（共用播放器页）
│  │  └─ index.html  404.html  alias.html  …   根模板（归 Platform）
│  ├─ content/                  按产品分
│  ├─ data/
│  │  ├─ shell/                 Platform 数据（i18n、sgx-shell-i18n、调色板、功能开关、站点、导航、版本号……）
│  │  └─ blog/  curio/  daymark/
│  ├─ i18n/  static/  archetypes/  hugo.yaml
└─ scripts/
   ├─ lib/                      共享脚本库
   ├─ blog/  curio/  daymark/   各产品脚本
   ├─ build/                    构建类（build-css、build-search-index）
   ├─ check/                    检查类（check-frontend、check-layers、check-worker-routes、kv-budget、health-gate、verify-core-routes）
   ├─ gen/                      生成类（gen-csp、gen-palettes、gen-shell、gen-ui-cookie-contract）
   └─ deploy/                   部署类（deploy-rollback 与它的 json、ci-local.sh）
```

> `scripts/build/` 是本文件对规范 §4 的补充：build-css、build-search-index 既不是检查、生成，也不是部署，硬塞进三类之一反而找不到（见 §5 例外的同一原则）。脚本逐个归类在挪 scripts/ 那个 PR 里定，PR 里列清单。

### 1.1 `assets/shell/js/` 分组

一个概念一个文件，文件名就是它干的事；同类放一个目录。目标分组（`lib/` 27 个文件按功能拆）：

| 组 | 放什么 |
|---|---|
| `core/` | 无依赖的小工具：util、b64、events、sgx、key-names |
| `i18n/` | i18n、lang-boot、lang-path |
| `prefs/` | prefs、prefs-write、storage、cloud-sync、profile、ui-cookie、ui-cookie-read |
| `ui/` | toast、dialog-behavior、layout-mode、palette-scheme、scheduler |
| `features/` | features、feat-flags.d.ts |
| `status/` | uptime、status-view、diag-jumptrace |
| `auth/` | 现 `js/auth/` 三个文件 + sudo |
| `term/`、`account/`、`identity/`、`nav/`、`ai/`…… | 现 `js/shell/` 的子目录和平铺文件，按功能归组 |
| `apps/` | 首页、状态页（现 `js/apps/`、`js/entries/`；daymark-today 是首页卡片，跟首页走） |
| `music/` | 共用播放器：music-core、music-player |

精确的文件 → 组对照在拆 lib 的那个 PR 里列出，以那份为准。

## 2. 落点：新文件放哪

先问「是哪个产品的？」，再问「是什么类型？」：

| 是谁的 | JS | CSS | 页面模板 | partial | 数据 | 脚本 |
|---|---|---|---|---|---|---|
| Platform | `assets/shell/js/<组>/` | `assets/shell/css/` | 根模板或 `layouts/shell/` | `layouts/partials/shell/` | `data/shell/` | `scripts/{build,check,gen,deploy}/` |
| 产品 X | `assets/X/js/` | `assets/X/css/` | `layouts/X/` | `layouts/partials/X/` | `data/X/` | `scripts/X/` |

- 不许在同一层混用两种分法：`assets/`、`layouts/partials/`、`data/`、`scripts/` 的顶层只能是上表里的目录（加 §1 列出的根文件）。
- 产品接 Platform 的适配代码留在产品里（`assets/curio/js/sgx/`、`assets/daymark/js/sgx/`），不搬进 `shell/`。
- 跨层功能按性质拆：共用能力进 Platform，数据与接口进 Services，浏览界面进产品（音乐就是这么拆的）。

## 3. 依赖规矩（红线）

1. **Platform 不依赖 Products**：`assets/shell/`、`layouts/partials/shell/`、`layouts/shell/`、根模板、`data/shell/` 不 import、不 `partial`、不 `resources.Get`、不读 `site.Data.<产品>` 任何产品的东西。Platform 调 Services 的接口（如首页读 `/daymark/api/today`）不算依赖产品。
2. **Products 之间不互相引用**：产品 X 的 JS / 模板不 import、不 `partial`、不 `resources.Get` 产品 Y 的东西。判的是被引用的对象属于哪个产品，不是目录名里有没有 `sgx/`。
3. **产品可以用 Platform**。
4. 前端不得 import `space/web/assets/` 以外的文件（前后端隔离）。
5. 现有安全规则照旧（会话 cookie 名、解锁状态不进 storage、鉴权接口只在 `auth/` 组等），随 check-layers 重写平移到新路径，不降级。

## 4. 检查

`scripts/check-layers.mjs`（挪 scripts/ 时进 `scripts/check/`）拦这几类，CI 必过：

| 规则 | 拦什么 |
|---|---|
| 23 | Platform 依赖产品（§3 第 1 条） |
| 24 | 产品之间互相引用（§3 第 2 条） |
| 25 | 前端引用 `space/web/assets/` 以外的文件，或引用不存在的文件（§3 第 4 条） |
| 26 | 落点：文件不在 §1 / §2 允许的目录里 |
| 27 | 例外表：没写原因、或已经用不上的例外 |
| 1–9 | 旧的前端分层与安全规则（§3 第 5 条），拆 lib 那个 PR 换成新分组的说法 |

- 23–25 扫 `assets/**` 的 JS（import、export from、动态 import()）和 CSS（@import），以及 `layouts/**` 模板里的 `partial` / `partialCached` / `template`、`resources.Get` / `GetMatch` / `Match`、`site.Data.<键>` / `index site.Data "<键>"`。只认字符串字面量，变量拼出来的路径查不到，靠评审。
- 26 查 `space/web/{assets,layouts,data}`、`space/scripts` 下每个 git 里的文件。白名单是 check-layers 里的 `ALLOWED_PLACES`，和本文件 §1 一致，改骨架两边同一个 PR 改。
- **待迁移表** `scripts/check/layers-pending.json`：迁移开始时（main 567bf9ce）不在目标位置的 156 个文件，暂不报 26。**只许删不许加**：挪走的文件必须同一个 PR 从表里删掉（表里的文件不在了、或已在目标位置都会报错）；新文件一律放目标位置。表空了迁移才算完。

## 5. 例外

严格执行是默认。规范实在处理不了的情况允许灵活处理，但**例外要写下来、说清楚原因，不悄悄绕过**：

- 每条例外同时写两处：本节的例外表，和 `scripts/check/layers-exceptions.json`（每条 `{rule, file, ref?, reason, since}`；没写 `reason` 的例外不放行，用不上的例外也报错，规则 27）。只对 23–26 生效，旧规则 1–22 不开例外口子。
- 例外只针对具体文件或具体一条引用，不开整目录的口子。
- 加例外和改代码同一个 PR，PR 正文里写明，由 Gray 合并即认可。

| 文件 / 引用 | 违反哪条 | 原因 | 加入日期 / PR |
|---|---|---|---|
| （暂无） | | | |

## 6. 迁移（进行中）

只挪位置、不改逻辑、不改外观、不改路由。每挪一处一个 PR：本地全套测试 + CI 全绿 + `public/` 对照（HTML 只允许资源路径和指纹变、压缩后的 JS/CSS 内容一致；动到界面的另附截图）才算完。迁移 PR 开着的时候，其它分支不动 `space/`。

| 顺序 | 一处 | 状态 |
|---|---|---|
| 0 | 本文件 + check-layers 加 23–27（红线 + 落点 + 待迁移表 + 例外表）；顺手修掉现有的两处红线：文章排序 `partials/blog/posts-sorted.html` 首页和奇趣都在用，挪进 `partials/shell/` | 进行中 |
| 1 | `assets/js/` → `assets/shell/js/`（整体挪，不拆） | 未开始 |
| 2 | 拆 `lib/` 和 shell 平铺文件，按 §1.1 分组 | 未开始 |
| 3 | `assets/css/` → `assets/shell/css/` | 未开始 |
| 4 | `layouts/partials/` 的 Platform 部分 → `partials/shell/` | 未开始 |
| 5 | `data/` 的 Platform 部分 → `data/shell/`；`palettes.yaml` 改名 `data/shell/palette-source.yaml`，避开和 `data/shell/palettes.json` 撞键 | 未开始 |
| 6 | `scripts/` 根目录 → `build/`、`check/`、`gen/`、`deploy/`；`space/` 外面（`package.json`、`.github/workflows/`、workers 的 README / wrangler.toml 注释 / `csp-hashes.js` 文件头）只改路径字符串、不改逻辑，PR 里逐个列出 | 未开始 |
| 7 | 共用播放器进 Platform，路由 `/curio/music/player/` 不变：播放器文案和 `.mp-*` 样式一起进 Platform，页面外壳改用 Platform 的 partial，外观不变，截图逐像素对照；脚本网址从 `/curio/js/…` 变成 `/shell/js/…` | 未开始 |
| 8 | 旧文档对齐：overview.md §6–7、repo-structure.md 改为指向本文件 | 未开始 |

> D1–D4（palettes 撞键、播放器怎么进 Platform、scripts 碰到 space/ 外的路径、落点怎么拦）Gray 2026-11-13 按默认方案定，已写进 §4、§6。
