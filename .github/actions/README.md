# styrigx 共享 CI（composite actions）

主站 styrigx-space 提供给四个仓库（space / curio / daymark / blog）共用的构建环境步骤。主站自己用 `./.github/actions/<名字>`，子站用 `styrigx/styrigx-space/.github/actions/<名字>@<固定 tag 或完整 SHA>`，**从不引用 main**。

| action | 做什么 | 输入 |
|---|---|---|
| `setup-hugo` | 装 Hugo；**Hugo 版本与 extended 只在这个文件里定义**（`HUGO_VERSION`、`HUGO_EXTENDED`），装完核对 `hugo version`；把 `HUGO_VERSION` 写进 `$GITHUB_ENV` | 无 |
| `setup-node-deps` | actions/setup-node（npm 缓存）+ `npm ci` | `node-version` 或 `node-version-file`（二选一）；`install`（默认 `'true'`） |
| `setup-playwright` | Playwright Chromium：浏览器按 lockfile 里 `@playwright/test` 的版本缓存，系统库每次照装；可选 Noto CJK 字体（缓存 apt 候选版本的 .deb） | `cjk-fonts`（默认 `'false'`） |

## 为什么是 composite action，不是 reusable workflow

- 规则集 protect-main 的必需检查按 **job 名** 认：子站是 `build-and-deploy`，主站是 `quality`、`passkey-e2e`。调用 reusable workflow 时检查名会变成「调用方 job / 被调 job」（例如 `build-and-deploy / build`），必需检查永远等不到 `build-and-deploy`，PR 会卡死。composite action 只是 job 里的步骤，job 名、job 数量、`needs`、`if` 都不变。
- 密钥与 environment 留在各仓库自己的 workflow 里：共享 action 不接收任何密钥、不声明 environment，部署 job 也不用共享 action。reusable workflow 里 environment 要写在被调 workflow 的 job 上，密钥要 `secrets:` 显式传或 `secrets: inherit`，会把密钥流向拆到两个仓库，这里不需要。

## 发版（打 tag）

tag 用 `vX.Y.Z`，专指「共享 CI 接口版本」，和站点版本（package.json 3.x）无关。

- patch：只改实现、不改输入输出（换 Hugo / Playwright 安装细节、Hugo 小版本升级）
- minor：加了可选输入或新 action
- major：删改输入、改默认行为（子站要改 workflow 才能升级）

带有 `.github/actions/**` 改动的 PR 合入 main 后：

```sh
git fetch origin main --tags
git tag -a v1.0.1 origin/main -m "shared CI v1.0.1: Hugo 0.169.0"  # 版本号按上面的规则递增
git push origin v1.0.1
```

tag 打上后不移动、不删除（建议在 Settings → Rules → Rulesets 给 `refs/tags/v*` 加「禁止更新 / 删除」）。打错就发下一个版本。

## 子站怎么升级

- Renovate（共享预设的 regex manager，组名「styrigx-space 共享 CI」）在子站各自的排期日（curio 周二、daymark 周三、blog 周四）发现新 tag 就开 PR，把同一仓库里所有 `styrigx/styrigx-space/...@vX.Y.Z` 一起改掉；写成 `@<40 位 SHA> # vX.Y.Z` 也认，SHA 和注释一起改。minor / patch 在 CI 全绿后自动合并，major 要在 Dependency Dashboard 批准。
- 子站 PR 的 CI 会用新 tag 里的 Hugo / Node / Playwright 真跑构建和测试，所以 Hugo 升级在每个子站都先过 CI 再落地。
- 同一条引用不归 github-actions manager（预设 ④a 关掉），blog 的 Dependabot 也 ignore 了它，不会重复开 PR。

## Hugo 升级的完整路径

1. 主站 Renovate（周一）改 `setup-hugo/action.yml` 的 `HUGO_VERSION`，主站 CI 全绿后自动合并。
2. 有人按上面的步骤打一个 patch tag。
3. 子站 Renovate 在各自的排期日开「styrigx-space 共享 CI」PR，CI 全绿后自动合并。
