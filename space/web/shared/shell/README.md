# space/web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark、styrigx-curio）共用的外壳：色彩角色、顶栏（全大椭圆）+ 快捷面板 + AI 窗口、原地搜索层、自定义主题色引擎、导航项、外观 cookie 读端与写端、标签页图标。

- 源头：`space/web/data/palette-roles.json`、`space/web/assets/css/input.css` 的 `@shell:begin/end` 段、`space/web/assets/js/lib/palette-scheme.js`、
  `space/web/data/shell-nav.json`、`space/web/layouts/partials/icon.html`、`space/web/layouts/partials/shell-wordmark.html`（抽屉头字标，进 nav.json 的 `wordmark`）。改源头后跑 `node space/scripts/gen-shell.mjs`；CI 用 `--check` 核对。
- 子站同步：在子站仓库跑 `node space/scripts/sync-shell.mjs`（默认 ref=main，可 `--ref <分支或提交>`），
  它按 `manifest.json` 从 raw.githubusercontent.com 拉这些文件、逐个校验 sha256，写进子站的标记段 / 供应商目录。
- 主题跨站：主站把外观写进 `sgx-ui` cookie（Domain=styrigx.com）：`pal` = 预设 id，`accent` = 当前种子 #rrggbb。
  子站：`accent` 等于该预设种子 → 只设 `data-palette`；不等 → 自定义色，用 `palette-scheme.js` 的 `rolesCss(seed)` 算整套角色。
  旧撞色 id `x<id>`（2026-10-23 PR-G 前）读端自动迁到 `<id>`，cookie 里旧版本的种子也认作预设。
- 调色板（2026-10-23 PR-G 七色）：22 套 = 1 背景色 + 6 前景撞色。子站只消费主站给的 token，不自己定义主题色；当前色板由主站决定。
  `palettes.json` 每套带 `tokens.light` / `tokens.dark`（Shell：bg-1..7、表面 / 容器、玻璃、遮罩；Semantic：主 / 辅 / 第三色族、选中、链接、边线、文字；
  外加 fg-1..6（-tint / -ink）、chart-1..6、tag-bg / tag-fg），和 `tokens.css` 里同名 `--sgx-*` 变量一样。怎么用见主站 `docs/palette-usage.md`。

## 子站读外观：ui-cookie-read.js（只读；写由 prefs-write.js 负责，见下）

经典脚本、ES5、无依赖，挂 `window.SgxUI`。`<head>` 里、样式表之后、任何内容之前，**原样内联**，紧跟一行调用：

```html
<script>/* ui-cookie-read.js 原文（Hugo：resources.Get … | minify，.Content | safeJS） */</script>
<script>SgxUI.apply(document.documentElement, { onMiss: function (seed) { /* 异步加载 palette-scheme.js，算好 SgxUI.setRoles(seed, rolesCss(seed)) */ } });</script>
```

- `SgxUI.read()` → 校验过的 `{v, mode, pal, accent, fs, rm, mat, lang}`；没有 / 乱码 / 版本不认识 → `null`。
- 语言跟随：`read().lang` 是主站用户明确选的 `'zh'` / `'en'`（跟随系统 = `''`）；非空且和当前页语言不同时，子站自己跳到另一种语言的同一页（`apply()` 不管语言）。
- `SgxUI.apply(root, opts)` → `<html>` 落成和主站一样：`class="dark"`、`data-theme-mode`、`data-dark`、`font-size` + `data-font-size`、
  `data-palette`（默认 dustyblue 不写）、自定义色时内联 `--sgx-seed` + `<style id="sgx-accent-roles">`（本站 localStorage `sgx-shell-accent-css` 缓存，首行「SCHEME_VER|#种子」）、
  `class="reduced-motion"` + `data-reduced-motion`。跟随系统时自动监听 `prefers-color-scheme`。cookie 坏了 = 默认 dustyblue + 跟随系统，不抛错、不跳转。
  `opts.rolesCss`：同步可用的引擎；`opts.onMiss(seed)`：没缓存时回调；`opts.watch: false`：不监听。
- 子站要的 CSS：`tokens.css`（22 套七色调色板 + tag / chart 派生 token + 别名层）+ `shell.css`（含字标 `.wm-dot` = `--sgx-primary`）。抽屉头用 `nav.json` 的 `wordmark` SVG。
- 读端不认 `theme` 别名和大写 accent（写端从不写）；自定义色的种子在内联 `--sgx-seed`（不再用 `data-sgx-seed`）。
  站点自己的样式钩子（如博客的 `data-theme` / `color-scheme`）用 `apply()` 的返回值 `{mode, dark, pal, fs, rm, seed}` 自己补。
- sync-shell 的 SITE.targets 加：`ui-cookie-read.js`（kind `file`）、`ui-cookie-contract.json`（kind `json`，原样）、
  `favicon.js`（kind `file`）、`favicon.svg`（要原样写进 `space/web/static/`：kind `file` 会在顶上加 /* */ 注释，SVG 不认，用 `json` 或加一个 raw 类型）。
- 标签页图标：`favicon.svg` 放站点根 `/favicon.svg`（`<link rel="icon" type="image/svg+xml" href="/favicon.svg">`），
  打包 `favicon.js`（ES 模块）后调 `initFavicon()`：色板 / 自定义色 / 深浅色变了就换成当前主题色。
- 契约测试：`ui-cookie-contract.json` 是主站写端真实写出的 cookie + 期望；子站单测对每个 case 断言 `SgxUI.read('sgx-ui=' + c.cookie)` 等于 `c.read`、
  `SgxUI.resolve(c.read, 系统深色)` 等于 `c.light/c.dark.resolve`（apply 后 `<html>` 等于 `.root`）。sync-shell 拉新版本后跑一遍。
## 顶栏 + 导航面板 + 快捷面板 + AI 窗口（topbar.html / topbar.js / modal-sheet.js / ai.js / vk.js + shell.css topbar-frame、panel 段；2026-11-04 P5-1，P4-3 PR-4b 定稿，四个站一样）

`topbar.html` 是 Hugo partial（主站 partials/shell-topbar.html 原样），子站同步成 `layouts/partials/sgx-shell-topbar.html`，只用参数、不调别的 partial：

```html
<header id="site-nav">
  <div class="sgx-topbar">                                   <!-- 一整条胶囊，材质在它身上 -->
    <a class="sgx-tb-logo" href="本站首页">字标（真 SVG，各宽度都完整）</a>
    <div class="sgx-tb-pill">页名胶囊 / 标签 / 分段（在空余区居中）</div>
    <div class="sgx-tb-acts">                                <!-- 紧凑、靠右；头像不在顶栏 -->
      <button class="sgx-tb-btn sgx-tb-grid" aria-controls="sgx-nav">九宫格</button>
      <button class="sgx-tb-btn sgx-tb-quick" aria-controls="sgx-qp">滑块</button>
      <button class="sgx-tb-btn sgx-tb-ai" aria-controls="sgx-ai">聊天</button>
    </div>
  </div>
</header>
<dialog id="sgx-nav">2×2 站点磁贴（nav.json items：图标 + 站名 + 副标题，当前站「开」态）</dialog>
<dialog id="sgx-qp">只有快捷设置一页：深色 / 跟随系统 / 分享本页 / 立即锁定 · 语言（行内展开单选）· 调色板 · 布局</dialog>
<dialog id="sgx-ai">头部 Gray AI · 新对话 · 历史 · 头像（账号页，主题色环）· 消息列表 · 输入框 · 「仅公开内容 · 联系我」</dialog>
```
- 参数（dict）：`isEn`、`home`、`center`（HTML）、`pillClass`、`headerClass`、`headerAttrs`、`nav`（nav.json）、`site`（当前站 id）、`icons`（nav.json 的 icons）、
  `wordmark`、`acct`、`avatar`、`langHref`（另一种语言的同一页）、`pal`（[{id, zh, en, style}]，style = --pl-b1..7 / --pl-f1..6 / --pd-*）。
  快捷面板四站完全相同，没有按站开关的磁贴（PR-4b 起删了 `tiles` / `layout` 参数）。
- JS：`import { mountTopbar } from './topbar.js'`，把依赖传进去（这几个文件都不 import 任何东西）：
  `mountTopbar({ modalSheet, prefs, ai: mountAiChat, share: mountShare, keyboard: onKeyboardHeight })`（`onKeyboardHeight` 来自 `vk.js`：AI 窗口输入框聚焦时跟键盘，P4-3 PR-3）；prefs 用 `prefs-write.js` 的
  `isDark / themeMode / setThemeMode / toggleFollowSystem / palette / setPalette / DEFAULT_PALETTE / hasAccent / langPref / layoutPref / layoutNarrow / setLayout`，
  `setLang: v => (setLangPref(v), '')`（实际语言变了就去语言行的 data-href）。不传 `onLock` 时「立即锁定」点两下确认后 POST /api/lock-now 回锁屏。
- 三个窗口是非模态 `<dialog>`，从顶栏下方落下、互斥；系统返回 / Esc / 点遮罩关闭，焦点回到图标。
- AI：POST /api/ai（同源）→ SSE hits / delta / done；历史只在本地 `sgx-ai-history`（最多 50 条，不进云同步）。

## 子站外观写端（prefs-write.js；改写原「主站写、子站只读」，定案第 5 条）

四站共用一个写端：主站的 cookie 写法（syncUiCookie）就在这个文件里，子站快捷设置调它的 setter：写 localStorage（同源同一份）→ `SgxUI.apply` 重落 `<html>` → 写 `sgx-ui` cookie。
子站写入的外观在本设备生效（回主站即同步）；跨设备以账号云同步为准，云同步覆盖这些设置之前不承诺跨设备。上面「子站读外观」一节的读端照旧。

## 分享本页（share.js，快捷面板磁贴；PR-4b 起四站都有）

- JS：`mountShare({ button: 磁贴 })`（topbar.js 会对 `[data-qp="share"]` 调传进来的 mountShare）。
  POST https://styrigx.com/api/share（credentials: include；进门二值，不分角色）
  `{action:'create', reuse:true, name:页面标题(24 字), to:当前页(去 lock/why/return/share), hours:24, session:43200}`
  → 带临时会话的短链（服务端同页同档位还剩 ≥ 12 小时就复用）→ `navigator.share`；没有 / 被拒（不是取消）→ 复制 + toast「已复制分享链接」。
  生成中磁贴 `aria-busy` + `.is-busy`，再点不理；失败只 toast，不会把原地址当短链分享。
  服务端回 401 reauth（生成 / 复用短链要锁侧复验，P2-3）→ share.js 自带的最小复验步骤 `lockReauthStep()`（`<dialog class="sgx-share-reauth">`，
  只有锁屏通行密钥 / 解锁密码，设了哪个显示哪个；同源 POST /api/lock-reauth status、/api/lock-password、/api/lock-passkey）→ 通过后自动重试一次；取消 = 不分享。
  toast 是 `.sgx-share-toast`（share.js 自己建）；复验弹层样式 `.sgx-share-reauth*` 在 shell.css 的 topbar-frame 段。
- 尺寸体系（2026-10-23）：`--sgx-page-m`、`--sgx-tb-btn`（顶栏高 52 → 56）、`--sgx-tb-gap`、`--sgx-content-max`（外壳框最宽）、
  `--sgx-shell-w` = min(100% − 2 × 页边距, 最宽)。子站自己的页面外框用 `width: var(--sgx-shell-w); margin: 0 auto`（顶栏不再定内容栏，P4-3 PR-4b）。
- 布局模式（P4-3 PR-4b，Gray 2026-11-07）：只有手机 `phone` / 桌面 `desktop` 两种，不按像素断点定。唯一规则在 `layout-mode.js` 的 `__sgxLayout()`：
  偏好 `sgx-layout` = phone / auto / desktop（旧值 mobile → phone、dex / pc → desktop），自动 = `navigator.userAgentData.mobile`（没有就看 UA 的 Mobi / Android…Mobile / iPhone）；
  `?layout=auto` 逃生口。**四站 `<head>` 原样内联这一份**（Hugo：resources.Get … | minify，.Content | safeJS），结果写进 `<html data-sgx-layout="phone|desktop">`，
  各站自己的 layout-* 类也按它（tests/space/ui/shell/topbar-length.test.mjs 核对四站内联的是同一份、结果一样）。**子站不许再自己改 `--sgx-content-max` / 顶栏宽。**
- 顶栏宽 `--sgx-tb-w`（shell.css）：手机 = 100vw − 2 × 16px；桌面 = min(960px, 100vw − 2 × 24px)，居中。
  顶栏胶囊和快捷面板 / AI 窗口按 `--sgx-tb-w`（100vw 算，含经典滚动条）定宽、`right: calc(100% - 100vw)` 按整个窗口居中：会滚 / 不滚的页一样长，不因滚动条左右挪。

