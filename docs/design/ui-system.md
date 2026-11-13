# 终端风格 UI 系统

| 项 | 值 |
|---|---|
| 文档编号 | SGX-DES-002 |
| 版本 | 1.1 |
| 日期 | 2026-11-11 |
| 状态 | 现行 |

## 1. 范围

四站共用的界面语言：终端风格外观、顶栏、面板、AI 窗、Auto 控件与提示符规则。色彩见 SGX-DES-001；组件代码位置见 SGX-ARCH-010 §3。

## 2. 原则

2.1 **终端风格**。交互以命令行与「提示符 + 命令 + 输出」的形式呈现：全站终端、账号窗口、首页 hero 与 about 卡、AI 窗的消息回显都遵循同一套提示符规则（§7）。等宽字体用 `--sgx-font-mono`。

2.2 **没有弹层**。验证、确认、选择都在命令行或行内完成：
- MUST NOT 使用原生 `alert` / `confirm` / `prompt`（`space/scripts/check/check-frontend.mjs` 规则 1）。
- 底部弹层 `openSheet(` 只许出现在白名单（`SHEET_ALLOW`，现只有 `ui/sheet.js`），新调用一律拦下（规则 3）；选项改行内展开单选。
- 每个终端状态（终端各层、reset、账号窗口）MUST 有退出路径（`^C`、`exit`、`‹ 返回`）。

2.3 **外观改动需要单独确认**。布局、配色、字体、窗口形态的改动 MUST 单独给拥有者看设计，不得夹在一组修复里合并（2026-11-09 手机 AI 底部半屏卡 #351 上线后撤回 #358 的教训）。

2.4 **减弱动效**。遵循系统 `prefers-reduced-motion`：打字轮播、头像外圈转动、滑页过渡在减弱动效时静止。

2.5 **读屏**。装饰性的提示符与命令回显 MUST 对读屏隐藏（`aria-hidden` 或 CSS `content: "…" / ""`），真实内容另给 `sr-only` 文本。

## 3. 布局模式

3.1 只有两种布局：`phone` / `desktop`（界面叫 Mobile / DeX），写在 `<html data-sgx-layout>`；规则在 `assets/common/js/ui/layout-mode.js`（首帧前内联），与 `prefs/prefs.js` `resolveLayout()` 同一条规则（单测对表）。

3.2 偏好存 localStorage `sgx-layout` = `phone` / `auto` / `desktop`（旧值 `mobile` → `phone`，`dex` / `pc` → `desktop`）。

3.3 Auto：视口宽 < 720 CSS px → `phone`；否则浏览器不是手机版网站模式（`navigator.userAgentData.mobile`、UA，或布局视口比屏幕宽 1.25 倍以上的「桌面版网站」虚拟视口）→ `desktop`。视口变化不刷新页面，按 720 线与横竖屏重算。

3.4 手动 DeX + 手机屏时 viewport 固定 980 宽。

## 4. 顶栏

4.1 贴顶通栏（`position: fixed; top: 0`），顶栏 E（v5 S6）：盾牌 · 调色 · 导航四格 │ `>_` 终端 · 头像。盾牌不开窗口（访客点 → 终端预填 `sudo styrigx`；已进站点 → 终端问退出 [y/N]）；访客态头像是死按钮。底边是滑页进度条 `.sgx-tb-prog`。内容宽与页面内容宽一致（`--sgx-content-w` 1080）。

4.2 高度 token `--sgx-tb-h`：桌面 **64px**，手机布局 **56px**（`html[data-sgx-layout="phone"]`，#349）。只收上下留白：图标 40px、头像 30px（外圈 38px）不变。正文偏移 `--nav-h`、面板顶距跟随 `--sgx-tb-h`，MUST NOT 另写死高度。

4.3 头像带白环与绕圈暗光弧，平时慢转（2 秒一圈）、加载 / AI 回答时变快；减弱动效时静止。

4.4 v5 起没有锁屏层：未进站时顶栏照常显示。

## 5. 面板

| 面板 | 打开方式 | 内容 |
|---|---|---|
| 导航面板 `#sgx-nav` | 顶栏四格 | 站点导航（四站）、**语言**与**布局**两行 Auto 控件、分享本页 |
| 快捷面板 `#sgx-qp` | 顶栏调色 | 深浅色、调色板 |
| 终端 `#sgx-term` | 顶栏 `>_`、`Ctrl / ⌘ K`、盾牌、上锁部件 | 全站唯一终端（ADR-0005）；桌面居中大窗、手机整块卡片；Tab 补全、↑ 历史、`Ctrl L` 清屏、`Ctrl C` 中断 |
| 账号窗口 | 顶栏头像（已进站） | — |

三个顶栏窗口（导航、快捷、AI）是非模态 `<dialog>`，互相排斥。

### 5.1 Auto 控件

| 行 | 分段（从左到右） | 值 | 行为 |
|---|---|---|---|
| 语言 | `EN` \| `Auto` \| `中文` | localStorage `sgx-lang` = `en` / `system` / `zh` | 选中即保存。明确选的语言与本页不同 → 去另一种语言的同一页；Auto 跟随浏览器语言，**只在从站外进入主站首页时**切换（SGX-SPEC-003 §7） |
| 布局 | `Mobile` \| `Auto` \| `DeX` | localStorage `sgx-layout` = `phone` / `auto` / `desktop` | 见 §3 |

5.1.1 Auto MUST 位于中间（#343）。语言短名用各自语言的写法，不翻译（`translate="no"`）。

## 6. AI 窗

6.1 右下浮钮 `.sgx-tb-ai` 打开 `#sgx-ai`（手机距边 16px / 底 28px，桌面 32px / 40px，并避让页脚与安全区）。桌面从浮钮向左上展开；**手机为悬浮卡**（底部半屏面板已撤回，#358）。

6.2 头部：`G` 徽标 · Gray AI / 副标题 · 新对话 · 历史 · 头像 · ×。输入框前缀 `ask ›`，方形发送键；回答中可停止；输入框跟随软键盘。

6.3 消息回显（装饰，读屏不念）：
- 提问行：环境提示符 + ` --ask`，即 `styrigx@space:~$ --ask` / `root@account:~# --ask`。
- 回答行（含空态欢迎语）：`grayai@space:~$ --reply`（账号未登录）/ `grayai@account:~# --reply`（账号已登录）。

6.4 回答以 Markdown 渲染；外部模型的网页来源（如有）显示为可点链接。可选模型与默认模型见 ADR-0004。

## 7. 提示符规则

7.1 全站终端的提示符按身份（服务端说了算，`term/core/who.js`；ADR-0005 §2.3）：

| 身份 | 提示符 |
|---|---|
| 访客（nobody） | `nobody@space:~$` |
| 分享链接会话（by=link） | `nobody@space:~#` |
| 已进站（by=password / passkey） | `styrigx@space:~#` |
| 已进站且账号已登录 | `root@account:~#` |
| 进站 reset / 账号 reset | `reset@space:~#` / `reset@account:~#` |

首页 about 卡的提示符跟同一个身份（`[data-sgx-ps]`）。账号窗口（S9 起叫账号卡片）只展示、没有命令行：点一行 = 打开全站终端、预填对应命令（`profile` / `device` / `passkey` / `app` / `exit`）。

7.2 **环境提示符**：其余装饰性提示符（首页 hero、子页窗口与标题行、AI 提问行）按账号登录状态二选一：

| 账号 | 提示符 |
|---|---|
| 未登录 | `styrigx@space:~$` |
| 已登录 | `root@account:~#` |

7.3 首帧由登录标记 cookie `sgx-account-signed-in` 决定（`layout-mode.js` 写 `<html data-sgx-account-session="in">`），`GET /api/account` 返回后校正。模板里两种提示符都写出（`.sgx-envps-g` / `.sgx-envps-r`），由 CSS 按属性显示其一。

7.4 AI 回答行的身份恒为 `grayai`，主机与符号跟随 §7.2：`grayai@space:~$ --reply` / `grayai@account:~# --reply`。

7.5 实现：`term/core/who.js`（`PS_USER`、`PS_RESET`、`ps1`）、`shell/space/commands.js`（`PS_RESET`、`ENV_GUEST`、`ENV_ROOT`、`envPrompt`）、`account/commands.js`（`PS_GUEST`、`PS_ROOT`、`PS_RESET`）、`layouts/partials/common/frame/env-prompt.html`、`input.css` 的 `.sgx-ai-msg::before`。

## 8. 细节约定

8.1 每个终端状态底部有按键提示行（手机显示 `‹ 返回`）；列表有位置计数（`02 / 06`）与结束标记（`-- EOF --` 或闪烁光标）；加载输出为单行 `› fetching …`；顶栏命令链接有按下态。

8.2 首页 `$` 行打字轮播 `params.tagline`；`#` 行显示个人资料签名，空值隐藏（SGX-ARCH-010 §2.1）。

8.3 页脚只有 rss / github / x 三个链接与构建号。
