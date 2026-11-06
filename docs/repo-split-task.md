# 仓库分包任务书：根目录分 space（主站）/ atlas（子站）两包

> 状态：现行 ｜ 最后更新：2026-11-06

任务书标题即 PR 标题：`chore(repo): 根目录分 space（主站）/ atlas（子站）两包`

基线：#281 合并后的 main（`f67f5ed9`）｜ 修订：2026-11-06（Muse 按 Gray 要求优化）｜ 定方向：Gray，2026-11-05 ｜ 代码实现：Hark ｜ 操作：Muse（开 PR、盯 CI 到绿）

修订说明（2026-11-06）：旧版基线为 P5-1（#269）合并后的 main，此后 P4-2（a/b/c/d）、P3-1（#278）、#279、#280、#281 已全部合并，仓库结构已变。本版把基线更新到 #281 合并后的 main，§4 的文件计数与测试路径、§10 的目标结构按现 main 重核（`tests/web/` → `tests/space/`，chat / search 两 Worker 已退役，Worker 由 10 个变为 8 个）；§1 里“P4-2 基线顺延”一句已作废（P4-2 已做完），删除；§2 与 §10 的排版修好。搬运方向（§0 / §3，Gray 已定）不动。

## §0 一句话

把仓库根目录的 `web/` 容器拆成两个顶层包：`space/` 放主站，`atlas/` 放三个子站；各包自带 `scripts/` + `web/`；框架仍走现在的共享接口，子站继续靠共享抽用。顺带把 `docs/` 整理一遍（入口索引、现行与历史分开），修好仓库页上坏掉的版本徽章，并给三个子站各加一个版本徽章（§4）。只搬路径、整文档、修徽章，不改行为。

## §1 顺序与基线

- 基线：#281 合并后的 main（`f67f5ed9`，2026-11-06）。本批在该基线上开工。
- 分工：代码 Hark，操作 Muse；squash + head-lock，Gray 下令再合；PR 不开 draft；标题照本任务书标题。
- 目标：根目录清楚——`space/`（主站）/ `atlas/`（子站）两个包一目了然，各包自包含 `scripts/` + `web/`。
- docs 整理随本批一起做（§5）：入口索引、现行与历史分开、现行任务书与设计方案进仓库。

## §2 搬运清单（git mv）

| 从 | 到 | 说明 |
|---|---|---|
| `web/atlas` | `space/web` | 主站 |
| `web/blog` | `atlas/web/blog` | 子站 |
| `web/curio` | `atlas/web/curio` | 子站 |
| `web/daymark` | `atlas/web/daymark` | 子站 |
| `scripts/blog`、`scripts/curio`、`scripts/daymark` | `atlas/scripts/` 下对应位置 | 子站自己的脚本（sync-shell、gen-seed-sql 等） |
| `scripts/` 其余（主站相关 + 共用脚本） | `space/scripts/` | 主站脚本 + 基建脚本，见 §3 |

根目录不留 `scripts/`。

## §3 共用脚本放 space/scripts/（Gray 已定 B）

决定：B（Gray 2026-11-05 定）。`space` 就是基建包，`assemble`、`gen-shell`、`build-css`、`build-sites`、`build-search-index`、`check-layers`、`check-frontend`、`check-worker-routes`、`gen-csp`、`gen-palettes`、`gen-ui-cookie-contract`、`health-gate`、`kv-budget`、`deploy-rollback`、`ci-local.sh`、`migrate-*`、`lib/` 这些共用脚本是基建的一部分，进 `space/scripts/`；不存在独立于两包之外的「全仓共用」位置（A 方案：根目录留 `scripts/`，作废）。

- `space/scripts/`：主站自己的脚本 + 共用脚本（基建）。
- `atlas/scripts/`：只放子站自己的脚本（`scripts/blog`、`scripts/curio`、`scripts/daymark` 的 sync-shell 等）。
- 依赖方向：`atlas/` 依赖 `space/`；子站通过 space 的共享接口抽用基建脚本。根目录不留 `scripts/`。

## §4 路径更新清单

- **deploy.yml**：Hugo `-s` 标志（`web/atlas` → `space/web`；`web/blog` → `atlas/web/blog`；`web/curio` → `atlas/web/curio`；`web/daymark` → `atlas/web/daymark`）、构建产物与 artifact 路径、assemble 输入。
- **scripts/**：所有写死 `web/atlas`、`web/blog`、`web/curio`、`web/daymark` 的路径（`assemble.mjs`、`gen-shell.mjs`、`build-sites.mjs`、`build-search-index.mjs`、`check-frontend.mjs`、`check-worker-routes.mjs`、`gen-csp.mjs`、`gen-palettes.mjs`、`gen-ui-cookie-contract.mjs`、`kv-budget.mjs`、`ci-local.sh`、`migrate-*`）；gen-shell 的 `--from` 与三站 sync-shell 的源 / 目标路径。共用脚本搬进 `space/scripts/` 后，deploy.yml、package.json、.gitignore 里调脚本的路径同步改成 `space/scripts/…`（子站的改成 `atlas/scripts/…`）。
- **check-layers.mjs**：前端根由 `web/atlas/assets/js/` 改为 `space/web/assets/js/`；分层规则与 `tests/space/ui/check-layers.test.mjs` 的期望同步改（分层本身不变，只改路径）。
- **tests/**：各 config 的 testDir 与 Hugo `-s` 引用、fixture 里的路径、路径断言。实测（2026-11-06，基线 `f67f5ed9`）：`web/atlas` 在 128 个文件里出现，子站三条 web 路径在 48 个文件里（以搬运时 grep 为准，逐个核对）。
- **docs/**：STRUCTURE.md、architecture.md、auth-state-machine.md、palette-usage.md、status-apis.md、styrigx-3.0-task.md、ui-cookie-contract.md 等提到旧路径的地方；README.md、README.en.md。docs 整体整理见 §5。
- **.gitignore**、**package.json**（scripts 里的路径）。
- **共享外壳**：`web/atlas/shared/shell` → `space/web/shared/shell`；gen-shell / sync-shell 的源与目标路径同步改；三站 `sgx-shell.lock.json` 的 pin 目标只改路径引用（内容 tree 不变）。框架中立化（把 shared/shell 拎到根目录）不在本批范围。
- **atlas 改名换义**：atlas 以前指主站包，现在指子站包；在 STRUCTURE.md 里写明，避免看旧文档时混淆。
- **仓库页版本徽章（修复）**：README.md 与 README.en.md 里的 Styrigx UI、SGX 徽章（shields.io dynamic yaml）现在指向不存在的 `web/data/version.yaml`（PR1 把主站并进 `web/atlas/` 后文件在 `web/atlas/data/version.yaml`，徽章一直没改），页面上显示 resource not found。随搬运把两处 URL 改成 `space/web/data/version.yaml`（`query=$.ui`、`query=$.sgx` 不变），一次修好路径与显示。Hugo、Tailwind、Deploy、License 四个徽章不动（路径没变）。
- **子站版本徽章（新增）**：在 README.md 与 README.en.md 的徽章行里再加三个子站徽章（博客、奇趣、日刻），与 Styrigx UI、SGX 同款式（shields.io dynamic yaml，`query=$.params.version`），直接读搬运后各子站 hugo.yaml 里的 `params.version`：`atlas/web/blog/hugo.yaml`、`atlas/web/curio/hugo.yaml`、`atlas/web/daymark/hugo.yaml`。奇趣已有 0.2.0、日刻已有 1.1.0；博客现在没有版本号，本批在 `atlas/web/blog/hugo.yaml` 的 params 里补 `version: '1.0.0'`（初值，Gray 可改）。

## §5 docs 整理

现状：`docs/` 17 个文件，无 README / INDEX；部分文档已过时（与现状不符）；现行任务书与设计方案不在仓库里。

- **入口索引**：新增 `docs/README.md`，每份文档一句话用途 + 状态（现行 / 历史）。
- **现行与历史分开**：过时的文档标「历史」或移入 `docs/archive/`；现行任务书与设计方案放进 `docs/`。
- **每份文档加状态头**：状态（现行 / 历史）+ 最后更新。
- **路径更新**：docs 里提到旧路径（`web/atlas`、`web/blog` 等）的地方随搬运一起更新（§4）。
- **分工**：判当前 / 作废归 Hark；索引与归档由本批做。只做索引、归档、路径更新与状态头，不改文档内容本身；历史文档不删，只标记 / 归档。

## §6 不变的东西

四个 Hugo 站、四次构建、assemble 拼树、e2e-lock + e2e-sites 两套 e2e（e2e-sites 现为 3 个并行 job，见 #281，套数不变）、visual 基线（URL 不变，不重拍）、Workers（8 个）、网关、账号与锁行为、搜索索引。搬运不改任何线上行为。买的是根目录清楚，不是省测试。

## §7 验收

- [ ] git mv 后全仓 grep：旧路径 `web/atlas`、`web/blog`、`web/curio`、`web/daymark` 在源码 / 配置 / 测试 / 文档中零残留（历史记录、CHANGELOG 等历史文本除外）。
- [ ] 本地按 CI 顺序全跑一遍（unit CI glob、test:sites、build、e2e-lock、e2e-sites、visual、passkey-e2e）全绿。
- [ ] 构建产物对比：搬运前（base main）与搬运后（分支头）各构建一次 `dist/site`，diff 须一致；有差异须逐项说明原因并经 Gray 确认。
- [ ] PR CI 全绿（quality + passkey-e2e）。
- [ ] STRUCTURE.md 已写明 atlas 改名换义。
- [ ] `docs/README.md` 已有，入口索引列清每份文档的用途与状态；过时文档已标「历史」或移入 `docs/archive/`。
- [ ] 现行任务书与设计方案已放进 `docs/`；每份文档有状态 + 最后更新头。
- [ ] 仓库页 Styrigx UI、SGX 徽章正常显示版本号（9.0、3.0.0），不再是 resource not found。
- [ ] 仓库页新增博客、奇趣、日刻三个子站徽章，分别显示 1.0.0、0.2.0、1.1.0。

## §8 回滚

revert 合并提交 + 重新部署；无迁移、无绑定、无 secret 变化；视觉基线随提交回去。

## §9 Gray 手动步骤

无（纯搬运）。

## §10 优化后的仓库架构（目标）

搬运 + docs 整理完成后的仓库结构（只列主要目录与文件；`space/` 是基建包，`atlas/` 依赖它）：

```
styrigx-space/
├─ .github/
│  ├─ actions/                 # setup-hugo / setup-node-deps / setup-playwright
│  ├─ renovate-preset.json
│  └─ workflows/               # deploy.yml / update-snapshots.yml
├─ .gitignore
├─ LICENSE
├─ README.md / README.en.md
├─ STRUCTURE.md
├─ package.json / package-lock.json / renovate.json
├─ docs/                       # §5
│  ├─ README.md                # 新增入口索引
│  ├─ architecture.md / auth-state-machine.md / palette-usage.md
│  ├─ status-apis.md / 2.4.1-three-site-lock-design.md
│  ├─ styrigx-3.0-task.md / ui-cookie-contract.md
│  ├─ blog/ / curio/ / daymark/ / screenshots/
│  └─ archive/                 # 历史文档
├─ space/                      # 主站 + 基建包
│  ├─ scripts/                 # 主站脚本 + 共用脚本（基建）
│  │  ├─ assemble.mjs / build-sites.mjs / build-css.cjs
│  │  ├─ build-search-index.mjs / gen-shell.mjs / gen-csp.mjs
│  │  ├─ gen-palettes.mjs / gen-ui-cookie-contract.mjs
│  │  ├─ check-layers.mjs / check-frontend.mjs
│  │  ├─ check-worker-routes.mjs / health-gate.mjs / kv-budget.mjs
│  │  ├─ deploy-rollback.mjs / deploy-rollback-floor.json
│  │  └─ ci-local.sh / migrate-*.mjs / lib/
│  └─ web/                     # 主站（旧 web/atlas）
│     ├─ hugo.yaml / wrangler.toml
│     ├─ data/                 # data/version.yaml：ui 9.0 / sgx 3.0.0
│     ├─ assets/ / content/ / layouts/ / static/
│     └─ shared/shell/         # 共享外壳单一来源
├─ atlas/                      # 子站包（依赖 space/）
│  ├─ scripts/                 # 只放子站自己的脚本
│  │  ├─ blog/                 # build-css / build-search-index / sync-shell 等
│  │  ├─ curio/                # gen-seed-sql / sync-shell
│  │  └─ daymark/              # gen-seed-sql / sync-shell
│  └─ web/
│     ├─ blog/                 # hugo.yaml + sgx-shell.lock.json
│     ├─ curio/                # hugo.yaml + sgx-shell.lock.json
│     └─ daymark/              # hugo.yaml + sgx-shell.lock.json
├─ tests/                      # 根目录保留（#280 后的结构）
│  ├─ space/                   # 主站：ui/ + e2e/
│  ├─ blog/ / curio/ / daymark/  # 各站：*.test.mjs + config/ + e2e/
│  └─ workers/ / config/ / fixtures/
└─ workers/                    # 8 个 Worker，不动
   ├─ account/ / ai/ / auth-gateway/
   ├─ curio-core/ / daymark-core/
   └─ proxy-rules/ / share/ / status/
```

注：`atlas/web/` 下每个子站（blog / curio / daymark）各有自己的 `assets/`、`content/`、`layouts/`、`static/`；blog 另有 `archetypes/`、`data/`、`i18n/`。`tests/`、`docs/`、`workers/`、`.github/` 留在根目录；`scripts/` 不再单独存在于根目录。
