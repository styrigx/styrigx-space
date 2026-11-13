# 外观 cookie `sgx-ui` 契约

| 项 | 值 |
|---|---|
| 文档编号 | SGX-SPEC-003 |
| 版本 | 3.0 |
| 日期 | 2026-11-12 |
| 状态 | 现行 |
| 取代 | `docs/ui-cookie-contract.md`、`docs/blog/sgx-ui-cookie.md` |

## 1. 范围

`sgx-ui` 把主站的外观与语言偏好镜像给子站，使子站首帧（`<head>` 同步脚本）就能落下与主站一致的调色板（深浅随调色板）和语言，不闪屏。

真源头是代码，本文与代码冲突时以代码为准：

| 角色 | 文件 |
|---|---|
| 字段表、版本、编解码、读端 `SgxUI` | `space/web/assets/shell/js/prefs/ui-cookie-read.js` |
| 写端 `syncUiCookie()` | `space/web/assets/shell/js/prefs/prefs-write.js`（`prefs/ui-cookie.js` 只转导出） |
| 首帧语言跳转 | `space/web/assets/shell/js/i18n/lang-boot.js` |
| 契约夹具 | `tests/fixtures/ui-cookie-contract.json`（`space/scripts/gen-ui-cookie-contract.mjs` 跑真写端生成） |

## 2. 不变式

2.1 `sgx-ui` MUST 只含 UI 设置，MUST NOT 含任何凭证或会话信息。

2.2 偏好的唯一来源是同源 localStorage（`sgx-palette`、`sgx-lang` 等；3.0 起 `sgx-theme-mode`、`sgx-accent` 删除，首帧清掉旧值）；cookie 只是镜像。主站首帧读 localStorage，不读 cookie。

2.3 四站共用一个写端：主站在启动、`sgx-settings-changed`、云同步拉取之后写；子站只在快捷面板改外观时写（先写 localStorage，再写 cookie）。值没变时 MUST NOT 重写。

2.4 读端 MUST NOT 抛错：任何解不开、版本不认识的值都按「没有 cookie」处理，单个字段不合法只把该字段换成默认值。

## 3. Cookie 本身

```
sgx-ui=<base64url(UTF-8 JSON)>; Domain=styrigx.com; Path=/; Max-Age=34560000; SameSite=Lax; Secure
```

| 属性 | 值 | 说明 |
|---|---|---|
| Max-Age | 34560000（400 天） | 浏览器上限；旧格式最多活 400 天 |
| HttpOnly | 无 | 子站要用 JS 读 |

编码：`JSON.stringify` → UTF-8 → base64 → `+`→`-`、`/`→`_`、去掉末尾 `=`（`SgxUI.encode` / `decode`，写端、读端、夹具生成器同一套）。

## 4. 版本

| `v` | 内容 |
|---|---|
| `1` | 早期版本，只有时钟 / 天气字段，没有外观 |
| `2` | **写端当前版本**（`SgxUI.V = 2`）：外观 `pal` / `fs` / `rm` + 语言 `lang`（3.0 起不再写 `mode` / `accent` / `mat`） |

4.1 读端只认 `SgxUI.VERSIONS = [1, 2]`，且 `v` 必须是数字；否则 `read()` 返回 `null`（默认 terra，深套）。

4.2 v2 内部的兼容演进（加 `accent`、`lang`，`fs` / `rm` 固定默认，撞色 id 合并，3.0 删 `mode` / `accent` / `mat`）没有升版本：读端逐字段校验，旧字段忽略。

## 5. 字段（v2）

| 字段 | 写端写什么 | 读端接受 | 默认 |
|---|---|---|---|
| `pal` | `sgx-palette` 经 `normPal()`（旧撞色 `x<id>` → `<id>`，不认识 → `terra`） | 已知预设 id（22 套） | `terra` |
| `fs` | 固定 `standard`（字体大小设置已删） | `standard` \| `small` \| `large` | `standard` |
| `rm` | 固定 `0`（减弱动效跟系统 `prefers-reduced-motion`） | 只有数字 `1` 算开 | `0` |
| `lang` | `sgx-lang` 是已配置的语言（`en` / `zh`）时原样写，否则写 `system` | `^[a-z]{2,3}$` | `system` |

5.1 旧 cookie 里的 `mode`、`accent`、`mat`（3.0 之前写端写过）读端一律忽略：深浅只看 `pal` 是浅套还是深套（`SgxUI.DARK`），不内联 `--sgx-seed`、不插 `<style id="sgx-accent-roles">`；`apply()` 顺手删掉旧版插的 `<style>` 和子站缓存 `sgx-shell-accent-css`。

5.2 早期 v1 的时钟 / 天气字段（`tz1`、`tz2`、`h12`、`clock`、`wx`、`unit`、`loc`、`city`、`precise`）自 P4-2c（2026-11-05）起写端不再写，读端忽略。

5.3 未知字段（含旧博客契约的 `theme` 别名）读端忽略。

## 6. 读端落到 `<html>` 的状态（`SgxUI.apply(root)` / `SgxUI.paint(pal, root)`）

| 状态 | 规则 |
|---|---|
| `class="dark"`、`data-dark` | `pal` 是深套（14 套；8 套浅套不加） |
| `<meta name="color-scheme">` / `<meta name="theme-color">` | 该套的 `light` / `dark` 与底色 |
| `style.fontSize`、`data-font-size` | `large` → 112.5%，`small` → 87.5%，`standard` 不设 |
| `data-palette` | `pal`；默认 terra 不写 |
| `class="reduced-motion"`、`data-reduced-motion` | `rm === 1` |

读端不读 `prefers-color-scheme`、不挂监听。`apply()` 返回 `{ dark, pal, fs, rm }`，站点自己的样式钩子用它补；四站换调色板都走 `paint()`，之后派发 `sgx-theme-changed`。

## 7. 语言

7.1 语言跳转不在 `apply()` 里，由四站同一份 `lang-boot.js` 在首帧前完成：偏好取 localStorage `sgx-lang`，没有明确值时取 cookie 的 `lang`。

7.2 明确选择 EN / 中文：每一页都跳到所选语言的同一页（`location.replace`，保留查询串与 `#`）。

7.3 Auto（`system`）：按 `navigator.languages`（含 `zh*` 为中文，否则英文），且只在「从站外进主站首页」（`/` ↔ `/zh/`）时跳；深链、分享链接、站内回首页都不跳。

7.4 页面用 `<meta name="sgx-alt-<语言>">` 声明自己有哪些语言版本时，只跳到声明过的地址；声明了但没有该语言则不跳。爬虫不跳。

## 8. 修改契约

### 8.1 兼容改动（加字段、放宽取值）—— 不升 `v`

1. 读端 `normalize()` 加字段与默认值（不合法 → 默认，绝不抛错）；保持 ES5 经典脚本、无依赖、从不写 cookie。
2. 写端 `syncUiCookie()` 的 payload 加字段，取值只来自同源 localStorage。
3. `gen-ui-cookie-contract.mjs`：`WRITER_CASES` 加写端用例，`HANDMADE` 加写端写不出的旧值 / 坏值；期望值按契约手写，MUST NOT 用读端计算。
4. 重新生成并核对：

```bash
node space/scripts/gen-ui-cookie-contract.mjs
node space/scripts/gen-shell.mjs
node space/scripts/gen-ui-cookie-contract.mjs --check
node space/scripts/gen-shell.mjs --check
node --test tests/space/ui/shell/ui-cookie-contract.test.mjs
```

### 8.2 不兼容改动（改含义、删字段、换编码）—— 升 `v`

- `V` 加一，`VERSIONS` 加新版本；旧版本 MUST 在 `VERSIONS` 里保留至少 400 天。
- 所有读端与写端 MUST 同一次部署。
- 夹具补「新版本」「旧版本」用例；「未知版本」用例换成下一个未用的版本号。

### 8.3 禁止

- MUST NOT 手改生成物：`tests/fixtures/ui-cookie-contract.json`、`space/web/data/shell/`、`space/web/assets/css/shell/`、`ui-cookie-read.js` 的 `@ui-cookie-presets` 段。
- 色板改名 MUST 在 `normPal()` 里迁移旧 id 并补夹具用例。

## 9. 子站读端

9.1 子站模板直接内联主站读端（`resources.Get "shell/js/prefs/ui-cookie-read.js"`），没有副本。各站在读端后面加的一小段：博客 `layouts/partials/blog/sgx-inherit.html`，奇趣 / 日刻 `assets/<站>/js/sgx/ui-inherit-run.js`。

9.2 博客 `sgx-inherit.html` 有三个 `<script>`：① `lang-boot.js`；② `ui-cookie-read.js`；③ 博客胶水（只管外观）。（3.0 起 `entries/inherit.ts` 删除，子站不再加载 `palette-scheme.js`。）

9.3 博客自己加的：`<html data-theme="light|dark">` 与 `color-scheme`（博客 `one-ui.css` 的样式钩子）；每次加载删除旧本地键 `navfolio-theme`、`sgx-theme-at`、`sgx-theme-mode`、`sgx-accent`、`sgx-accent-css`；收到 `sgx-theme-changed` 时重落。博客的强调色 `--sgx-accent` / `--sgx-on-accent` 用于分段滑块指示器、抽屉当前项、阅读进度线、目录当前节、选中芯片与系列徽标。

9.4 测试：`tests/blog/sgx-inherit.test.mjs` 用共享夹具逐条跑「共享读端 + 博客胶水」，系统浅色 / 深色两遍 `<html>` 状态都要与夹具一致（且两遍相同）；e2e `tests/blog/e2e/sgx-inherit.spec.js`、`app-topbar.spec.js`；主站 `tests/space/e2e/topbar/ui-cookie-reader.spec.js`。

## 10. 修订记录

| 版本 | 日期 | 内容 |
|---|---|---|
| 3.0 | 2026-11-12 | 删 `mode` / `accent` / `mat`；深浅随调色板；默认 terra；`paint()`；首帧清旧键与旧缓存 |
| 2.0 | 2026-11-09 | 合站后整理 |
