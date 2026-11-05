# web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark、styrigx-curio）共用的外壳：色彩角色、顶栏（全大椭圆）+ 快捷面板 + AI 窗口、原地搜索层、自定义主题色引擎、导航项、外观 cookie 读端与写端、标签页图标。

- 源头：`web/data/palette-roles.json`、`web/assets/css/input.css` 的 `@shell:begin/end` 段、`web/assets/js/lib/palette-scheme.js`、
  `web/data/shell-nav.json`、`web/layouts/partials/icon.html`、`web/layouts/partials/shell-wordmark.html`（抽屉头字标，进 nav.json 的 `wordmark`）。改源头后跑 `node scripts/gen-shell.mjs`；CI 用 `--check` 核对。
- 子站同步：在子站仓库跑 `node scripts/sync-shell.mjs`（默认 ref=main，可 `--ref <分支或提交>`），
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

- `SgxUI.read()` → 校验过的 `{v, mode, pal, accent, fs, rm, mat, lang, tz1, tz2, h12, clock, wx, unit, loc, city, precise}`；没有 / 乱码 / 版本不认识 → `null`。
- 语言跟随：`read().lang` 是主站用户明确选的 `'zh'` / `'en'`（跟随系统 = `''`）；非空且和当前页语言不同时，子站自己跳到另一种语言的同一页（`apply()` 不管语言）。
- `SgxUI.apply(root, opts)` → `<html>` 落成和主站一样：`class="dark"`、`data-theme-mode`、`data-dark`、`font-size` + `data-font-size`、
  `data-palette`（默认 dustyblue 不写）、自定义色时内联 `--sgx-seed` + `<style id="sgx-accent-roles">`（本站 localStorage `sgx-shell-accent-css` 缓存，首行「SCHEME_VER|#种子」）、
  `class="reduced-motion"` + `data-reduced-motion`。跟随系统时自动监听 `prefers-color-scheme`。cookie 坏了 = 默认 dustyblue + 跟随系统，不抛错、不跳转。
  `opts.rolesCss`：同步可用的引擎；`opts.onMiss(seed)`：没缓存时回调；`opts.watch: false`：不监听。
- 子站要的 CSS：`tokens.css`（22 套七色调色板 + tag / chart 派生 token + 别名层）+ `shell.css`（含字标 `.wm-dot` = `--sgx-primary`）。抽屉头用 `nav.json` 的 `wordmark` SVG。
- 读端不认 `theme` 别名和大写 accent（写端从不写）；自定义色的种子在内联 `--sgx-seed`（不再用 `data-sgx-seed`）。
  站点自己的样式钩子（如博客的 `data-theme` / `color-scheme`）用 `apply()` 的返回值 `{mode, dark, pal, fs, rm, seed}` 自己补。
- sync-shell 的 SITE.targets 加：`ui-cookie-read.js`（kind `file`）、`ui-cookie-contract.json`（kind `json`，原样）、
  `favicon.js`（kind `file`）、`favicon.svg`（要原样写进 `web/static/`：kind `file` 会在顶上加 /* */ 注释，SVG 不认，用 `json` 或加一个 raw 类型）。
- 标签页图标：`favicon.svg` 放站点根 `/favicon.svg`（`<link rel="icon" type="image/svg+xml" href="/favicon.svg">`），
  打包 `favicon.js`（ES 模块）后调 `initFavicon()`：色板 / 自定义色 / 深浅色变了就换成当前主题色。
- 契约测试：`ui-cookie-contract.json` 是主站写端真实写出的 cookie + 期望；子站单测对每个 case 断言 `SgxUI.read('sgx-ui=' + c.cookie)` 等于 `c.read`、
  `SgxUI.resolve(c.read, 系统深色)` 等于 `c.light/c.dark.resolve`（apply 后 `<html>` 等于 `.root`）。sync-shell 拉新版本后跑一遍。
## 顶栏 + 快捷面板 + AI 窗口（topbar.html / topbar.js / modal-sheet.js / ai.js + shell.css topbar-frame、panel 段；2026-11-04 P5-1，四个站一样）

`topbar.html` 是 Hugo partial（主站 partials/shell-topbar.html 原样），子站同步成 `layouts/partials/sgx-shell-topbar.html`，只用参数、不调别的 partial：

```html
<header id="site-nav">
  <div class="sgx-topbar">                                   <!-- 一整条胶囊，材质在它身上 -->
    <a class="sgx-tb-logo" href="本站首页">字标 + 圆点简版</a>     <!-- < 400px 只显示圆点 -->
    <div class="sgx-tb-pill">本站中间内容（页名 / 标签 / 分段）</div>
    <div class="sgx-tb-acts">
      <button class="sgx-tb-btn sgx-tb-quick" aria-controls="sgx-qp">滑块</button>
      <button class="sgx-tb-btn sgx-tb-ai" aria-controls="sgx-ai">聊天</button>
      <a class="sgx-tb-btn sgx-tb-me" href="/account/"><img class="sgx-tb-avatar" data-sgx-avatar="192"></a>
    </div>
  </div>
</header>
<dialog id="sgx-qp">两页：导航（nav.json items / footer，当前站高亮，没有搜索框）/ 快捷设置（磁贴）</dialog>
<dialog id="sgx-ai">消息列表 · 输入框 · 清空 · 仅公开内容 / 包含私密内容</dialog>
```
- 参数（dict）：`isEn`、`home`、`center`（HTML）、`pillClass`、`headerClass`、`headerAttrs`、`nav`（nav.json）、`site`（当前站 id）、`icons`（nav.json 的 icons）、
  `wordmark`、`acct`、`avatar`、`tiles`（theme / lang / lock / palette / layout / share）、`langHref`（另一种语言的同一页）、`pal`（[{id, zh, en, style}]，style = --pl-b1..7 / --pl-f1..6 / --pd-*）、`layout`。
- 「分享本页」磁贴（`tiles.share`）只在子站内容页传 true；主站任何页面都不输出（定案第 4 条，模板层决定，不是 CSS 隐藏）。
- JS：`import { mountTopbar } from './topbar.js'`，把依赖传进去（这几个文件都不 import 任何东西）：
  `mountTopbar({ modalSheet, prefs, ai: mountAiChat, share: mountShare })`；prefs 用 `prefs-write.js` 的
  `isDark / themeMode / setThemeMode / toggleFollowSystem / palette / setPalette / DEFAULT_PALETTE / hasAccent`，`setLang: v => (setLangPref(v), '')`（地址取磁贴的 data-href）。
- 两个窗口是非模态 `<dialog>`，从顶栏下方落下、互斥；系统返回 / Esc / 点遮罩关闭；快捷面板每次打开在第 1 页，页签可点、左右键切，内容横向滑。
- AI：POST /api/ai（同源）→ SSE hits / delta / done；历史只在本地 `sgx-ai-history`（最多 50 条，不进云同步）。

## 子站外观写端（prefs-write.js；改写原「主站写、子站只读」，定案第 5 条）

四站共用一个写端：主站的 cookie 写法（syncUiCookie）就在这个文件里，子站快捷设置调它的 setter：写 localStorage（同源同一份）→ `SgxUI.apply` 重落 `<html>` → 写 `sgx-ui` cookie。
子站写入的外观在本设备生效（回主站即同步）；跨设备以账号云同步为准，云同步覆盖这些设置之前不承诺跨设备。上面「子站读外观」一节的读端照旧。

## 分享本页（share.js，子站快捷面板磁贴；主站不用）

- JS：`mountShare({ button: 磁贴 })`（topbar.js 会对 `[data-qp="share"]` 调传进来的 mountShare）。
  POST https://styrigx.com/api/share（credentials: include；进门二值，不分角色）
  `{action:'create', reuse:true, name:页面标题(24 字), to:当前页(去 lock/why/return/share), hours:24, session:43200}`
  → 带临时会话的短链（服务端同页同档位还剩 ≥ 12 小时就复用）→ `navigator.share`；没有 / 被拒（不是取消）→ 复制 + toast「已复制分享链接」。
  生成中磁贴 `aria-busy` + `.is-busy`，再点不理；失败只 toast，不会把原地址当短链分享。
  服务端回 401 reauth（生成 / 复用短链要锁侧复验，P2-3）→ share.js 自带的最小复验步骤 `lockReauthStep()`（`<dialog class="sgx-share-reauth">`，
  只有锁屏通行密钥 / 解锁密码，设了哪个显示哪个；同源 POST /api/lock-reauth status、/api/lock-password、/api/lock-passkey）→ 通过后自动重试一次；取消 = 不分享。
  toast 是 `.sgx-share-toast`（share.js 自己建）；复验弹层样式 `.sgx-share-reauth*` 在 shell.css 的 topbar-frame 段。
- 尺寸体系（2026-10-23）：`--sgx-page-m`、`--sgx-tb-btn`（顶栏高 52 → 56）、`--sgx-tb-gap`、`--sgx-content-max`（外壳框最宽，默认 1068，本站可改）、
  `--sgx-shell-w` = min(100% − 2 × 页边距, 最宽)。顶栏 = 这个框；子站自己的页面外框用 `width: var(--sgx-shell-w); margin: 0 auto` 就和顶栏对齐。

## 搜索层（search.js + shell.css 的 search 段）

（2026-11-04 P5-1：导航抽屉删了，子站没有入口；主站只剩 Ctrl+K 和首页 ?q=。整套在 P4-2 删除。下面是原说明。）
点导航抽屉底栏的搜索框 → 抽屉原地淡掉，搜索框变形成屏幕底部的搜索栏（药丸 + ✕ 圆，贴键盘），上面是盖住当前页的磨砂结果层
（空输入时背景是放大镜 +「聚合搜索」；输入后是站内结果 / 「用 <引擎> 搜索」；不记搜索历史）。顶栏不动。✕ / 系统返回 / Esc 关闭。不跳页、最多占一条历史。

子站接入（文件原样复制，不改）：
1. `node scripts/sync-shell.mjs` 同步后，`search.js` 放进子站的 JS（建议单独打包、懒加载），`shell.css` 照旧整份引入（含 search 段）。
2. 抽屉底栏的搜索框保持 `<a class="sgx-drawer-search" href="https://styrigx.com/search/">`（没 JS 时进主站搜索）。
3. 打开抽屉时（或按下九宫格 / 搜索框的 pointerdown）`import()` search.js，拿到后 `const s = mountSearch(cfg)`（每页一次）。
4. 搜索框 click 里 **同步** 调用（安卓只在用户手势里同步 focus 才弹键盘）：
   `e.preventDefault(); s.open({ from: a, ghost: drawerDialog, handoff: () => { 同步关掉抽屉 <dialog>（不要 history.back）; return 抽屉是否 push 过历史哨兵; } })`
   handoff 返回 true 时搜索层把那条哨兵改成自己的（replaceState），不再新增历史。
5. 可选：页面带 `?q=` 时 `s.open({ q, focus: true })`（主站的 /search/?q= 和 opensearch 就是这样进来的）。

`mountSearch(cfg)` 配置（都可省）：
| 键 | 默认 | 说明 |
|---|---|---|
| lang | 按 `<html lang>` | 'zh' / 'en' 文案 |
| index | null | 站内索引地址（files-index.json 格式 `{items:[{type,lang,title,subtitle,url}]}`）；null = 只有引擎搜索 |
| types | [] | 要列出的索引类型和分组名，如 `[{type:'post',zh:'博客',en:'Blog'}]` |
| engineKey / engine | sgx-search-engine / — | 引擎设置（google / bing / duckduckgo / yahoo / ecosia）；engine() 优先 |
| navigate | location.href = url | 打开同源结果（先关层、退掉哨兵再调用）；跨源结果新标签打开 |
| strings | — | 覆盖文案 |
| root | document.body | 挂载点 |

返回 `{ open(opts), close(after?), isOpen(), input, layer, bar }`。open(opts)：from（变形起点元素）、ghost（正在关的抽屉 <dialog>）、handoff、q、focus（默认 true）。
回车：方向键选中的行 → 打开；标题和输入完全一样的站内结果 → 打开；像网址 → 新标签 https://；否则用引擎搜（新标签）。
