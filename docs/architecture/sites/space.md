# 主站（space）

> 已被 v6 定稿取代（见 `docs/decisions/ADR-0006-identity-v6.md`）。

| 项 | 值 |
|---|---|
| 文档编号 | SGX-ARCH-010 |
| 版本 | 1.1 |
| 日期 | 2026-11-11 |
| 状态 | 现行 |

## 1. 范围

主站 `https://styrigx.com/`（英文默认）与 `/zh/`（中文），以及四站共用的外壳。外观规则见 SGX-DES-002，进站流程见 SGX-SPEC-001。

## 2. 页面

| 地址 | 模板 | 入口脚本 | 内容 |
|---|---|---|---|
| `/`、`/zh/` | `layouts/index.html` | `apps/entries/entry-space.js` | 首页：hero（状态胶囊 · `$ whoami` · 名字 · `$` 标语 · `#` 签名）+ about 卡（neofetch 风格，`#about`，提示符跟身份，v5 S7；首页不再嵌终端）；下面几节 `[01]` 博客最新 3 篇、`[02]` 奇趣目录卡、`[03]` 日刻今日一句 |
| `/status/`、`/zh/status/` | `layouts/_default/status.html` | `apps/entries/entry-space-status.js` | 状态页：`#status`（服务状态，读 `/api/status`，要进站；页底进站凭证使用记录读 `/api/space-audit`）。不在导航 01–04 里，入口是导航面板 STATUS 区的按钮和面板页脚 `systemctl status ›`。about 卡 v5 S7 起只在首页 |
| `/404.html` | `layouts/404.html` | — | 404 |

2.1 首页 `$` 行只打字轮播英文标语 `hugo.yaml` 的 `params.tagline`（中英页面相同，不翻译；`apps/home-typer.js`，减弱动效时静止）。`#` 行显示账号个人资料的签名 motto：首帧用 `data/common/profile.yaml` 的默认值，随后 `prefs/profile.js` 以 `/api/profile` 覆盖；空值时整行隐藏，不截断、不翻译。

2.2 v5 S3 起页面两态内容相同，站点核心不再剥掉任何内容（`SGX-DESKTOP` 标记已从模板删除）。

2.3 已退役的页面由 `static/_redirects` 301：`/wild/` → `/status/`（2026-11-12 旷野删除）；`/about/` → `/#about`（`/wellbeing/` v6 P4 删除）；`/theme/` → `/`；`/account/*` → `/#acct=<层>`；`/security/*` → `/#sec…`；`/owner/` → `/#sec=keys`；`/chat/`、`/search/`、`/browser/*`、`/files/*` → `/`。

2.4 版本号唯一来源 `space/web/data/common/version.yaml`（`ui`、`sgx` 两个字段），模板缺字段即构建失败。

## 3. 外壳组件

| 组件 | 代码 | 说明 |
|---|---|---|
| 顶栏 | `layouts/partials/common/frame/topbar.html`、`assets/common/css/` | 顶栏 E（v5 S6）：盾牌 · 调色 · 导航四格 │ `>_` 终端 · 头像；底边滑页进度条 |
| 导航面板 | `#sgx-nav`，`topbar/panel.js` | 顶栏四格打开；站点导航、语言与布局两行 Auto 控件、分享本页（v5 S6 去掉 lock 按钮） |
| 快捷面板 | `#sgx-qp`，`topbar/quick-panel.js` | 调色打开；深浅色、调色板 |
| 终端 | `#sgx-term`，`term/terminal.js` + `term/` | 全站唯一终端（v5 S5）：顶栏 `>_`、`Ctrl / ⌘ K`、盾牌、上锁部件打开；桌面居中大窗、手机整块卡片；钥匙层 `shell/space/layer.js`、账号层 `account/cmd/layer.js` 共用输入行（ADR-0005） |
| AI 窗 | `#sgx-ai`，`ai/panel.js` | 右下浮钮展开；手机是悬浮卡；未进站时模型小矩形是锁标，点击打开终端 |
| 盾牌 | `.sgx-tb-shield` | 不开窗口：访客点 → 终端预填 `sudo styrigx`；已进站点 → 终端问「退出进站会话 [y/N]」 |
| 账号卡片 | `#sgx-acct`，`account/window.js` | 头像打开（只在已进站时；访客态头像是死按钮）；S9 起只展示，点一行 = 终端预填命令 |
| 进站守卫 | `auth/guard.js` | 已进站页面的自动回锁 |
| 页脚 | `layouts/partials/common/frame/footer.html` | rss / github / x 与构建号 |

3.1 子站直接使用主站的这些 partial 与 JS（`space/web/layouts/<站>/baseof.html` 引用），MUST NOT 复制。

## 4. 数据与状态

4.1 外观、语言、布局偏好存在主站 localStorage（`sgx-*` 键）；镜像到 `sgx-ui` cookie 供子站首帧读取（SGX-SPEC-003）。

4.2 账号已登录时 `prefs/cloud-sync.js` 把 `sgx-` 开头的白名单设置同步到 `/api/prefs`（需要作用域 `prefs.sync`）。

4.3 数字健康（`/api/wellbeing`、旷野 `#screen-time`，旷野 2026-11-12 删除）v6 P4 整套删除（定稿 v5.5 §四）。

## 5. 测试

主站前端单测 `tests/space/ui/<功能>/`；e2e `tests/space/e2e/<功能>/`（`lock`、`passkey`、`edge` 等套件见 SGX-OPS-001）。
