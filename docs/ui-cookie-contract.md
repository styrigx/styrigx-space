# 外壳 UI cookie 契约：`sgx-ui`（2026-10-26，C10）

> 适用：主站 styrigx-space 写；子站 styrigx-blog / styrigx-daymark / styrigx-curio 只读。
> 本文只描述**现状**（主站 main 上的写端 / 读端 / 夹具），不改任何代码。
> 真源头是代码：写端 `web/assets/js/lib/ui-cookie.js`，字段表 / 版本 / 编解码 `web/assets/js/lib/ui-cookie-read.js`，
> 夹具 `tests/fixtures/ui-cookie-contract.json`（`scripts/gen-ui-cookie-contract.mjs` 跑真写端生成）。本文和代码不一致时以代码为准，并顺手改本文。

## 一、它是什么

主站的外观和时钟 / 天气设置存在主站 localStorage（**唯一来源**）。子站在别的子域，读不到主站 localStorage，
所以主站把这些设置**镜像**到一个 `styrigx.com` 域的 cookie，子站在 `<head>` 里首帧前同步读它，让深浅色、色板、主题色和主站一致、不闪屏。

- 只放 UI 设置，**不放任何凭证 / 会话信息**（会话 cookie 见 `docs/auth-state-machine.md`）。
- 主站写，子站**只读、永远不写** `sgx-ui`。
- 主站自己首帧不读这个 cookie（主站 baseof 内联脚本读 localStorage）；cookie 只是给子站的镜像。

## 二、cookie 本身

```
sgx-ui=<base64url(UTF-8 JSON)>; Domain=styrigx.com; Path=/; Max-Age=34560000; SameSite=Lax; Secure
```

| 属性 | 值 | 说明 |
|---|---|---|
| 名字 | `sgx-ui` | `SgxUI.NAME`（`ui-cookie-read.js`） |
| Domain | `styrigx.com` | 三站共享（`styrigx.com`、`blog.` / `daymark.` / `curio.` 子域都带上） |
| Path | `/` | |
| Max-Age | `34560000`（400 天） | 浏览器上限；主站每次访问都会按需重写，所以旧格式 cookie 最多能活 400 天（见「五、旧数据」） |
| SameSite | `Lax` | |
| Secure | 有 | |
| HttpOnly | **没有** | 子站要用 JS 读 |

**值的编码**：`JSON.stringify(payload)` → UTF-8（中文城市名）→ base64 → `+`→`-`、`/`→`_`、去掉末尾 `=`
（`SgxUI.encode` / `SgxUI.decode`；写端、读端、夹具生成器用同一套）。

**什么时候写**（`syncUiCookie()`，值没变就不重写）：
- 主站每页启动时一次（`web/assets/js/shell/core.js`，老用户补写）；
- 设置变化时（`sgx-settings-changed` 事件）；
- 账号云同步把别的设备的设置拉下来以后（`web/assets/js/lib/cloud-sync.js`）。

## 三、版本

| `v` | 什么时候 | 内容 |
|---|---|---|
| `1` | 5.2 | 只有时钟 / 天气字段，没有外观 |
| `2` | B2-7 起（**写端当前版本**，`SgxUI.V = 2`） | 加外观：`mode` / `pal` / `fs` / `rm` / `mat`；PR3 起加 `accent`；2026-10-23 PR-E 起 `fs` / `rm` 固定写默认值；2026-10-23 PR-G 起 `pal` 不再有撞色 `x<id>` |

读端只认 `SgxUI.VERSIONS = [1, 2]`，而且 `v` 必须是**数字**。`v` 缺失、是字符串（`"2"`）、是别的数字（`3`），
或整个值解不开 / 不是 JSON 对象（数组也不算）→ `read()` 返回 `null`，**当作没有 cookie**（默认 dustyblue + 跟随系统），不抛错、不跳转。

v2 内部的演进（加 `accent`、`fs` / `rm` 固定默认、`x<id>` 合并）都没有升版本：读端对每个字段单独校验，缺了或不合法就按默认，旧 v2 cookie 照样能读。

## 四、字段

写端从主站 localStorage 取值（「来源」列）；读端 `SgxUI.normalize()` **逐字段**校验，不合法只把这一个字段换成默认值，不影响别的字段。

### 外观（v2）

| 字段 | 写端写什么（来源） | 读端接受 | 不合法 / 缺失时 |
|---|---|---|---|
| `mode` | `sgx-theme-mode` ∈ `system` / `light` / `dark`，否则 `system` | `system` \| `light` \| `dark` | `system` |
| `pal` | `sgx-palette` 经 `SgxUI.normPal()`：旧撞色 `x<id>` → `<id>`，不认识的 id → `dustyblue` | 已知预设 id（`SgxUI.PRESETS` 的键，22 套）；`x<id>` 且 `<id>` 已知 → `<id>` | `dustyblue` |
| `accent` | 当前主题色种子 `#rrggbb`，**永远小写**：自定义 `sgx-accent` 优先，否则 `<html>` 上计算出的 `--sgx-seed`（= 当前预设的种子）；都读不到写 `''` | 严格 `^#[0-9a-f]{6}$`（大写、简写 `#abc` 都不认） | `''` |
| `fs` | 固定 `standard`（2026-10-23 PR-E 删了字体大小设置，旧 `sgx-font-size` 不再带出去） | `standard` \| `small` \| `large` | `standard` |
| `rm` | 固定 `0`（同上删了减弱动效设置；子站减弱动效跟系统 `prefers-reduced-motion`） | 只有数字 `1` 算开 | `0` |
| `mat` | `mode` 最近一次变化的毫秒时间戳：`mode` 没变沿用旧 cookie 的 `mat`，变了（或第一次写）记 `Date.now()` | 有限、≥ 0 的数字 | `0` |

`accent` 的含义靠和预设种子比较（`SgxUI.resolve()`）：
- `accent` 等于 `pal` 的**当前**种子（`PRESETS[pal]`）或**旧**种子（`LEGACY_SEEDS[pal]`，PR-G 七色调色板之前的单色种子）→ 用预设色板，只设 `data-palette`；
- 不等 → **自定义主题色**：`--sgx-seed` 内联到 `<html>`，整套角色由共享外壳 `palette-scheme.js` 的 `rolesCss(seed)` 算，写进 `<style id="sgx-accent-roles">`，
  缓存在**子站自己的** localStorage `sgx-shell-accent-css`（首行 `SCHEME_VER|#种子`）。
- `''` → 用预设。

### 时钟 / 天气（v1 起）

| 字段 | 写端来源 | 读端接受 | 默认 |
|---|---|---|---|
| `tz1` | `sgx-tz1-auto` 为真（缺失或非 `"0"`）写 `auto`，否则 `sgx-tz1` | `auto` 或 `^[A-Za-z0-9_+\-/]{1,64}$` | `auto` |
| `tz2` | `sgx-tz2` | 同上正则 | `''` |
| `h12` | `sgx-hour12 === "12"` → `1` | 只有数字 `1` | `0` |
| `clock` | `sgx-gl-clockstyle === "1"` → `analog` | `analog` \| `digital` | `digital` |
| `wx` | `sgx-weather-show` 非 `"0"` → `1` | 只有数字 `0` 算关 | `1` |
| `unit` | `sgx-temp-unit === "f"` → `f` | `f` \| `c` | `c` |
| `loc` | `sgx-weather-loc`，缺省 `auto` | `^[a-z]{1,16}$` | `auto` |
| `city` | `sgx-weather-city`（JSON 对象，如 `{"name":"上海","lat":31.23,"lon":121.47}`） | 普通对象 | `null` |
| `precise` | `sgx-weather-precise`（JSON 对象） | 普通对象 | `null` |

`sgx-weather`（天气数据缓存）不进 cookie。

### 不在契约里的字段

- `theme`：旧博客契约里 `mode` 的别名。**写端从不写，读端不认**（夹具用例「theme 别名（旧博客契约）不认，只看 mode」）。
- `lang`：子站读端在读（跟主站语言跳页），但**主站写端现在不写**，`SgxUI.read()` 也不返回它；子站的语言跟随在主站加这个字段之前不会触发。要加见「七」。
- 其他未知字段：读端忽略。

## 五、旧数据迁移（读端负责，写端只写新格式）

cookie 最长活 400 天，所以旧格式都要能读：

| 旧数据 | 读端怎么处理 |
|---|---|
| v1（没有外观字段） | 外观全按默认；`v1` 里如果带了 `fs` / `rm`，照样生效（夹具「旧 v1 带 fs / rm」） |
| v2、PR3 之前（没有 `accent`） | `accent = ''` → 用预设 |
| 撞色 id `x<id>`（2026-10-23 PR-G 之前） | `normPal()` 迁到 `<id>`；`x` 开头但 `<id>` 不认识（如 `xneon`）→ `dustyblue` |
| `accent` = 旧预设种子（PR-G 之前） | 和 `LEGACY_SEEDS[pal]` 相等就当预设，不当自定义色 |
| `fs` / `rm` 的旧值 | 读端仍认（v2 字段没删）；写端从 PR-E 起只写默认值，主站下次重写后旧值自然消失 |

`LEGACY_SEEDS` 是手写的固定表（PR-G 之前的种子），**不随引擎变，不要改**；`PRESETS` / `SCHEME_VER`（`@ui-cookie-presets` 段）由 `scripts/gen-shell.mjs`
按 `web/data/palette-roles.json` 重写，**不要手改**。

## 六、读端落到 `<html>` 的状态

共享读端 `SgxUI.apply(root, opts)` 落的状态和主站 baseof 内联脚本一致（夹具每个用例的 `light.root` / `dark.root`）：

| 状态 | 规则 |
|---|---|
| `class="dark"`、`data-dark="1|0"` | `mode === 'dark'`，或 `mode === 'system'` 且系统深色 |
| `data-theme-mode` | `mode` |
| `style.fontSize`、`data-font-size` | `large` → `112.5%`、`small` → `87.5%`、`standard` → 不设 |
| `data-palette` | `pal`；默认 `dustyblue` **不写**（`tokens.css` 里 `:root` 本身就是 dustyblue） |
| 内联 `--sgx-seed` + `<style id="sgx-accent-roles">` | 只有自定义主题色时有（不再用 `data-sgx-seed`） |
| `class="reduced-motion"`、`data-reduced-motion` | `rm === 1` |

跟随系统时读端挂一次 `prefers-color-scheme` 监听，系统一变就重落。站点自己的样式钩子（如博客的 `data-theme` / `color-scheme`）用 `apply()` 的返回值 `{mode, dark, pal, fs, rm, seed}` 自己补。

## 七、谁在读、在哪读（2026-10-26 现状）

共享外壳分发的读端是 `web/shared/shell/ui-cookie-read.js`（= `web/assets/js/lib/ui-cookie-read.js` 原样），契约夹具是 `web/shared/shell/ui-cookie-contract.json`
（= `tests/fixtures/ui-cookie-contract.json` 原样），接入说明见 `web/shared/shell/README.md`。
**但三个子站目前都还没内联这个共享读端**：各自的 `sync-shell.mjs` 只把它记进 `sgx-shell.lock.json`，没有写进仓库；页面用的是各站自己的实现：

| 站 | 读 `sgx-ui` 的文件 | 首帧前怎么跑 |
|---|---|---|
| 主站（自检） | `web/assets/js/lib/ui-cookie-read.js`（写端 `ui-cookie.js` import 它拿字段表） | 主站页面不读 cookie；`tests/web/ui/ui-cookie-contract.test.mjs`、`tests/web/e2e/ui-cookie-reader.spec.js` 用它验契约 |
| styrigx-blog | `web/layouts/partials/sgx-inherit.html`（内联脚本）；自定义色异步部分 `web/assets/js/entries/inherit.ts` | partial 直接内联进 `<head>` |
| styrigx-daymark | `web/assets/js/sgx/lib/ui-inherit.js` | `web/assets/js/sgx/ui-inherit-run.js` 经 `js.Build` 打成 IIFE，由 `web/layouts/_default/baseof.html` 内联 |
| styrigx-curio | `web/assets/js/sgx/lib/ui-inherit.js` | 同 daymark：`ui-inherit-run.js` → `baseof.html` 内联 |

这些子站实现和本契约有已知出入（版本不校验、仍认 `theme` 别名、大写 `accent`、不认 `LEGACY_SEEDS`、用 `data-sgx-seed`；daymark / curio 还把默认色板当成 `lake`），
收敛到共享读端是后续任务；在那之前**改契约时要逐个核对这三处实现**。

## 八、怎么安全地改格式

### 兼容的改动（加字段、放宽某个字段的取值）—— 不升 `v`

1. **读端** `web/assets/js/lib/ui-cookie-read.js`：在 `normalize()` 里加字段和它的默认值（不合法 → 默认，绝不抛错）；需要的话改 `resolve()` / `apply()`。
   保持 ES5 经典脚本、无依赖、从不写 cookie（单测会查）。
2. **写端** `web/assets/js/lib/ui-cookie.js`：`syncUiCookie()` 的 payload 加字段，取值只来自主站 localStorage。
3. **夹具用例** `scripts/gen-ui-cookie-contract.mjs`：`WRITER_CASES` 加写端用例（真写端会跑出 cookie），`HANDMADE` 加写端写不出的旧值 / 坏值；
   期望值在这里**按契约手写**，不要拿读端算（读端改错了才会和夹具对不上）。新字段有默认值的，记得改 `BASE` / `V2`。
4. 重新生成并核对：
   ```bash
   node scripts/gen-ui-cookie-contract.mjs          # 重写 tests/fixtures/ui-cookie-contract.json
   node scripts/gen-shell.mjs                       # 把读端 + 夹具原样复制进 web/shared/shell/，更新 manifest.json
   node scripts/gen-ui-cookie-contract.mjs --check  # CI 也跑：写端产出变了 / 夹具被手改 → exit 1
   node scripts/gen-shell.mjs --check
   node --test tests/web/ui/ui-cookie-contract.test.mjs
   ```
   端到端：`tests/web/e2e/ui-cookie-reader.spec.js`（Playwright，需要先 `hugo --minify -s web`）。
5. 主站合并后，**每个子站**：`node scripts/sync-shell.mjs` 拉新外壳（`sgx-shell.lock.json` 跟着变），再按「七」的表改各自的读端和单测 / e2e。
   子站读端要能在主站上线新写端之前、之后都正常（新字段缺失 = 默认）。

### 不兼容的改动（改字段含义、删字段、换编码）—— 升 `v`

- `ui-cookie-read.js` 里 `V` 加一，`VERSIONS` 加上新版本，**旧版本继续留在 `VERSIONS` 里至少 400 天**（cookie 寿命），`normalize()` 按 `v` 分支迁移旧值。
- 先让所有读端（共享读端 + 「七」里的三处子站实现）认识新版本，再上线写端；否则旧读端会把新 cookie 当「没有」（共享读端）或按错的字段解释（目前子站实现不校验版本）。
- 夹具里补「新版本」「旧版本」两类用例；「未知版本 v3」那条用例要换成下一个未用的版本号。
- 其余步骤同上（重生成夹具 → `gen-shell.mjs` → 两个 `--check` → 子站同步并改读端）。

### 不要做的

- 不要手改 `tests/fixtures/ui-cookie-contract.json`、`web/shared/shell/` 下的任何文件、`ui-cookie-read.js` 的 `@ui-cookie-presets` 段——都是生成物，`--check` 会红。
- 不要让子站写 `sgx-ui`，也不要把凭证 / 会话信息放进来。
- 不要改 `LEGACY_SEEDS`。
- 不要把色板改名当成兼容改动：旧 id 要在 `normPal()` 里迁移（参照 `x<id>` → `<id>`），并补夹具用例。

## 九、相关

- `docs/palette-usage.md`：色板 / token 怎么用（「七、子站怎么接」）。
- `docs/auth-state-machine.md`：会话类 cookie（和 `sgx-ui` 无关）。
- `web/shared/shell/README.md`：子站接共享读端的写法。
