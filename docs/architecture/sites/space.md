# 主站（space）

| 项 | 值 |
|---|---|
| 文档编号 | SGX-ARCH-010 |
| 版本 | 1.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |

## 1. 范围

主站 `https://styrigx.com/`（英文默认）与 `/zh/`（中文），以及四站共用的外壳。外观规则见 SGX-DES-002，进站流程见 SGX-SPEC-001。

## 2. 页面

| 地址 | 模板 | 入口脚本 | 内容 |
|---|---|---|---|
| `/`、`/zh/` | `layouts/index.html` | `entries/entry-space.js` | 首页：hero（状态胶囊 · `$ whoami` · 名字 · `$` 标语 · `#` 签名）+ 内嵌终端；下面四节 `[01]` 博客最新 3 篇、`[02]` 奇趣目录卡、`[03]` 日刻今日一句、`[04]` 旷野两张小终端卡（screen-time / status） |
| `/wild/`、`/zh/wild/` | `layouts/_default/wild.html` | `entries/entry-space-wild.js` | 旷野：`#screen-time`（数字健康）、`#status`（服务状态，读 `/api/status`；页底进站凭证使用记录读 `/api/space-audit`）、`#about`（关于，版本号读 `data/version.yaml`） |
| `/404.html` | `layouts/404.html` | — | 404 |

2.1 首页 `$` 行只打字轮播英文标语 `hugo.yaml` 的 `params.tagline`（中英页面相同，不翻译；`apps/home-typer.js`，减弱动效时静止）。`#` 行显示账号个人资料的签名 motto：首帧用 `data/profile.yaml` 的默认值，随后 `lib/profile.js` 以 `/api/profile` 覆盖；空值时整行隐藏，不截断、不翻译。

2.2 首页在锁屏态由站点核心剥掉 `<!-- SGX-DESKTOP-START -->` 与 `<!-- SGX-DESKTOP-END -->` 之间的内容。模板 MUST 用 `safeHTML` 输出这两个标记（Go 模板会删掉普通 HTML 注释）。

2.3 已退役的页面由 `static/_redirects` 301：`/status/`、`/about/`、`/wellbeing/` → `/wild/#…`；`/theme/` → `/`；`/account/*` → `/#acct=<层>`；`/security/*` → `/#sec…`；`/owner/` → `/#sec=keys`；`/chat/`、`/search/`、`/browser/*`、`/files/*` → `/`。

2.4 版本号唯一来源 `space/web/data/version.yaml`（`ui`、`sgx` 两个字段），模板缺字段即构建失败。

## 3. 外壳组件

| 组件 | 代码 | 说明 |
|---|---|---|
| 顶栏 | `layouts/partials/shell-topbar.html`、`assets/css/shell/` | 贴顶通栏；字标（`❯` + wordmark）· 图标组（调色盘 · 盾牌 │ `>_` · 头像）；底边滑页进度条 |
| 导航面板 | `#sgx-nav`，`shell/topbar-panel.js` | 顶栏 `>_` 打开；站点导航、语言与布局两行 Auto 控件、分享本页、立即锁屏 |
| 快捷面板 | `#sgx-qp`，`shell/quick-panel.js` | 调色盘打开；深浅色、调色板 |
| 终端抽屉 | `shell/terminal.js` | 任意页 `Ctrl K` 打开；首页内嵌同一个实例 |
| AI 窗 | `#sgx-ai`，`shell/ai-panel.js` | 右下浮钮展开；手机是悬浮卡 |
| 盾牌下拉 | `shell/space/shield.js` | 进站凭证、临时钥匙、分享链接、立即锁屏 |
| 账号下拉 | `shell/account/term.js` | 头像打开；`sudo root` / `reauth` / `reset`、个人资料、设备、应用授权 |
| 锁屏 | `shell/space/guard.js` → `entry.js`、`term.js`、`reset.js` | 见 SGX-SPEC-001 |
| 页脚 | `layouts/partials/sgx-footer.html` | rss / github / x 与构建号 |

3.1 子站直接使用主站的这些 partial 与 JS（`space/web/layouts/<站>/baseof.html` 引用），MUST NOT 复制。

## 4. 数据与状态

4.1 外观、语言、布局偏好存在主站 localStorage（`sgx-*` 键）；镜像到 `sgx-ui` cookie 供子站首帧读取（SGX-SPEC-003）。

4.2 账号已登录时 `lib/cloud-sync.js` 把 `sgx-` 开头的白名单设置同步到 `/api/prefs`（需要作用域 `prefs.sync`）。

4.3 数字健康按天写 `/api/wellbeing`（需要 `wellbeing.write`），旷野 `#screen-time` 读取。

## 5. 测试

主站前端单测 `tests/space/ui/<功能>/`；e2e `tests/space/e2e/<功能>/`（`lock`、`passkey`、`edge` 等套件见 SGX-OPS-001）。
