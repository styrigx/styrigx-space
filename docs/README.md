# styrigx-space 文档索引

| 项 | 值 |
|---|---|
| 文档编号 | SGX-DOC-000 |
| 版本 | 2.2 |
| 日期 | 2026-11-11 |
| 状态 | 现行 |

## 1. 范围

本目录是 styrigx-space 仓库（主站 `styrigx.com` 与子站 `/blog/`、`/curio/`、`/daymark/`，以及 `workers/` 下全部 Cloudflare Worker）的规范书。根目录只保留 `README.md` / `README.en.md`（项目介绍）。

## 2. 约定

2.1 **规范性用语**按 [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) 解释，仅在全大写时具有规范含义：

| 用语 | 含义 |
|---|---|
| MUST / 必须 | 绝对要求 |
| MUST NOT / 禁止 | 绝对禁止 |
| SHOULD / 应当 | 有充分理由时可以偏离，但须理解并权衡后果 |
| SHOULD NOT / 不应 | 同上，反向 |
| MAY / 可以 | 真正可选 |

2.2 **代码优先**。文档描述的是 `main` 上代码的现状，不是独立于代码的硬约束。文档与代码冲突时以代码为准，并 MUST 在同一个 PR 或紧随其后的 PR 里改正文档。

2.3 **过时即改**。过时的文档 MUST 改写或删除，不保留「历史」副本；来龙去脉写进 `decisions/` 的 ADR，或留在 git 历史里。读取文档的测试 MUST 与文档一起更新。

2.4 每份文档开头有编号、版本、日期、状态四项。改动规范性条款时版本号 +0.1（重写 +1.0），日期改为合并当天（Asia/Shanghai）。

2.5 文档 MUST NOT 出现任何密钥、token 的值或内部资源 id（D1 / KV 的 id、Secrets Store id、namespace id 等）；只写名字（Secret 名、绑定名、资源名）。

2.6 正文用中文，技术名词保留英文原文（Worker、binding、cookie、passkey、reauth 等）。术语见 [`glossary.md`](glossary.md)。

## 3. 目录

| 编号 | 文档 | 类型 | 内容 |
|---|---|---|---|
| SGX-DOC-001 | [`glossary.md`](glossary.md) | 参考 | 术语表 |
| SGX-ARCH-001 | [`architecture/overview.md`](architecture/overview.md) | 规范 | 系统总览：请求路径、Worker 分工、前端分层、依赖规则 |
| SGX-ARCH-002 | [`architecture/repo-structure.md`](architecture/repo-structure.md) | 参考 | 仓库目录结构（原根目录 `STRUCTURE.md`） |
| SGX-ARCH-010 | [`architecture/sites/space.md`](architecture/sites/space.md) | 参考 | 主站：首页、状态页、外壳组件 |
| SGX-ARCH-011 | [`architecture/sites/blog.md`](architecture/sites/blog.md) | 参考 | 博客子站 |
| SGX-ARCH-012 | [`architecture/sites/curio-daymark.md`](architecture/sites/curio-daymark.md) | 参考 | 奇趣、日刻两个子站及其接口 Worker |
| SGX-SPEC-001 | [`specs/auth-state-machine.md`](specs/auth-state-machine.md) | 规范 | 进站 / 锁屏 / 回跳状态机与 cookie 表 |
| SGX-SPEC-002 | [`specs/status-apis.md`](specs/status-apis.md) | 规范 | 只读状态接口分工 |
| SGX-SPEC-003 | [`specs/ui-cookie.md`](specs/ui-cookie.md) | 规范 | 外观 cookie `sgx-ui` 契约（含博客读端） |
| SGX-SPEC-004 | [`specs/v6-route-inventory.md`](specs/v6-route-inventory.md) | 草案 | v6 路由全量盘点：每条路由的档（public / user / 组 / root） |
| SGX-SPEC-005 | [`specs/v6-identity-migration.md`](specs/v6-identity-migration.md) | 草案 | v6 数据迁移对照表：凭据 → root / styrigx、pepper 来源、userHandle |
| SGX-SPEC-006 | [`specs/v6-stepup-app-map.md`](specs/v6-stepup-app-map.md) | 草案 | v6 STEPUP / APP 调用点与去向 |
| SGX-DES-001 | [`design/palette.md`](design/palette.md) | 规范 | 调色板与色彩角色 token |
| SGX-DES-002 | [`design/ui-system.md`](design/ui-system.md) | 规范 | 终端风格 UI 系统：顶栏、AI 窗、Auto 控件、提示符规则 |
| SGX-SEC-001 | [`security/account-v3.md`](security/account-v3.md) | 规范 | 进站 / 账号安全模型 V3 |
| SGX-OPS-001 | [`operations/deploy.md`](operations/deploy.md) | 规范 | CI 与部署 |
| SGX-OPS-002 | [`operations/resources.md`](operations/resources.md) | 参考 | Cloudflare 资源清单（只有名字） |
| SGX-OPS-003 | [`operations/v5-smoke.md`](operations/v5-smoke.md) | 清单 | v5（S1–S7 + sub v3.1）真机冒烟清单 |
| SGX-CON-001 | [`contributing/pr-and-commits.md`](contributing/pr-and-commits.md) | 规范 | 分支、提交、PR、合并 |
| SGX-CON-002 | [`contributing/blog-writing.md`](contributing/blog-writing.md) | 规范 | 写博客 |
| ADR-0001 | [`decisions/ADR-0001-one-repo-one-site.md`](decisions/ADR-0001-one-repo-one-site.md) | 决策 | 子站并入一个仓库、一个 Hugo 站 |
| ADR-0002 | [`decisions/ADR-0002-lock-screen.md`](decisions/ADR-0002-lock-screen.md) | 决策 | 锁屏方案演进：Turnstile → 临时钥匙 → 命令行进站 |
| ADR-0003 | [`decisions/ADR-0003-account-v3.md`](decisions/ADR-0003-account-v3.md) | 决策 | 账号与进站 V3：门归网站、账号管授权 |
| ADR-0004 | [`decisions/ADR-0004-ai-models.md`](decisions/ADR-0004-ai-models.md) | 决策 | AI 模型选择：Gemma 4 默认，Gemini 3.5 Flash Lite / 3.8 Flash |
| ADR-0005 | [`decisions/ADR-0005-terminal-entry-v5.md`](decisions/ADR-0005-terminal-entry-v5.md) | 决策 | v5 终端与进站：一个终端、唯一入口 `sudo styrigx`、三处上锁、提示符按 by |
| ADR-0006 | [`decisions/ADR-0006-identity-v6.md`](decisions/ADR-0006-identity-v6.md) | 决策 | v6 身份统一：account worker 唯一签发者、root / 普通用户、权限 = 组、服务端身份栈 |
| — | [`assets/screenshots/`](assets/screenshots/) | 资源 | 根 README 用的截图 |

## 4. 其他文档的位置

4.1 每个 Worker 的职责、路由、绑定、数据与迁移写在 `workers/<名字>/README.md`；Worker 骨架契约在 [`workers/README.md`](../workers/README.md)。本目录不重复这些内容。

4.2 共享 CI action 的说明在 [`.github/actions/README.md`](../.github/actions/README.md)；Renovate 配置在 `.github/renovate.json` 与 `.github/renovate-preset.json`。

## 5. 新增 / 修改文档

5.1 新文档 MUST 放进第 3 节的某个目录，并在本索引登记。

5.2 架构性决定（换存储、换 Worker 边界、换鉴权模型、换外部依赖）SHOULD 写一份 ADR（`decisions/ADR-NNNN-<slug>.md`，编号顺延，不复用）。

5.3 图片 MUST 放在 `assets/`，文件名小写加连字符。
