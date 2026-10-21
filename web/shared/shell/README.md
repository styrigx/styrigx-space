# web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark、styrigx-curio）共用的外壳：色彩角色、顶栏材质、导航抽屉、自定义主题色引擎、抽屉项、外观 cookie 读端、标签页图标。

- 源头：`web/data/palette-roles.json`、`web/assets/css/input.css` 的 `@shell:begin/end` 段、`web/assets/js/lib/palette-scheme.js`、
  `web/data/shell-nav.json`、`web/layouts/partials/icon.html`、`web/layouts/partials/shell-wordmark.html`（抽屉头字标，进 nav.json 的 `wordmark`）。改源头后跑 `node scripts/gen-shell.mjs`；CI 用 `--check` 核对。
- 子站同步：在子站仓库跑 `node scripts/sync-shell.mjs`（默认 ref=main，可 `--ref <分支或提交>`），
  它按 `manifest.json` 从 raw.githubusercontent.com 拉这些文件、逐个校验 sha256，写进子站的标记段 / 供应商目录。
- 主题跨站：主站把外观写进 `sgx-ui` cookie（Domain=styrigx.com）：`pal` = 预设 id，`accent` = 当前种子 #rrggbb。
  子站：`accent` 等于该预设种子 → 只设 `data-palette`；不等 → 自定义色，用 `palette-scheme.js` 的 `rolesCss(seed)` 算整套角色。

## 子站读外观：ui-cookie-read.js（只读，永远不写 sgx-ui）

经典脚本、ES5、无依赖，挂 `window.SgxUI`。`<head>` 里、样式表之后、任何内容之前，**原样内联**，紧跟一行调用：

```html
<script>/* ui-cookie-read.js 原文（Hugo：resources.Get … | minify，.Content | safeJS） */</script>
<script>SgxUI.apply(document.documentElement, { onMiss: function (seed) { /* 异步加载 palette-scheme.js，算好 SgxUI.setRoles(seed, rolesCss(seed)) */ } });</script>
```

- `SgxUI.read()` → 校验过的 `{v, mode, pal, accent, fs, rm, mat, tz1, tz2, h12, clock, wx, unit, loc, city, precise}`；没有 / 乱码 / 版本不认识 → `null`。
- `SgxUI.apply(root, opts)` → `<html>` 落成和主站一样：`class="dark"`、`data-theme-mode`、`data-dark`、`font-size` + `data-font-size`、
  `data-palette`（lake 不写）、自定义色时内联 `--sgx-seed` + `<style id="sgx-accent-roles">`（本站 localStorage `sgx-shell-accent-css` 缓存，首行「SCHEME_VER|#种子」）、
  `class="reduced-motion"` + `data-reduced-motion`。跟随系统时自动监听 `prefers-color-scheme`。cookie 坏了 = lake + 跟随系统，不抛错、不跳转。
  `opts.rolesCss`：同步可用的引擎；`opts.onMiss(seed)`：没缓存时回调；`opts.watch: false`：不监听。
- 子站要的 CSS：`tokens.css`（33 套预设 + 别名层）+ `shell.css`（含字标 `.wm-dot` = `--sgx-primary`）。抽屉头用 `nav.json` 的 `wordmark` SVG。
- 读端不认 `theme` 别名和大写 accent（写端从不写）；自定义色的种子在内联 `--sgx-seed`（不再用 `data-sgx-seed`）。
  站点自己的样式钩子（如博客的 `data-theme` / `color-scheme`）用 `apply()` 的返回值 `{mode, dark, pal, fs, rm, seed}` 自己补。
- sync-shell 的 SITE.targets 加：`ui-cookie-read.js`（kind `file`）、`ui-cookie-contract.json`（kind `json`，原样）、
  `favicon.js`（kind `file`）、`favicon.svg`（要原样写进 `web/static/`：kind `file` 会在顶上加 /* */ 注释，SVG 不认，用 `json` 或加一个 raw 类型）。
- 标签页图标：`favicon.svg` 放站点根 `/favicon.svg`（`<link rel="icon" type="image/svg+xml" href="/favicon.svg">`），
  打包 `favicon.js`（ES 模块）后调 `initFavicon()`：色板 / 自定义色 / 深浅色变了就换成当前主题色。
- 契约测试：`ui-cookie-contract.json` 是主站写端真实写出的 cookie + 期望；子站单测对每个 case 断言 `SgxUI.read('sgx-ui=' + c.cookie)` 等于 `c.read`、
  `SgxUI.resolve(c.read, 系统深色)` 等于 `c.light/c.dark.resolve`（apply 后 `<html>` 等于 `.root`）。sync-shell 拉新版本后跑一遍。
