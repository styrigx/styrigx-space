# 调色板怎么用（七色调色板，2026-10-23 PR-G）

> 适用：主站（本 PR 落地）；共享外壳完整导出全部 token，子站以后按需接入（见七），本 PR 不改子站仓库。
> 数据源（**唯一一处**颜色值）：`web/assets/js/lib/palette-scheme.js` 的 `THEMES` + `FG_POOL`。
> `web/data/palettes.yaml`（id / c / 名字 / 分组）和定稿夹具 `tests/fixtures/palette-v0.3.json` 都只是**被单测逐项核对的副本**，改了源头忘了改副本单测就红，不会悄悄漂移；
> 设置风格页的色块 / 首页缩略预览卡、快捷面板色块都从生成的 `web/data/palette-roles.json` 取值（`partials/palette-tile-vars.html`），和页面上的角色同一份数据。
> → `node scripts/gen-palettes.mjs --roles` → `web/data/palette-roles.json` + `input.css` 的 `@gen-palettes` 段
> → `node scripts/gen-shell.mjs` → `web/shared/shell/tokens.css` / `palettes.json`（子站同步用）。

## 一、一套调色板是什么

22 套，每套 = **1 个背景色 + 6 个前景撞色**。原来的「单色 / 撞色」两组合并成一个列表，`x*` 撞色 id 删除（旧值 `x<id>` 自动迁到 `<id>`）。默认 **dustyblue（雾霾蓝）**。

| 分组 | 色板 |
|---|---|
| 冷调 cool | 雾霾蓝 dustyblue（默认）、湖蓝 lake、冰川蓝 glacier、靛蓝 indigo、青碧 teal、紫 violet |
| 自然 nature | 山绿 forest、抹茶 matcha、鼠尾草绿 sage |
| 暖调 warm | 樱桃 cherry、橘子 tangerine、珊瑚 coral、陶土 terra、琥珀 amber、芥末黄 mustard、香槟金 champagne |
| 花色 floral | 蔷薇 rose、莓果 berry、兰紫 orchid、干枯玫瑰 dustyrose |
| 中性 neutral | 石墨 graphite、奶油白 cream |

- 背景色 → 7 档深浅 `--sgx-bg-1..7`（浅色从页面底 L 0.97 往深走，深色从 L 0.16 往亮走）。
- 6 个前景色按顺序有固定角色：**主交互 / 辅助强调 / 标题图标 / 标签装饰 / 图表装饰 / 低频点缀**。
  每色四档：`--sgx-fg-N`（本色，按钮 / 进度 / 填充）、`--sgx-fg-N-on`（本色上的字，自动挑深墨 / 白 ≥4.5:1）、`--sgx-fg-N-tint`（浅底，标签 / 选中底）、`--sgx-fg-N-ink`（文字 / 图标档：浅色压深、深色提亮）。
- 22 套的亮 / 暗两套值**全部由公式生成**（`themeSpec()` + 同一条亮度阶梯 + 对比度审计），没有逐套手调的深色值；单测断言规格里没有 `p.hd` / `tune` / `slider` 这类覆盖。

### 档位怎么用（硬规则）

| 档位 | 只能用在 | 不能用在 |
|---|---|---|
| 背景 7 档 `--sgx-bg-1..7` | 每个模式各一条阶梯，**只给光晕和页面底**（`--sgx-bg-1`） | 大面积内容表面、卡片、任何文字底下 |
| 前景 `-tint` | 浅底：chip / 标签、选中态底色 | — |
| 前景本色（base） | 填充：按钮、开关、进度、选中分段（上面的字由引擎自动挑 on 色，见四） | 当文字色（浅色模式下多数不到 4.5:1） |
| 前景 `-ink` | 文字、图标、链接、焦点环 | 大面积底色 |
| 前景 5–6 | 只给图表 / 设置页色块与预览 | 普通组件 |

**深色、饱和的档位永远不当大面积底色铺在文字下面**（夜间时钟、名片这类大块以前就是这样发棕的，见三）。

## 二、三层 token

组件只引用 **Shell + Semantic** 两层，**不直接写 `--sgx-fg-N` / `--sgx-bg-N`**。

### 1. Shell（壳：底 + 材质）

| token | 用在哪 |
|---|---|
| `--sgx-bg-1..7` | 只给页面底（`--sgx-bg-1`）和光晕 `--sgx-halo`（七团光 = bg-7 … bg-2）用 |
| `--sgx-mat` / `--sgx-mat-solid` / `--sgx-mat-line` / `--sgx-mat-filter` | 玻璃材质：顶栏、抽屉 / 边栏、内容卡片、底部搜索栏、快捷面板 |
| `--sgx-surface*`、`--sgx-surface-container*`、`--sgx-topbar-glass`、`--sgx-glass-tint`、`--sgx-glass-edge`、`--sgx-scrim` | 表面层级、弹层、遮罩 |

材质是**中性色**：只带一点背景色相（中性彩度 `n.c ≤ 0.012`），不混饱和主题色；透明度 / 模糊 / 描边规则所有主题一样。
顶栏、边栏、内容底板是**同一个壳**，只用材质、透明度、深浅区分，**不各自绑一个主题色**。

### 2. Semantic（语义角色）

| 角色 | 来源 | 用在哪 |
|---|---|---|
| `primary`（ink） | 前景 1（浅色按对比度压深，表面上 ≥4.5:1） | 链接、文字按钮、焦点环、关键操作图标、滑块圆点 |
| `primary-fill` / `on-primary-fill` | 前景 1 **本色**（= `--sgx-fg-1`，不压深）+ 自动挑的 on 色 | 主按钮、开着的开关、进度 / 已填的滑块段、选中分段、开着的磁贴图标圆、锁屏解锁钮 |
| `on-primary` | 压深 primary 上的字（保留给旧组件 / 子站） | 新组件不要用「primary 当底」 |
| `primary-container` / `on-primary-container` | 前景 1 的浅底 | 选中态底色（导航当前项、开着的磁贴、分段选中） |
| `secondary` / `secondary-container` | 前景 2 | 次要操作、功能分类图标 |
| `tertiary` / `tertiary-container` | 前景 3 | 徽标、特殊功能卡的局部撞色 |
| `--sgx-tag-bg` / `--sgx-tag-fg` | 前景 4（tint / ink） | 标签 / chip 装饰 |
| `--sgx-chart-1..6` | 前景 1..6 | 只给图表（以及设置页色块 / 预览卡） |
| `link`、`focus-ring`、`nav-selected`、`chip-selected`、`outline`、`outline-variant`、`divider`、`text-primary` / `-secondary` / `-tertiary` | 引擎派生 | 链接、焦点、选中、边线、文字 |
| `danger` 族 | **固定红色族，不随主题变** | 错误、故障 |
| `warning` / `info` 族（各四个） | **固定琥珀（h 65）/ 蓝（h 250），不随主题变**，亮暗各一套、审计核对 | 先只导出，主站组件暂未接（需要时直接用） |
| `success` / `on-success` / `success-container` / `on-success-container` | **固定绿色族（OKLCH h 150），不随主题变**，亮暗各一套、对比度审计 | 状态页「正常」横幅 / chip / 可用率色块、设置安全状态 `.is-ok`、验证成功勾 |

**频率**：前景 1 为主，前景 2 次之，前景 3–4 少量，前景 5–6 很少（只在图表、色块预览里出现）。
普通图标保持中性（`text-secondary`），只有关键操作用 `primary`。

### 3. Component（组件）

组件只引用上面两层，例如：搜索框、导航项、按钮、卡片、chip、开关。

## 三、主站各区域

| 区域 | 规则 |
|---|---|
| 顶栏 | 玻璃材质；只有字标 / 品牌点和操作图标可以带一点主题色（primary ink），其余中性 |
| 边栏 / 抽屉 | 和顶栏同一套玻璃规则 |
| 边栏普通导航项 | 中性文字 + 中性图标，默认不带强调色 |
| 导航项选中态 | 低透明度的 primary 浅底（`primary-container` 或 primary 12–16% 透明度）+ primary ink 的图标和文字 |
| 内容区底板块 | 低对比的玻璃面板，不跟内容抢 |
| 内容区上层块（卡片 / 模块） | 中性玻璃表面；只有特殊功能卡（首页夜间时钟卡、精选卡）用 secondary / tertiary 的局部撞色，**每张卡最多一种** |
| 首页名片 | 普通卡片的中性玻璃（`.widget.bg-m-container-lowest` → `--sgx-mat`）；只留头像环一处 `primary-fill` |
| 首页双时钟 | 白天半边 = 材质；夜间半边 = 唯一的局部撞色：`--sgx-night-card`（第三色的浅底、低彩度，按材质 88% 不透明铺）+ `on-night-card` 字（≥7:1）、月亮图标 tertiary ink；**不再是整块饱和深色** |
| 快捷面板 | 面板 = 材质；磁贴 / 行 / 齿轮 / 恢复默认 = 中性玻璃（`--sgx-qp-glass`：最浅表面色半透明 + outline-variant 描边）；开着的磁贴 = `primary-container` + `on-primary-container`，图标圆 = `primary-fill`；选中分段 = `primary-fill` |
| 天气卡 | 不变（自带天气渐变） |
| 搜索框 | 中性玻璃底 + 柔和的中性边线；聚焦时边线 / 焦点环变 primary |
| 主要按钮 | `primary-fill` 实色填充（前景 1 本色），`on-primary-fill` 文字 ≥4.5:1 |
| 次要按钮 | 透明或玻璃底 + primary 描边或 primary 文字 |

总原则：**顶栏 / 边栏 / 内容底板不各自绑不同的主题色**——它们是一个壳；主题色留给交互和视觉焦点内容。
**大面积块中性化**：任何大块（名片、面板里的磁贴 / 行、整张卡）都是中性玻璃，不铺 `*-container` / 深色调；主题色只出现在小面积强调上（图标、头像环、选中态的浅底 + ink、按钮填充）。

## 四、按钮填充 vs ink（2026-10-23 PR-G 修订）

浅色模式下，前景 1 往往是中间调（默认雾霾蓝的前景 1 = 芥末 `#d4a72c`）。以前 `primary` 一个角色既当文字又当填充：
为了白字够 4.5:1，引擎把它压深成 `#7e6000`（橄榄棕），大块 / 按钮全是这个颜色，整个首页发棕。现在拆成两档：

- **ink = `primary`**：压深到在所有表面上 ≥4.5:1，只给文字、链接、图标、焦点环、滑块圆点。
- **fill = `primary-fill`**：前景 1 本色（浅色 = 色池原值，深色 = `fgTones` 深色 base，就是 `--sgx-fg-1`），不压深。
  上面的字 `on-primary-fill` 由引擎 `fillPair()` 自动挑：同色相近黑深墨（L 0.24）和白里对比度高的那个；都不到 4.5:1（中间调，如电光蓝）时
  再试更深的墨 / 纯白，取最高的；还不够才把填充本身沿亮度挪（22 套预设都不需要挪）。芥末上 = 深墨 `#291d00`（7.4:1）。
- 开关 / 滑块的「开着」：浅填充（芥末对白卡约 2.2:1）本身达不到控件 3:1，审计改量「轨道 / 圆点里对比度高的那个」（`@switch-on` / `@slider-on`）：
  开关圆点 = `on-primary-fill`（深墨），滑块圆点 = `primary` ink，所以状态仍 ≥3:1。
- 辅色 / 第三色：没有带字的实色填充（状态页「正常」原来用 tertiary，已换成固定 success），不带字的填充照旧用 `secondary-fill` / `tertiary-fill`。
- 单测：22 套 × 亮暗 `on-primary-fill` / `primary-fill` ≥4.5:1、`primary-fill` = `--sgx-fg-1`、`primary` ink 在表面上 ≥4.5:1、审计零失败。

## 五、组件角色表（阈值）与回退顺序

| 组件 | 用哪个 token | 最低对比度（对它所在的底，含玻璃合成底） |
|---|---|---|
| 正文 / 次要文字 | `text-primary` / `text-secondary` | 4.5:1 |
| 大标题（≥ 24px 或 ≥ 19px 粗体） | `text-primary`（可用 `primary` ink 做强调） | 4.5:1（按正文算，不放宽到 3:1） |
| 链接 | `link`（正文里另加下划线，不只靠颜色） | 4.5:1 |
| 实心按钮 | `primary-fill` + `on-primary-fill`（子站其他前景：`fg-N` + `fg-N-on`） | 字 4.5:1 |
| 标签 / chip | `tag-bg` + `tag-fg`（= 前景 4 tint / ink）；选中 `chip-selected` + `on-chip-selected` | 4.5:1 |
| 图表 | `chart-1..6` | 对卡片 / 合成玻璃 3:1；两两分得开（都有彩色且色相差 ≥ 22°，或 OKLab ΔE ≥ 0.08） |
| 装饰（光晕、图例底、分隔） | `bg-1..7`（只光晕 / 页面底）、`outline-variant`、`divider` | 不要求（不承载信息） |
| 焦点环 / 选中描边 | `focus-ring`（= primary ink）/ `text-primary` 描边 | 3:1 |
| 悬停 / 按下 | `state-color` × `state-hover` / `state-pressed`（叠加） | 不改变文字对比 |
| 禁用 | `text-disabled` / `disabled-container` | 不要求（WCAG 豁免） |
| 状态 | `danger` / `success` / `warning` / `info`（+ `on-*` / `*-container` / `on-*-container`），固定不随主题 | 本色在表面 4.5:1，on / 容器字 4.5:1 |

**回退顺序：fill → ink → neutral。** 能用本色（fill，配自动 on 色）就用本色；本色在当前底上不够（例：图表色在白卡上不到 3:1、浅色模式下当文字）
就退到同色相的 ink 档；ink 也不合适（大面积底、长文）就用中性（`text-*` / 材质）。全部在构建期静态算好（`palette-scheme.js` → JSON → CSS），
**运行时不做任何背景感知 / 取色**。

合成底审计（单测）：玻璃卡、顶栏、抽屉 = 材质（surface 88%）叠在光晕 `bg-1..7` 任一档（最浅、最深都算）上；快捷面板磁贴玻璃、夜间时钟卡同样按合成色核对。

## 六、导出 token 全目录（`web/shared/shell/palettes.json` / `tokens.css`）

主站组件只引用 Shell + Semantic；共享外壳**完整导出**下面这些（22 套 × 亮 / 暗，值与 `tokens.css` 同名 `--sgx-*` 变量一致），子站按需索取。
`palettes.json` 顶层带 `schemeVersion`（引擎哈希）和 **`rulesVersion: "palette-rules-1"`**（本文这套用法规则的版本；`manifest.json` 里同样有 `rulesVersion`，挨着 `version`）。

| 组 | token |
|---|---|
| 背景 7 档 | `bg-1..7` |
| 前景 6 色 × 4 档 | `fg-N`（本色 / fill）、`fg-N-tint`、`fg-N-ink`、`fg-N-on`（本色上的字）；派生 `tag-bg` / `tag-fg` |
| Shell · 表面 / 材质 | `background`、`surface` / `-dim` / `-bright`、`surface-container-lowest/-low/(无)/-high/-highest`、`card` / `card-nested(-2)` / `sheet` / `dialog` / `drawer` / `menu` / `input-fill`、`topbar-glass`、`glass-tint`、`glass-edge`、`scrim`、`inverse-surface` / `inverse-on-surface` / `inverse-primary`、`bg-blob-1..3`、`bg-gradient-1..3`、`background-css` |
| Semantic · 主题色族 | `primary`（ink）/ `on-primary`、`primary-fill` / `on-primary-fill`、`primary-container` / `on-primary-container`；`secondary` / `tertiary` 同四个 + `secondary-fill` / `tertiary-fill` |
| Semantic · 文字 / 边线 | `text-primary` / `-secondary` / `-tertiary` / `-disabled`、`disabled-container`、`outline`、`outline-variant`、`divider`、`link`、`link-visited` |
| 交互 | `focus-ring`、`switch-track-on/-off`、`switch-thumb-on/-off`、`slider-active/-inactive/-thumb`、`chip-selected` / `on-chip-selected`、`nav-selected` / `on-nav-selected`、`fab` / `on-fab`、`badge` / `on-badge`、`badge-info` / `on-badge-info` |
| 状态层 | `state-color`（已解析成颜色）、`state-hover` / `-focus` / `-pressed` / `-selected` / `-dragged`（不透明度） |
| 固定状态色 | `danger` / `success` / `warning` / `info` 各四个（本色、`on-*`、`*-container`、`on-*-container`） |
| 图表 | `chart-1..6` |
| 功能 | `night-card` / `on-night-card`、`lock-*`、`daymark-*` |

单测覆盖每一个导出的可读组合：审计表（on 色 / 容器字 / 正文 / 链接 / 控件）、合成玻璃、焦点环、图表、固定状态色、`fg-N-on` / `fg-N`、`fg-N-ink` 在 tint 和所有表面上。

## 七、子站怎么接（以后）

子站不自己定义主题色：从共享外壳同步 `tokens.css` / `shell.css` / `palettes.json`（`scripts/sync-shell.mjs`），
当前色板 / 深浅色由主站写在 `.styrigx.com` 域的 `sgx-ui` cookie（`pal` / `accent` / 模式）里、子站用 `ui-cookie-read.js` 读——**不依赖跨域 localStorage**。
按上面的角色表挑 token，按 `rulesVersion` 判断规则是否更新。

## 八、改调色板

1. `palette-scheme.js` 的 `THEMES` 加 / 改一行（6 个前景从 `FG_POOL` 挑），`web/data/palettes.yaml`、`web/data/features.yaml` 的 palette 选项同步。
2. `node scripts/gen-palettes.mjs --roles`、`node scripts/gen-shell.mjs`，再各跑一次 `--check`。
3. 单测 `tests/web/ui/palette-scheme.test.mjs` 会核对：对比度审计全过、中性彩度 ≤ 0.012、danger / success 不变、前景 ink 在 tint 上 ≥4.5:1、
   填充档 on 色 ≥4.5:1、光晕只用 `--sgx-bg-*`、22 套没有手调深色值、palettes.yaml / 定稿夹具和 THEMES 一致。
