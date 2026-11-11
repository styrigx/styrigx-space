# 调色板与色彩角色

| 项 | 值 |
|---|---|
| 文档编号 | SGX-DES-001 |
| 版本 | 3.0 |
| 日期 | 2026-11-12 |
| 状态 | 现行 |
| 取代 | `docs/palette-usage.md`（2026-11-06） |
| 规则版本 | `palette-rules-2`（`space/scripts/gen-shell.mjs` `RULES_VERSION`，导出到 `palettes.json` 的 `rulesVersion`） |

## 0. 数据源与生成链

0.1 颜色值的**唯一来源**是 `space/web/assets/js/lib/palette-scheme.js` 的 `THEMES` + `FG_POOL`。`space/web/data/palettes.yaml`（id / 名字 / 分组）与定稿夹具 `tests/fixtures/palette-v0.3.json` 只是被单测逐项核对的副本。

0.2 生成链（CI 对两个脚本都跑 `--check`）：

```
palette-scheme.js
  → node space/scripts/gen-palettes.mjs --roles → space/web/data/palette-roles.json + input.css 的 @gen-palettes 段
  → node space/scripts/gen-shell.mjs           → space/web/assets/css/shell/tokens.css + space/web/data/shell/palettes.json
```

0.3 快捷面板的色块与预览从 `palette-roles.json` 取值（`layouts/partials/palette-tile-vars.html`），与页面角色同一份数据。四站直接使用同一份生成物，没有副本。

## 1. 一套调色板是什么

22 套，每套 = **七色：底、面、字、主、辅、第三、点缀**（3.0，2026-11-12）。原来的「单色 / 撞色」两组合并成一个列表，`x*` 撞色 id 删除（旧值 `x<id>` 自动迁到 `<id>`）。默认 **terra（陶土，深套）**。

1.1 **每套只有一个模式**（3.0 起删除深浅模式 `theme-mode` 和自定义主题色 `accent`）：底色 OKLCH L ≥ 0.6 为浅套，否则为深套。
**8 套浅**：雾霾蓝 dustyblue、冰川蓝 glacier、鼠尾草绿 sage、珊瑚 coral、芥末黄 mustard、香槟金 champagne、干枯玫瑰 dustyrose、奶油白 cream；其余 **14 套深**。
`<html class="dark">` / `color-scheme` / `theme-color` 由当前调色板决定，不读 `prefers-color-scheme`。

1.2 陶土的底 / 面 / 字钉值 `#161412` / `#1d1b19` / `#ece6dc`（`PINS`）；石墨保留冷灰色相。

1.3 语义四色写死（`SEM`），审计只校验不改值：

| 档 | 成功 | 错误 | 警告 | 信息 |
|---|---|---|---|---|
| 浅套 | `#097334` | `#be2423` | `#864e00` | `#1666aa` |
| 深套 | `#39e175` | `#ff6f69` | `#ffa521` | `#5aa5ff` |

深套最低对比度 4.80:1。石墨的信息蓝与主色同属蓝色系，靠 i 图标和文字区分（Gray 2026-11-12 定稿）。

1.4 代码高亮用固定主题（浅、深两档，`code-tokens.css`），不计入调色板。

1.5 对比度 WCAG AA：正文 ≥4.5，控件 ≥3，夜间卡 ≥7；正文墨色（`fitInks`）对所有正文表面 ≥4.5；深套夜间卡对 surface ≥1.25。

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
- 22 套的值**全部由公式生成**（3.0 起每套只生成自己那个模式）（`themeSpec()` + 同一条亮度阶梯 + 对比度审计），没有逐套手调的深色值；单测断言规格里没有 `p.hd` / `tune` / `slider` 这类覆盖。

### 档位怎么用（硬规则）

| 档位 | 只能用在 | 不能用在 |
|---|---|---|
| 背景 7 档 `--sgx-bg-1..7` | 每套一条阶梯；组件只用页面底 `--sgx-bg-1` | 大面积内容表面、卡片、任何文字底下 |
| 前景 `-tint` | 浅底：chip / 标签、选中态底色 | — |
| 前景本色（base） | 填充：按钮、开关、进度、选中分段（上面的字由引擎自动挑 on 色，见四） | 当文字色（浅色模式下多数不到 4.5:1） |
| 前景 `-ink` | 文字、图标、链接、焦点环 | 大面积底色 |
| 前景 5–6 | 只给图表 / 快捷面板色块与预览 | 普通组件 |

深色、饱和的档位 MUST NOT 当大面积底色铺在文字下面（PR-G 之前大块卡片因此整体发棕）。

## 2. 三层 token

组件只引用 **Shell + Semantic** 两层，**不直接写 `--sgx-fg-N` / `--sgx-bg-N`**。

### 1. Shell（壳：底 + 材质）

| token | 用在哪 |
|---|---|
| `--sgx-bg-1..7` | 只给页面底用：`--sgx-bg-1` 纯色底 + 44px 细网格 `--sgx-grid`（2026-11 PR-A 起没有光晕） |
| `--sgx-mat` / `--sgx-mat-solid` / `--sgx-mat-line` / `--sgx-mat-filter` | 材质：顶栏、导航面板、内容卡片、快捷面板、终端窗口 |
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
| `--sgx-chart-1..6` | 前景 1..6 | 只给图表（以及快捷面板色块 / 预览） |
| `link`、`focus-ring`、`nav-selected`、`chip-selected`、`outline`、`outline-variant`、`divider`、`text-primary` / `-secondary` / `-tertiary` | 引擎派生 | 链接、焦点、选中、边线、文字 |
| `danger` 族 | **固定红色族（`SEM`），不随主题变**，浅 / 深套各一值 | 错误、故障 |
| `warning` / `info` 族（各四个） | **固定（`SEM`）**，浅 / 深套各一值、审计只核对 | 先只导出，主站组件暂未接（需要时直接用） |
| `success` / `on-success` / `success-container` / `on-success-container` | **固定绿色族（`SEM`）**，浅 / 深套各一值、对比度审计 | 服务状态「正常」横幅 / chip / 可用率色块、验证成功提示 |

**频率**：前景 1 为主，前景 2 次之，前景 3–4 少量，前景 5–6 很少（只在图表、色块预览里出现）。
普通图标保持中性（`text-secondary`），只有关键操作用 `primary`。

### 3. Component（组件）

组件只引用上面两层，例如：搜索框、导航项、按钮、卡片、chip、开关。

## 3. 区域规则

| 区域 | 规则 |
|---|---|
| 页面底 | `--sgx-bg-1` 纯色 + 44px 细网格；四站相同 |
| 顶栏、导航面板、快捷面板、终端抽屉、AI 窗、下拉 | 同一套中性材质（`--sgx-mat*`）；只有字标提示符、关键操作图标可以用 `primary` ink |
| 导航项 / 分段选中态 | `primary-container` 浅底 + `on-primary-container` / `primary` ink 文字与图标 |
| 内容卡片、终端窗口 | 中性材质；特殊功能卡最多一种局部撞色（secondary / tertiary） |
| 主要按钮、开着的开关、进度、选中分段 | `primary-fill` + `on-primary-fill` |
| 次要按钮 | 透明或材质底 + `primary` 描边或文字 |
| 状态（服务状态、校验结果） | 固定 `success` / `danger` / `warning` / `info` 族，不随主题 |
| 提示符、命令回显 | `primary` ink（如 AI 回答前的 `grayai@… --reply` 行） |

3.1 顶栏、抽屉、内容底板 MUST NOT 各自绑定不同的主题色——它们是同一个壳。

3.2 **大面积块中性化**：任何大块（卡片、面板、磁贴、整张卡）MUST 使用中性材质，MUST NOT 铺 `*-container` 或深色调；主题色只出现在小面积强调上。

## 4. 按钮填充 vs ink（2026-10-23 PR-G 修订）

浅色模式下，前景 1 往往是中间调（默认雾霾蓝的前景 1 = 芥末 `#d4a72c`）。以前 `primary` 一个角色既当文字又当填充：
为了白字够 4.5:1，引擎把它压深成 `#7e6000`（橄榄棕），大块 / 按钮全是这个颜色，整个首页发棕。现在拆成两档：

- **ink = `primary`**：压深到在所有表面上 ≥4.5:1，只给文字、链接、图标、焦点环、滑块圆点。
- **fill = `primary-fill`**：前景 1 本色（浅色 = 色池原值，深色 = `fgTones` 深色 base，就是 `--sgx-fg-1`），不压深。
  上面的字 `on-primary-fill` 由引擎 `fillPair()` 自动挑：同色相近黑深墨（L 0.24）和白里对比度高的那个；都不到 4.5:1（中间调，如电光蓝）时
  再试更深的墨 / 纯白，取最高的；还不够才把填充本身沿亮度挪（22 套预设都不需要挪）。芥末上 = 深墨 `#291d00`（7.4:1）。
- 开关 / 滑块的「开着」：浅填充（芥末对白卡约 2.2:1）本身达不到控件 3:1，审计改量「轨道 / 圆点里对比度高的那个」（`@switch-on` / `@slider-on`）：
  开关圆点 = `on-primary-fill`（深墨），滑块圆点 = `primary` ink，所以状态仍 ≥3:1。
- 辅色 / 第三色：没有带字的实色填充（状态页「正常」原来用 tertiary，已换成固定 success），不带字的填充照旧用 `secondary-fill` / `tertiary-fill`。
- 单测：22 套 `on-primary-fill` / `primary-fill` ≥4.5:1、`primary-fill` = `--sgx-fg-1`、`primary` ink 在表面上 ≥4.5:1、审计零失败。

## 5. 组件角色表（阈值）与回退顺序

| 组件 | 用哪个 token | 最低对比度（对它所在的底，含玻璃合成底） |
|---|---|---|
| 正文 / 次要文字 | `text-primary` / `text-secondary` | 4.5:1 |
| 大标题（≥ 24px 或 ≥ 19px 粗体） | `text-primary`（可用 `primary` ink 做强调） | 4.5:1（按正文算，不放宽到 3:1） |
| 链接 | `link`（正文里另加下划线，不只靠颜色） | 4.5:1 |
| 实心按钮 | `primary-fill` + `on-primary-fill`（子站其他前景：`fg-N` + `fg-N-on`） | 字 4.5:1 |
| 标签 / chip | `tag-bg` + `tag-fg`（= 前景 4 tint / ink）；选中 `chip-selected` + `on-chip-selected` | 4.5:1 |
| 图表 | `chart-1..6` | 对卡片 / 合成玻璃 3:1；两两分得开（都有彩色且色相差 ≥ 22°，或 OKLab ΔE ≥ 0.08） |
| 装饰（图例底、分隔） | `bg-1..7`（只页面底）、`outline-variant`、`divider` | 不要求（不承载信息） |
| 焦点环 / 选中描边 | `focus-ring`（= primary ink）/ `text-primary` 描边 | 3:1 |
| 悬停 / 按下 | `state-color` × `state-hover` / `state-pressed`（叠加） | 不改变文字对比 |
| 禁用 | `text-disabled` / `disabled-container` | 不要求（WCAG 豁免） |
| 状态 | `danger` / `success` / `warning` / `info`（+ `on-*` / `*-container` / `on-*-container`），固定不随主题 | 本色在表面 4.5:1，on / 容器字 4.5:1 |

**回退顺序：fill → ink → neutral。** 能用本色（fill，配自动 on 色）就用本色；本色在当前底上不够（例：图表色在白卡上不到 3:1、浅色模式下当文字）
就退到同色相的 ink 档；ink 也不合适（大面积底、长文）就用中性（`text-*` / 材质）。全部在构建期静态算好（`palette-scheme.js` → JSON → CSS），
**运行时不做任何背景感知 / 取色**。

合成底审计（单测 `tests/space/ui/theme/palette-scheme.test.mjs`）：玻璃卡、顶栏、抽屉 = 材质（surface 88%）叠在 `bg-1..7` 任一档（最浅、最深都算）上核对对比度。

## 6. 导出 token 全目录（`space/web/data/shell/palettes.json` / `space/web/assets/css/shell/tokens.css`）

主站组件只引用 Shell + Semantic；共享外壳**完整导出**下面这些（22 套，每套一段 `:root[data-palette]`，值与 `tokens.css` 同名 `--sgx-*` 变量一致），子站按需索取。
`palettes.json` 每套 `{ mode, tokens }`，顶层带 **`rulesVersion: "palette-rules-2"`**（本文这套用法规则的版本；3.0 起删 `schemeVersion`）。

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

## 7. 子站

子站与主站是同一个 Hugo 站：样式表 `@import` 主站的 `assets/css/shell/tokens.css` / `shell.css`，模板读 `site.Data.shell.palettes`，MUST NOT 自己定义主题色。当前色板由 `sgx-ui` cookie 带到子站首帧，深浅随调色板（SGX-SPEC-003）；子站不再加载自定义色引擎。子站按 `rulesVersion` 判断用法规则是否更新。

## 8. 改调色板

1. `palette-scheme.js` 的 `THEMES` 加 / 改一行（6 个前景从 `FG_POOL` 挑），`space/web/data/palettes.yaml`、`space/web/data/features.yaml` 的 palette 选项同步。
2. `node space/scripts/gen-palettes.mjs --roles`、`node space/scripts/gen-shell.mjs`，再各跑一次 `--check`。
3. 单测 `tests/space/ui/theme/palette-scheme.test.mjs` 会核对：对比度审计全过、中性彩度 ≤ 0.012、danger / success 不变、前景 ink 在 tint 上 ≥4.5:1、
   填充档 on 色 ≥4.5:1、`SEM` / `PINS` 不被改写、22 套没有手调值、palettes.yaml / 定稿夹具和 THEMES 一致。

## 9. 修订记录

| 版本 | 日期 | 内容 |
|---|---|---|
| 3.0 | 2026-11-12 | 删除深浅模式与自定义主题色；每套一个模式（8 浅 14 深），默认 terra；七色；语义四色写死；代码高亮固定主题；`palette-rules-2` |
| 2.0 | 2026-11-09 | 22 套一个列表、三层 token、填充 / ink 拆分 |
