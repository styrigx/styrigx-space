# sgx-ui cookie：博客这一侧

> 状态：现行 ｜ 最后更新：2026-11-08

博客是沉浸式 app，没有自己的语言、深浅色、配色开关；这些都在主站旷野页的子页（`https://styrigx.com/theme/`）和快捷面板设置，
主站把结果镜像到 `sgx-ui` cookie（`Domain=styrigx.com`），博客在 `<head>` 里**首帧前同步读取**，不闪屏。博客只读，永远不写 `sgx-ui`。

**契约以主站为准**：cookie 的写法、属性、版本 `v`、每个字段的取值和默认值、旧数据迁移、读端落到 `<html>` 的状态、改格式的步骤，
都见 styrigx-space 的 [docs/ui-cookie-contract.md](https://github.com/styrigx/styrigx-space/blob/main/docs/ui-cookie-contract.md)。
真源头是主站代码：只读解析器 [space/web/assets/js/lib/ui-cookie-read.js](https://github.com/styrigx/styrigx-space/blob/main/space/web/assets/js/lib/ui-cookie-read.js)、
契约夹具 [tests/fixtures/ui-cookie-contract.json](https://github.com/styrigx/styrigx-space/blob/main/tests/fixtures/ui-cookie-contract.json)。
本文件只记博客独有的部分，不再重复字段表。

## 博客在哪读

- `space/web/layouts/partials/blog/sgx-inherit.html`：`<head>` 内联脚本，渲染前同步执行。
- `space/web/assets/blog/js/entries/inherit.ts`：自定义主题色没有缓存时，按需 import 共享外壳的 `palette-scheme.js` 算整套角色，插进 `<style id="sgx-accent-roles">` 并缓存到本站 localStorage `sgx-shell-accent-css`。
- 单测 `tests/blog/sgx-inherit.test.mjs`，端到端 `tests/blog/e2e/sgx-inherit.spec.js`、`tests/blog/e2e/app-topbar.spec.js`。

## 博客自己加的

| 项 | 说明 |
| --- | --- |
| `<html data-theme="light\|dark">`、`color-scheme` | 博客 `one-ui.css` 的样式钩子，跟着落下来的深浅色走；跟随系统时系统一变就重落 |
| `lang`（`zh` \| `en`） | **不在主站契约里**，主站写端目前也不写，所以下面这条现在不会触发。和当前页语言不同、且本页确有另一语言版本（`<meta name="sgx-alt-zh\|en">`）时 `location.replace` 过去（保留 `#hash`），爬虫不跳，没有译文的文章留在原页。cookie 里没有 `lang` 时沿用旧行为：只有中文首页 `/` 按 `localStorage['styrigx-blog-lang']` / 浏览器语言跳 `/en/` |
| 清旧本地键 | `navfolio-theme`、`sgx-theme-at`（原博客主题开关留下的，会盖过主站设置）每次加载时删除 |

## 强调色用在哪

`--sgx-accent` / `--sgx-on-accent`：列表页分段滑块的指示器、导航抽屉的当前项、文章页长条底边的阅读进度细线、抽屉目录的当前节、
专题里选中的筛选芯片、文章的「第 n / N 篇」徽标。

## 和主站契约一致

`sgx-inherit.html` 的第一个 `<script>` 就是主站读端 `space/web/assets/js/lib/ui-cookie-read.js` 原样（压缩后内联；2026-11 合站后博客和主站同一个 Hugo 站，直接用同一份，没有副本），
外观全部由 `SgxUI.apply()` 落；博客脚本只补上面「博客自己加的」几项。
`tests/blog/sgx-inherit.test.mjs` 用主站契约夹具 `tests/fixtures/ui-cookie-contract.json` 逐条跑「共享读端 + 博客脚本」，
每个用例在系统浅色 / 深色下 `<html>` 的状态都要和夹具一致。主站改了契约，单测就会按新夹具检查。
