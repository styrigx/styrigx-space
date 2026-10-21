# web/shared/shell（生成物，勿手改）

主站（styrigx-space）和子站（styrigx-blog、styrigx-daymark）共用的外壳：色彩角色、顶栏材质、导航抽屉、自定义主题色引擎、抽屉项。

- 源头：`web/data/palette-roles.json`、`web/assets/css/input.css` 的 `@shell:begin/end` 段、`web/assets/js/lib/palette-scheme.js`、
  `web/data/shell-nav.json`、`web/layouts/partials/icon.html`、`web/layouts/partials/shell-wordmark.html`（抽屉头字标，进 nav.json 的 `wordmark`）。改源头后跑 `node scripts/gen-shell.mjs`；CI 用 `--check` 核对。
- 子站同步：在子站仓库跑 `node scripts/sync-shell.mjs`（默认 ref=main，可 `--ref <分支或提交>`），
  它按 `manifest.json` 从 raw.githubusercontent.com 拉这些文件、逐个校验 sha256，写进子站的标记段 / 供应商目录。
- 主题跨站：主站把外观写进 `sgx-ui` cookie（Domain=styrigx.com）：`pal` = 预设 id，`accent` = 当前种子 #rrggbb。
  子站：`accent` 等于该预设种子 → 只设 `data-palette`；不等 → 自定义色，用 `palette-scheme.js` 的 `rolesCss(seed)` 算整套角色。
