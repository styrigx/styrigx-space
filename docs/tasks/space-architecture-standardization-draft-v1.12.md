# space 目录架构规范 v1.12（定稿）

> 状态：**定稿**，Gray 2026-11-13 定。v1.12 只并进一件事：目录改名（《目录改名定稿 v1.7》，#451 已合，main a5a9e14e）。v1.11 原版不动。
> 日期：2026-11-13
> 版本说明：
> - v1.1 只改口径（主子站 → 网站/产品/基建）。
> - v1.2 改立场（worker 的规范谈不上范本；各目录规范各管各的，只要求不打架）。
> - v1.3 改术语（四级命名）+ 答了音乐落点问题。
> - v1.4 再改术语（Ecosystem 不出现；正式命名三级）。
> - v1.5 纳入 Hark 的核对（9 项全认，数字和目录树已改、落点已补、待定已列）。
> - v1.6 纳入 Gray 的定夺（2026-11-13）：“所有与规范冲突的 以规范为准 不这样大出血一次 以后更乱 产品功能才刚刚开始”。本版据此把 §6 的待定逐项落定：规范的来源已定（规范为准，旧文档和旧规则跟着改）；音乐放 Platform（§3.5 的原则为准，§4 已改过来）；js/lib/ 按功能拆；顺序是先立契约再挪、先挪 assets/js/；范围只做 space/。只剩检查要多严这一项是提案，等 Gray 一句话。
> - v1.7 定稿：Gray 再定（2026-11-13）：“按你的提议 严格按照规范执行 不然还设计什么规范”。检查要多严也已定：两条都拦（红线 + 落点），严格执行。§6 全部落定，本版为定稿。
> - v1.8 定稿：Gray 再补（2026-11-13）：“即使是硬性规范 也难免有无法处理的情况 灵活处理就 OK”。严格执行是默认，规范实在处理不了的情况允许灵活处理（例外要写下来、说清楚原因，不悄悄绕过）。
> - v1.9 定稿：Gray 修正架构关系（2026-11-13，见 ChatGPT 对话截图）：“我想修正一个架构关系”。Platform → Services → Products 不是一条固定的上下级依赖链，而是三个不同性质、独立协作的架构层。归属与依赖是两回事：目录归属看组件本身属于哪一层，不看它现在为谁服务；服务关系可以变，不决定目录归属。workers/ 放仓库根目录就是 Services 独立性的表达。
> - v1.10 定稿：Gray 再修正（2026-11-13）：“不对 我可能没表述清除 架构规范稿中把这个架构关系图写出来”。v1.9 只说了三层独立协作，没把图写出来。v1.10 把架构关系图写进 §0：Products 必须建立在 Platform 之上（基础依赖，必须），Services 是可选的能力依赖（Products 可以独立于 Services，但不能独立于 Platform——这是两个完全不同的独立性）。图里 Products 嵌在 Platform 的框里，Services 是旁边独立的盒子。
> - v1.11 定稿：Gray 纠正目录映射（2026-11-13）：“目录映射错了 ChatGPT 给的那个画错了 产品在 space 里面”。v1.10 的目录树画了个顶层的 products/，是错的。产品不在仓库根目录，产品在 space 里面——是 space/web/ 这个 Hugo 站里的三个栏目（content、layouts、assets 各按产品分）。目录树已改过来。
> - v1.12 定稿：并进《目录改名定稿 v1.7》（Gray 2026-11-13 16:36 定，#451 已合；Gray 2026-11-13 17:30 定稿）。只改三处：§3.7 和 §4 的路径按改名后的结构写（shell → common，外壳在 common 里的 frame/ 下）；§5.5 的脚本名（gen-shell → gen-common）；§5 新加第 8 条“迁移顺序”，在第 6 步和第 7 步之间插入改名这一步（6.5），并写明标识符改名在第 7 步和第 8 步之间。§1 是迁移前（main 567bf9ce）的现状，保留原样不改。原则、待定、不做都不变。
>
> 背景：worker 那边有一份正式的骨架契约（`workers/README.md`），space 这边没有，显得乱。Gray 以后的中心放在优化产品功能上，基建基本搞完了——所以这份规范不是为了基建而基建，是为了让产品的功能优化做起来干净、找得到地方、改了不怕碰坏别的东西。产品功能才刚刚开始，现在不整，以后更乱，所以大出血一次，现在就整。

---

## 0. 三级命名与架构关系图（正式架构术语）

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

| 层级 | 正式名称 | 对应对象 | 依赖关系 |
|---|---|---|---|
| 平台 | Platform | Space | 提供统一基础环境；是 Products 的基础依赖 |
| 服务 | Services | Workers | 可被平台或产品调用，也可以独立存在；是可选的能力依赖 |
| 产品 | Products | Curio、Daymark、Blog | 必须建立在 Platform 之上，可选用 Services |

英文词是正式架构术语。

**三者的真实关系**（Gray 2026-11-13 修正）：
- **Platform 是 Products 的基础依赖**：Products 必须建立在 Platform 之上。Products 可以独立于 Services，但**不能独立于 Platform**。
- **Services 是可选的能力依赖**：Services 可被 Platform 或 Products 调用，也可以独立存在，不构成它们的必然依赖。
- **这是两个完全不同的独立性**：Products 独立于 Services，和 Products 独立于 Platform，是两回事。前者可以，后者不行。
- 一句话：**Space 提供产品赖以构建的统一平台，Workers 提供按需调用的服务，Products 则在平台之上形成各自的产品体验。**这才是这套架构真正的关系。

**归属与依赖是两回事**（总原则，见 §3）：归属决定一个组件属于哪个架构层（它是什么）；依赖决定它实际为谁提供能力（它为谁服务）。服务关系可以变化，不应该决定目录归属。一个 Worker 将来只服务于 Curio，或者同时服务于 Space 和 Blog，它都不应该因此改变自身的架构归属——它一直是 Services，目录一直在 `workers/`。

**目录结构**：
```
/                          # 仓库根目录
├── space/                 # Platform
│   └── web/               # Hugo 站（Platform 的实现）
│       ├── content/       # Products 的内容
│       │   ├── blog/      # 博客产品
│       │   ├── curio/     # 奇趣产品
│       │   └── daymark/   # 日刻产品
│       ├── layouts/       # Products 的模板（blog/、curio/、daymark/）
│       └── assets/        # Products 的资源（blog/、curio/、daymark/）
└── workers/               # Services
```
注：**产品在 space 里面**（Gray 2026-11-13 纠正：ChatGPT 画的顶层 `products/` 是错的）。Products 不是仓库根目录的第三个顶层目录，而是实现为 `space/web/` 这个 Hugo 站里的三个栏目——内容、模板、资源各按产品分。这正好就是“Products 构建于 Platform 之上”：它们住在 Platform 的站里。`workers/` 放在仓库根目录，就是对 Services 独立性的明确表达（这也解释了为什么不把 Workers 放进 `space/` 里）。

注：拉到最大，整个 Styrigx 是一个生态系统（Ecosystem），但这个词不出现在正式命名里，只是个背景认识。

---

## 1. 现状：为什么乱

数过（main 567bf9ce，git 里的文件，不含 public/ 和 node_modules）：`space/` 底下 105 个目录、382 个文件。乱不是文件多，是**分类没有统一的规矩**，同一个东西有两种分法，新文件不知道该放哪。

### 1.1 `assets/` 这一层是混的

```
assets/
├─ js/        顶层 JS：apps/、auth/、entries/、lib/、shell/
├─ css/       顶层 CSS：input.css、tw-input.css、shell/（shell.css、tokens.css）
├─ blog/      博客：css/、js/
├─ curio/     奇趣：css/、js/
└─ daymark/   日刻：css/、js/
```

- 按类型分（js/、css/）和按产品分（blog/、curio/、daymark/）在 `assets/` 这一层挤在一起。
- `js/lib/` 一个目录塞了 27 个文件：i18n、prefs、storage、sudo、toast、uptime、dialog、scheduler、palette、layout-mode、lang-boot……横跨国际化、偏好、存储、鉴权、UI、诊断，什么都有，没有再分组。
- `curio/js/` 和 `daymark/js/` 里各有一个 `sgx/` 子目录（topbar-host.js、ui-inherit-run.js）——产品的 JS 里混着接顶栏的代码（归属见 §3.7）。
- `js/shell/` 里既有平铺文件（terminal.js、nav.js、quick-panel.js……），又有子目录（account/、identity/、space/、term/）。

### 1.2 `layouts/partials/` Platform 和 Products 混在一起

```
layouts/partials/
├─ blog/  curio/  daymark/     各产品的 partials
├─ sgx-*.html                 Platform 的（sgx-footer、sgx-icon-sprite、sgx-tr……）
├─ shell-*.html               Platform 的（shell-topbar、shell-nav-href……）
└─ icon.html  palette-tile-vars.html  space-i18n.html ……
```

产品的 partials 和 Platform 的 partials 在同一个目录里，只靠文件名前缀（`sgx-`、`shell-`）区分。

### 1.3 `scripts/` 根目录平铺了 16 个文件

```
scripts/
├─ blog/  curio/  daymark/   各产品脚本
├─ lib/                      共享库（cf-routes、css-min、pages-headers）
└─ build-css.cjs  build-search-index.mjs  check-frontend.mjs  check-layers.mjs
   check-worker-routes.mjs  ci-local.sh  deploy-rollback.mjs  gen-csp.mjs
   gen-palettes.mjs  gen-shell.mjs  gen-ui-cookie-contract.mjs  health-gate.mjs
   kv-budget.mjs  verify-core-routes.mjs
   （以上 14 个脚本）+ deploy-rollback-floor.json  retired-names.json（2 个 json）
```

构建、检查、生成、部署、验证全平铺在根目录，没有按用途分组。

### 1.4 `data/` 产品的数据和 Platform 的数据混在一起

```
data/
├─ curio/  daymark/          产品的数据
├─ i18n/  sgx-shell-i18n/  shell/   Platform 的数据
└─ 根目录还平铺了 10 个文件：
   features.yaml  palette-roles.json  palettes.yaml  profile.yaml
   public-pages.yaml  shell-nav.json  sites.yaml  space-cats.yaml
   sync-items.yaml  version.yaml
```

这 10 个都是 Platform 层面的配置/数据（调色板、功能开关、站点、导航、版本号等），落点见 §4。

### 1.5 根因

space 是产品一个一个加上去、功能一层一层摞上去，自然长出来的，没经过一次重整。`docs/architecture/repo-structure.md`（SGX-ARCH-002）只讲了顶层分工，没讲到文件一级的落点。（repo-structure.md 也要跟着改，见 §6.6。）

---

## 2. 目标

给 Platform（Space）立一份**它自己的**骨架契约，做到三件事：

1. **新文件有 obvious 的落点**：加一个功能，先看是哪个产品的、是不是 Platform，落点就定了，不用猜。
2. **产品功能自包含**：一个产品（blog/curio/daymark）的代码尽量收在一个地方，改一个功能只动一个地方，不用跨五六个目录翻。
3. **Platform 和 Products 分得开**：Platform（顶栏、终端、AI 窗、调色板、鉴权、锁屏）不依赖任何产品；产品可以用 Platform，Platform 改了不怕碰坏产品。

这份契约是 Platform 自己的，按 Hugo 站的特点来，不照搬 Services（Workers）的。各目录的规范各管各的，只要求相互之间不打架（比如 Platform 调 Services 的接口、路由、会话这些交界处，两边说法要一致）。

不追求“漂亮”，追求“找得到、改得动、不碰坏”。规范服务于产品功能优化，不反过来拖产品功能优化的后腿。

**与规范冲突的，以规范为准**（Gray 2026-11-13 定）：这份契约（space/README.md）写了以后，它就是 Platform 内部的唯一出处。旧文档（docs/architecture/overview.md 的 L0–L6、repo-structure.md）和旧规则（check-layers.mjs）里和它冲突的地方，旧的那边跟着改，不反过来改契约去迁就旧的。

---

## 3. 原则

按 Hugo 站的特点定。先立一条总原则，再列分则：

**总原则：归属与依赖是两回事**（Gray 2026-11-13 修正，ChatGPT 对话确认）：
- **归属**决定一个组件属于哪个架构层（它是什么）。
- **依赖**决定它实际为谁提供能力（它为谁服务）。
- 服务关系可以变化，**不应该决定目录归属**。一个 Worker 将来只服务于 Curio，或者同时服务于 Space 和 Blog，它都不应该因此改变自身的架构归属——它一直是 Services，目录一直在 `workers/`。
- 所以目录结构表达的是归属，不是依赖：`space/` = Platform 的实现，`workers/` = Services 的实现，产品目录 = Products 的实现。**`workers/` 放在仓库根目录，就是对 Services 独立性的明确表达**，不是单纯的目录偏好（这也解释了为什么不把 Workers 放进 `space/` 里）。

1. **产品优先，再分层**：先按产品分（Platform / blog / curio / daymark），再在产品内按类型分（css / js / 模板 / 数据）。不许两种分法在同一层混用。**（Gray 已定：产品优先没问题。独立产品实现千奇百怪、不共通，不能一套吃遍天。）**
2. **Platform 不依赖 Products**：Platform 代码不 import、不引用任何产品的代码和数据；产品可以用 Platform。Platform 改了，产品不受影响。
3. **Products 之间不互相 import**：一个产品的 JS/模板不引用另一个产品的。
4. **一个概念一个文件**：`js/lib/` 这种大杂烩要拆开，一个文件只干一件事，文件名就是它干的事。
5. **跨层功能按性质拆，不硬塞进一层**：一个功能如果横跨 Platform、Services、Products，就按性质拆开，各放各的层，不为了“归到一处”硬塞。音乐就是例子：
   - 共用播放器（弹出播放器页、共用核 music-core.js、Media Session、顶栏音乐入口）放 **Platform**——它是共用的播放能力，哪个产品都能用；
   - 音乐数据与接口（curio-core 的专辑/曲目/令牌签发、D1 音乐表）放 **Services**；
   - 音乐浏览界面（奇趣音乐页、专辑/曲目列表、随机按钮）放 **Products（Curio）**。
   - 盖房子打比方：Platform 是房子本身（结构 + 共用水电），Services 是接进来的水电服务，Products 是房间里摆的东西。装一套音响，布线和功放（播放器）是房子的一部分，曲库（数据）走服务，听歌的房间（浏览界面）是产品——各归各的位置，不全塞进一个地方。
   - **（Gray 已定：§3.5 的原则为准，共用播放器放 Platform。§4 已改过来，不再矛盾。）**
6. **首页和状态页归 Platform**：首页（`index.html`、`home-typer.js`）和状态页（`space-status.js`、`status-i18n.html`、`space-i18n.html`）是 Platform 自己的页面，不是产品。Products 只有 Curio、Daymark、Blog 这三个，首页和状态页默认归 Platform。
7. **产品接 Platform 的适配代码留在产品里**：`curio/js/sgx/`、`daymark/js/sgx/`（topbar-host.js、ui-inherit-run.js）是各产品接顶栏/外壳的适配代码，留在原产品里，不搬进 `common/`。它们 import 的是 Platform（common），不是别的产品，所以不违反第 3 条（Products 之间不互相 import）。判的时候看 import 的对象是不是另一个产品，不是看目录名里有没有 `sgx/`。
8. **各目录的规范不打架**：Platform 的规范只管 Platform 内部；和 Services 的规范、docs 的规范在交界处（接口、路由、会话、版本）说法要一致，不一致的以交界处的那份为准。**与规范冲突的，以规范为准**（见 §2）。
9. **契约写进文档，也写进检查**：骨架写进一份 `space/README.md`；能用脚本检查的规矩（比如 Platform 不依赖 Products、Products 不互相 import），交给现有的 `scripts/check-layers.mjs` 去拦，CI 里拦住，不靠自觉。check-layers.mjs 要重写，不只是对齐（见 §5.4）。**严格执行是默认，但规范实在处理不了的情况允许灵活处理**（Gray 2026-11-13：即使是硬性规范，也难免有无法处理的情况，灵活处理就 OK。例外要写下来、说清楚原因，不悄悄绕过。）

---

## 4. 目标骨架（提案）

只动目录和落点，不动功能、不动外观、不动后端。v1.12 按改名后的名字写（改名定稿 v1.7：shell → common；外壳放 common 里的 frame/ 下，库和数据直接放 common 下）。

```
space/                          # Platform（Space）
├─ web/                          # 唯一的 Hugo 站
│  ├─ assets/
│  │  ├─ common/                 # Platform（顶栏、终端、AI 窗、调色板、鉴权、共用播放器）
│  │  │  ├─ css/                 #   frame.css（原 shell.css）、tokens.css、input.css、tw-input.css
│  │  │  └─ js/                  #   库和数据直接放 js/ 下：core/、ui/、prefs/、i18n/、auth/、features/
│  │  │     │                    #   + 共用播放器：music/（music-core.js、music-player.js，从 curio/js/ 挪进来）
│  │  │     └─ frame/            #   外壳：topbar/、nav/、term/、ai/、apps/、status/、account/（含 identity/）
│  │  ├─ blog/                   # 博客产品：css/、js/
│  │  ├─ curio/                  # 奇趣产品：css/、js/（音乐浏览界面留在这，播放器已挪走）
│  │  └─ daymark/                # 日刻产品：css/、js/
│  ├─ layouts/
│  │  ├─ _default/               # 默认模板（不动）
│  │  ├─ partials/
│  │  │  ├─ common/              # Platform partials（原 sgx-*、shell-*；外壳的在 common/frame/ 下）
│  │  │  ├─ blog/  ├─ curio/  ├─ daymark/
│  │  ├─ blog/  ├─ curio/  ├─ daymark/   # 各产品页面模板（不动）
│  │  │                          #   播放器页 layouts/curio/player.html 跟着播放器进 Platform
│  │  │                          #   （路由 /curio/music/player/ 保持不动，只挪代码不改路由）
│  │  └─ index.html  404.html  alias.html   # 根模板（不动，归 Platform，见 §3.6）
│  ├─ content/                    # 按产品分（不动）
│  ├─ data/
│  │  ├─ common/                 # Platform 数据：原 data/shell/、data/i18n/、data/sgx-shell-i18n/（现 common/frame/i18n/）
│  │  │                          #   + 根目录 10 个平铺文件（version.yaml、palettes.yaml……）全挪进来
│  │  ├─ blog/  ├─ curio/  ├─ daymark/
│  ├─ i18n/  static/  hugo.yaml  # （不动）
└─ scripts/
   ├─ lib/                       # 共享脚本库（不动）
   ├─ blog/  ├─ curio/  ├─ daymark/    # 各产品脚本（不动）
   ├─ check/                     # 检查类（check-frontend、check-layers……）
   ├─ gen/                       # 生成类（gen-csp、gen-palettes、gen-common……）
   └─ deploy/                    # 部署类（deploy-rollback……）
```

和现在比，实质改动：

| 现在 | 改成 |
|---|---|
| `assets/` 一层混用两种分法（js/、css/ 和 blog/、curio/、daymark/ 挤在一起） | Platform 收进 `assets/common/`（css/ + js/；外壳在 `js/frame/` 下），各产品只留 `assets/<产品>/`（css/ + js/） |
| `assets/css/`（input.css、tw-input.css、shell/）没定落点 | `assets/css/shell/` 进 `assets/common/css/`（shell.css 改名 frame.css）；`assets/css/input.css`、`tw-input.css` 是 Platform 的入口 CSS，也进 `assets/common/css/` |
| `assets/js/lib/` 27 个文件大杂烩 | 按功能拆（i18n、prefs、storage、ui……各成一组） |
| `layouts/partials/` Platform 和 Products 混放 | Platform 的进 `partials/common/`（外壳的在 `partials/common/frame/`），产品的不动 |
| `data/` 根目录 10 个平铺文件没定落点 | 全进 `data/common/`（Platform 数据；version.yaml 是版本号唯一来源，也进 `data/common/`，引用处跟着改） |
| `scripts/` 根目录 14 个脚本 + 2 个 json 平铺 | 脚本按用途进 `check/`、`gen/`、`deploy/`；2 个 json 跟着 deploy-rollback 进 `deploy/` |
| 共用播放器（music-core.js、music-player.js、播放器页）现在在 `assets/curio/js/`、`layouts/curio/` | **进 Platform**（§3.5 的原则为准，Gray 已定）：music-core.js、music-player.js 进 `assets/common/js/music/`，播放器页 layouts/curio/player.html 进 Platform 的模板位置；路由 `/curio/music/player/` 保持不动（只挪代码不改路由） |

`content/`、`layouts/<产品>/`、`i18n/`、`static/` 本来就是按产品分好的，不动。

---

## 5. 迁移做法

不搞大爆炸重写。Services 当年也不是一天改完的，Platform 也一样：

1. **先写契约，再挪文件**：先写 `space/README.md`（骨架、落点、依赖规矩），Gray 定了再动手。契约是唯一出处。
2. **一处一处挪**：先挪最乱的 `assets/js/`，再挪 `partials/`、`scripts/`、`data/`。每挪一处，本地全套测试 + CI 全绿才算完，绿不了就停。
3. **只挪位置，不改逻辑**：挪文件只改 import 路径和引用路径，不改一行逻辑、不改外观。逻辑改动走正常的功能 PR，不夹带。
4. **检查要重写，不只是对齐**：`check-layers.mjs` 现在的规则是按层写的（第 1–9 条是前端 L0–L6：lib → auth → shell → apps → entries），并且只扫 `assets/js/`。按 §4 搬完以后，这些规则的路径会全部失效。所以不是“对上新骨架”就行，而是要**重写规则**，并且让它把产品目录（`assets/<产品>/`）也扫进去。重写是迁移的一部分，和挪文件同一批做，挪完一处、规则跟上，CI 才拦得住。
5. **搬完要跟着改的东西**：挪文件不只是改 import，还要改——Hugo 引用资源的路径（`resources.Get`）、`gen-csp`、`gen-common`（原 gen-shell）、`build-css` 里写死的路径、tests 里的路径断言。§6.5 说 tests 不动是指 tests 的文件不挪位置，但里面引用的路径还是得改。这些是迁移的收尾，每挪一处顺手改完，不留尾巴。
6. **旧文档和旧规则跟着改**（Gray 2026-11-13 定：与规范冲突的，以规范为准）：`docs/architecture/overview.md` §6–7 的 L0–L6 定义、`docs/architecture/repo-structure.md` 的顶层分工，凡是和新契约冲突的地方，旧的那边改成和新契约一致（改定义、或标成取代、或改成指向新契约，具体措辞实施时定）。不反过来改契约去迁就旧的。
7. **谁做**：Hark 做，Muse 只看、不动（分工不变）。每步报一次，再往下走。
8. **迁移顺序**（v1.12 新加；详细状态见 `space/README.md` §6）：
   - 第 0–6 步：契约与 check-layers → `assets/js/` → 拆 lib → `assets/css/` → partials → data → scripts（已合，#444–#450）。
   - **第 6.5 步：目录改名**（《目录改名定稿 v1.7》，#451 已合，main a5a9e14e）：shell → common（assets、partials、data 三处）；common 分库和外壳 frame/，加 check-layers 规则 28（common 的库不许依赖 frame，允许例外）；common 三处文件名审查（142 个：改 24、删 3、不变 115）。只改路径，不改标识符。
   - 第 7 步：共用播放器进 Platform（D2），资源网址和模板落点按改名后的结构写（对外 JS 路径是 `/js/`；播放器页模板落点在第 7 步里复核）。
   - **标识符改名**（改名定稿 v1.7 §9）：第 7 步之后、第 8 步之前，单开一个 PR。带 shell 的 localStorage 键、cookie 名、CSS 类名（含 frame.css 里的 `@shell` 标记）、事件名、对外网址，先列清单评估影响，Gray 逐条定。
   - 第 8 步：旧文档对齐（overview.md §6–7、repo-structure.md 改为指向 `space/README.md`）。

---

## 6. 待定（Gray 定）

1. ~~**音乐放哪一层**~~ **已定：放 Platform**（Gray 2026-11-13：与规范冲突的，以规范为准。§3.5 的原则为准，共用播放器放 Platform；§4 已改过来。路由 `/curio/music/player/` 保持不动，只挪代码不改路由。）
2. ~~**分法**：产品优先还是层优先？~~ **已定：产品优先**（Gray 2026-11-13：独立产品实现千奇百怪、不共通，不能一套吃遍天）。
3. ~~**`js/lib/` 拆多细**~~ **已定：按功能拆**（§3.4 的原则为准：一个概念一个文件。27 个文件按功能拆成小组，i18n、prefs、storage、ui……各成一组。）
4. ~~**检查要多严**~~ **已定：两条都拦，严格执行**（Gray 2026-11-13：按你的提议，严格按照规范执行，不然还设计什么规范。`check-layers.mjs` 既拦“Platform 依赖 Products、Products 互相 import”这两条红线，也拦落点（文件放错目录）。**但规范实在处理不了的情况允许灵活处理**（Gray 2026-11-13：即使是硬性规范，也难免有无法处理的情况，灵活处理就 OK。例外要写下来、说清楚原因，不悄悄绕过。））
5. ~~**顺序**~~ **已定：先立契约再挪，先挪 `assets/js/`**（§5 的提案为准。）
6. ~~**规范的来源（L0–L6 谁为准）**~~ **已定：规范为准**（Gray 2026-11-13：所有与规范冲突的，以规范为准。`space/README.md` 是 Platform 内部的唯一出处；overview.md、repo-structure.md、check-layers.mjs 里冲突的地方，旧的那边跟着改。）
7. ~~**范围**~~ **已定：只做 space/**（§6.7 的提案为准：只做 space/（web + scripts），tests 不动，但 tests 里的路径断言要跟着改，见 §5.5。）

---

## 7. 不做

- 不改功能、不改外观、不改后端、不改路由（音乐播放器页的路由 `/curio/music/player/` 保持不动，只挪代码）。
- 不动 `content/`、`i18n/`、`static/`、`layouts/<产品>/` 这些本来就按产品分好的地方。
- 不碰 Services（Workers，那边已经整齐了）。
- 不为了“漂亮”而挪：挪了以后找得更快、改得更稳才挪，不然不动。
