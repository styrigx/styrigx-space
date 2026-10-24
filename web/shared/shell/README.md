# web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark、styrigx-curio）共用的外壳：色彩角色、顶栏材质、导航抽屉、原地搜索层、自定义主题色引擎、抽屉项、外观 cookie 读端、标签页图标。

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

## 子站读外观：ui-cookie-read.js（只读，永远不写 sgx-ui）

经典脚本、ES5、无依赖，挂 `window.SgxUI`。`<head>` 里、样式表之后、任何内容之前，**原样内联**，紧跟一行调用：

```html
<script>/* ui-cookie-read.js 原文（Hugo：resources.Get … | minify，.Content | safeJS） */</script>
<script>SgxUI.apply(document.documentElement, { onMiss: function (seed) { /* 异步加载 palette-scheme.js，算好 SgxUI.setRoles(seed, rolesCss(seed)) */ } });</script>
```

- `SgxUI.read()` → 校验过的 `{v, mode, pal, accent, fs, rm, mat, tz1, tz2, h12, clock, wx, unit, loc, city, precise}`；没有 / 乱码 / 版本不认识 → `null`。
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
## 顶栏 + 抽屉头头像（2026-10-22 v8，三个站一样）

```html
<div class="sgx-topbar">
  <button class="sgx-tb-nav" aria-controls="sgx-drawer">九宫格图标</button>
  <div class="sgx-tb-pill"><span class="sgx-tb-title">页名</span></div>   <!-- 只有页名，不放图标 -->
  <button class="sgx-tb-end …">本站自己的图标</button>                     <!-- 唯一按站点自定义的位置 -->
</div>
```
- 右圆 `.sgx-tb-end`：52px 圆、材质 / 悬停 / 按下 / 焦点框都在 shell.css；里面放一个 22px 图标。主站 = 快捷面板（`.sgx-tb-end.sgx-tb-quick`，主站 partials/topbar-end.html）；
  子站换成自己的按钮或链接（`<a class="sgx-tb-end" …>` 也行），不要留空（两侧圆要对称）。
- 头像不在顶栏了：抽屉头 = 字标 + 右边的头像圆（`<a class="sgx-drawer-me" href="{nav.me.href}"><img src="{nav.me.avatar}" alt=""></a>`，52px，垂直居中）。
  主站链到账号页；子站用 nav.json 的 `me.href`（默认 https://styrigx.com/）和 `me.avatar`，aria-label 用 `me.zh / me.en`。
- 旧的 `.sgx-tb-me`（顶栏头像圆）、`.sgx-tb-ic`（长条里的图标）样式已从共享外壳删掉，子站同步时一起换新结构。
- 尺寸体系（2026-10-23）：`--sgx-page-m`（左右页边距：< 600 宽 16px，≥ 600 宽 clamp(16px, 5.333px + 2.2222vw, 48px)）、
  `--sgx-tb-btn`（圆按钮 52 → 56）、`--sgx-tb-gap`（8 → 12）、`--sgx-content-max`（外壳框最宽，默认 1068，本站可改）、
  `--sgx-shell-w` = min(100% − 2 × 页边距, 最宽)。顶栏 = 这个框（left / right 0 + margin auto + width，不用 transform），两侧圆外缘 = 框边；
  子站自己的页面外框用 `width: var(--sgx-shell-w); margin: 0 auto` 就和顶栏对齐。< 840 宽的底部搜索栏也对齐这个框。

## 子站顶栏分享按钮（share.js + shell.css topbar-frame 段，2026-10-24；主站不用）

右边的圆换成一个胶囊，装两个按钮（站长和访客一样）：

```html
<div class="sgx-tb-end-group">
  <button type="button" class="sgx-tb-gbtn sgx-tb-share" data-sgx-share aria-label="分享">{nav.icons.share}</button>
  <a class="sgx-tb-gbtn sgx-tb-guestbook" href="/guestbook/" aria-label="留言板">留言板图标</a>
</div>
```
- 胶囊 `.sgx-tb-end-group`：材质 / 高度 / 圆角同两侧圆，宽 = 2 × `--sgx-tb-gbtn`（40px）+ 2 × 2px + 边线 = 86px；里面的 `.sgx-tb-gbtn` 透明，悬停 / 按下 / 焦点框各管各的。
- JS：`import { mountShare } from './share.js'; mountShare();`（每页一次，自己找 `[data-sgx-share]`）。
  站长（`<html data-sgx-role="owner">`）：POST https://styrigx.com/api/share（credentials: include）
  `{action:'create', reuse:true, name:页面标题(24 字), to:当前页(去 lock/why/return/share), hours:24, session:43200}`
  → 带临时会话的短链（服务端同页同档位还剩 ≥ 12 小时就复用）→ `navigator.share`；没有 / 被拒（不是取消）→ 复制 + toast「已复制分享链接」。
  生成中按钮 `aria-busy` + `.is-busy`，再点不理；失败只 toast，不会把原地址当短链分享。
  访客：直接分享当前页地址（不调接口），同样的复制兜底。toast 是 `.sgx-share-toast`（share.js 自己建）。
- 子站 sync-shell 的 SITE.targets 加 `share.js`（kind `file`），和 search.js 一样打包。

## 搜索层（search.js + shell.css 的 search 段）

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
