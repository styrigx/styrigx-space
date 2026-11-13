# CI 与部署

| 项 | 值 |
|---|---|
| 文档编号 | SGX-OPS-001 |
| 版本 | 1.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |

## 1. 范围

`.github/workflows/deploy.yml`（Build and Deploy to Cloudflare Pages）与 `update-snapshots.yml` 的结构、门禁与回滚规则。工作流文件本身的注释是逐步细节，本文是规范摘要；两者冲突时以工作流为准。

## 2. 触发与并发

2.1 触发：push 到 `main`、指向 `main` 的 pull request、`workflow_dispatch`。部署作业只在 `main` 的 push / dispatch 上运行。

2.2 同一分支推新提交时取消旧的 PR 运行；`main` 的生产部署 MUST NOT 被取消。

2.3 `GITHUB_TOKEN` 只读（`permissions: contents: read`）。Node 版本 `NODE_VERSION`、wrangler 版本 `WRANGLER_VERSION` 在工作流顶层各定义一次；Hugo 版本只在 `.github/actions/setup-hugo/action.yml` 定义。

## 3. 检查作业

| 作业 | 内容 |
|---|---|
| `unit` | 构建 CSS 后 `node --test`：Worker 单测、主站前端单测 |
| `build` | 旧 secret 名检查；8 个 Worker 的 `wrangler deploy --dry-run` 打包检查；生成物 `--check`（gen-shell、gen-palettes、gen-ui-cookie-contract、gen-csp）；check-layers、check-frontend；生产构建与产物检查；前端技术名词检查；搜索索引（`site:space`、`site:blog`）；子站单测；check-worker-routes；子站生成物同步；stylelint；产物上传给下游作业 |
| `e2e-lock` | `SGX_TEST_SUITE=lock`（锁屏，含基线截图）、`edge`（真实站点核心 + 线上路由规则 + 虚拟认证器）、`credential`（真实 handler + 内存 D1）、lock-gate 关闭的构建 |
| `e2e-sites` | 三个子站的 Playwright（并行） |
| `visual` | 视觉回归，两片并行（`--shard=N/2`）；失败上传 `visual-diff-N` |
| `lighthouse` | Lighthouse CI（`tests/config/lighthouserc.json`） |
| `quality` | 汇总：needs 以上全部 |
| `passkey-e2e` | 通行密钥端到端；PR 上跑本地模拟器，`main` 上跑真实预览；改动只涉及文档 / 样式 / 基线 / 图片时跳过（§6） |

3.1 分支保护的必需检查是 `quality` 与 `passkey-e2e`，且要求分支与 `main` 同步（strict）。

3.2 检查 MUST NOT 用 `continue-on-error` 掩盖失败（`tests/workers/space-core/shared-ci.test.mjs` 核对）。

## 4. 部署顺序（仅 `main`）

```
quality + passkey-e2e
  ├─ deploy-ai-worker ─┬─ deploy-status-worker ─ deploy-account-worker ─ deploy-space-core ─┬─ deploy-curio-core   ─┐
  │                    └─ rollback-ai-worker（后两步失败时）                                 └─ deploy-daymark-core ─┴─ build-and-deploy（Pages）
  └─ deploy-proxy-rules-worker
```

4.1 依赖理由：站点核心的服务绑定（`ACCOUNT`、`STATUS`、`AI_SERVICE`）要求下游 Worker 先在；两个接口 Worker 绑定 `SPACE`，排在站点核心之后；Pages 最后。

4.2 每个 Worker 作业：应用 D1 迁移（如有）→ 核对迁移确已入库 → 记录线上版本 → `wrangler deploy` → 部署后核对（路由、冒烟）→ 失败则回滚到记录的版本。

4.3 `build-and-deploy`：下载 `quality` 构建好的产物 → 断言 Pages 只有静态文件 → 记录线上部署 → `wrangler pages deploy` → 冒烟（`*.pages.dev` 必须跳转、页面必须经站点核心、子站与静态文件按规则放行）→ 失败回滚。

4.4 `deploy-ai-worker` 部署后把主站与博客的搜索索引写进 KV `KV_SEARCH_INDEX`（`site:space`、`site:blog`）；`site:curio`、`site:daymark` 由接口 Worker 自己写。

## 5. 回滚

5.1 部署、冒烟或部署后核对失败 → `space/scripts/deploy/deploy-rollback.mjs` 退回部署前记录的版本（Worker 用 `wrangler rollback`，Pages 用回滚 API），作业照样标红。

5.2 `space/scripts/deploy/deploy-rollback-floor.json` 是回滚下限：MUST NOT 回滚到切库之前的版本。

5.3 不回滚的：D1 迁移（只进不退，新迁移 MUST 兼容旧代码）、KV 数据、Secrets Store、路由 / 自定义域名、其他已部署的作业。

## 6. 跳过 passkey-e2e 的条件

只有当本次改动的文件**全部**属于下列之一时跳过；删除、类型变化、`.github/**`、`package*.json`、前端 JS、站点核心 `src/core/**` 与 `src/lib/**` 一律照跑：

- `*.md`（`space/web/content/*.md` 只改 `title` / `linkTitle` / `description` / `summary` / `keywords` 时）
- `*.css`
- `tests/**/*-snapshots/*.png`
- 图片（png / jpg / jpeg / webp / gif / avif / svg / ico）

## 7. 凭据

7.1 每个部署作业使用自己的 GitHub environment 与同名 secret，权限只覆盖该资源：

| 作业 | environment / secret |
|---|---|
| `deploy-space-core` | `STYRIGX_SPACE_CORE_DEPLOY` |
| `deploy-account-worker` | `STYRIGX_ACCOUNT_DEPLOY` |
| `deploy-ai-worker`、`rollback-ai-worker` | `STYRIGX_AI_DEPLOY` |
| `deploy-status-worker` | `STYRIGX_STATUS_DEPLOY` |
| `deploy-curio-core` | `STYRIGX_CURIO_CORE_DEPLOY` |
| `deploy-daymark-core` | `STYRIGX_DAYMARK_CORE_DEPLOY` |
| `deploy-proxy-rules-worker` | `STYRIGX_PROXY_RULES_DEPLOY` |
| `build-and-deploy`（及 passkey 预览） | `STYRIGX_SPACE_PAGES_DEPLOY` |
| 全部 | `CLOUDFLARE_ACCOUNT_ID` |

7.2 token 的值由拥有者在 Cloudflare 创建 / 轮换并填入 GitHub；自动化流程 MUST NOT 读取或打印 token 值。

## 8. 视觉基线

8.1 基线在 `tests/space/e2e/visual/<spec>-snapshots/`。重拍 = 手动 `workflow_dispatch` `update-snapshots.yml`（输入分支），它会重跑全部视觉用例，MUST 先经拥有者确认范围。

8.2 机器人提交基线后 PR 会被标为未归属改动，需要以作者身份推一个空提交重新触发检查。

## 9. 本地复现

```bash
space/scripts/deploy/ci-local.sh                        # 除 lighthouse 外全部分组
space/scripts/deploy/ci-local.sh unit build e2e-lock    # 指定分组：unit build e2e-lock e2e-sites visual lighthouse passkey
VISUAL_SHARD=1 space/scripts/deploy/ci-local.sh visual  # 只跑 visual 第 1 片
```

本地 passkey 组走模拟器（`tests/space/e2e/helpers/preview-emulator.cjs`），不连 Cloudflare。

## 10. 部署后验收

合并后 MUST 观察 `main` 的 Deploy 运行全绿，并确认 `https://styrigx.com/` 与 `https://styrigx.com/zh/` 返回 200。Lighthouse 偶发的 Hugo 下载 504 可在确认 HEAD 未变后重跑一次。
