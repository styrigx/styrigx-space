# 分支、提交与 PR

| 项 | 值 |
|---|---|
| 文档编号 | SGX-CON-001 |
| 版本 | 1.0 |
| 日期 | 2026-11-09 |
| 状态 | 现行 |

## 1. 角色

| 角色 | 职责 |
|---|---|
| 拥有者（Sloan Gray） | 决定范围、批准合并、创建与轮换 Secret / token、确认破坏性操作 |
| 执行者（人或 AI agent） | 开分支、写代码与文档、跑本地检查、开 PR、盯 CI、按授权合并 |

## 2. 分支

2.1 `main` 受保护：只能经 PR 合入；必需检查 `quality`、`passkey-e2e`；要求分支与 `main` 同步；禁止 force push 与删除。

2.2 每个分支 MUST 从最新的 `origin/main` 开出，命名 `<type>/<short-slug>`，`type` ∈ `feat`、`fix`、`chore`、`ci`、`test`、`refactor`、`docs`、`revert`。

2.3 分支落后于 `main` 时 MUST 把 `origin/main` merge 进分支；MUST NOT rebase 已推送的分支，MUST NOT force push。

## 3. 提交

3.1 提交信息用中文，格式 `type(scope): 说明`。

3.2 作者为仓库拥有者的 noreply 身份；由 agent 完成的提交 SHOULD 带 trailer `Co-authored-by: Hark <hark@styrigx.com>`。

3.3 MUST NOT 提交：生成的站点产物（`space/web/public/`、`.hugo_build.lock`）、`node_modules/`、大型二进制、任何 Secret 或 token 值。

## 4. PR

4.1 标题与合并后的提交标题一致：`type(scope): 中文说明`，或任务书风格（如 `P4-3 PR-4a：…`）。

4.2 PR 以 ready for review 打开（非 draft），不加 label / assignee。

4.3 正文（中文）包含：

```
## 改动        各文件 / 区域改了什么（路径用反引号）
## 根因        （修复类）
## 本地验证    按 CI 分组列结果与数量；没跑的写明「以 CI 为准」
## 未决        （可选）
## 部署后手动（Gray）（可选）
## 验收        合并后要看什么
## 合并        merge commit
```

4.4 正文写明基线 `基线：main <sha>`；有任务书时引用章节并逐条写出偏离。

4.5 推送前 SHOULD 本地跑：单测、`npm run test:sites`、全部 `gen-* --check`、`check-layers.mjs`、`check-frontend.mjs`、stylelint（命令见 SGX-OPS-001 §9）。

## 5. 合并

5.1 合并方式 MUST 是 merge commit，MUST NOT 用 squash 或 rebase；以 PR 当前 head sha 作为前置条件（防止合入未验证的提交）。原因：main 保留完整历史、提交 SHA 不变（各处引用 SHA），安全代码可审计。仓库设置只开 merge commit（Settings → General → Pull Requests）。2026-11-12 前 squash 合入的提交保持原样，不改写。

5.2 合并 MUST 有拥有者的授权（逐个 PR 下令，或对一组 PR 的明确预授权）且 CI 全绿。

5.3 视觉基线重拍需要拥有者确认范围；PR 中任何视觉用例出现差异时 SHOULD 停下报告差异清单，不擅自重拍。

5.4 合并后 MUST 观察 `main` 的 Deploy 运行至全绿，并确认 `https://styrigx.com/`、`https://styrigx.com/zh/` 返回 200。

5.5 同一问题连续修两轮仍失败 SHOULD 停下报告，不继续循环。

## 6. 红线

以下改动 MUST 单独立项、经拥有者批准，不得夹带在其他 PR 里：

- WebAuthn 参数（`rpId`、origin、user handle）与 cookie 属性；
- 任何 Secret / token 的创建、读取、轮换（值只由拥有者处理）；
- 删除 D1 / KV / R2 资源或生产数据；
- Cloudflare 账单 / 付款相关操作；
- 外观（布局、配色、字体、窗口形态）的改动（SGX-DES-002 §2.3）。
