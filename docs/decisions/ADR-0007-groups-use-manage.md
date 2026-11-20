# ADR-0007：v6 组权限重设计——产品组 use / manage、路由表写 product 推组名

| 项 | 值 |
|---|---|
| 状态 | 已采纳（权限 PR 实施中；部署与重新授组见 SGX-SPEC-005 §8） |
| 日期 | 2026-11-21 |
| 决策者 | Sloan Gray |
| 关联 | 取代 ADR-0006 §2.3 的组名与私密行归属（ADR-0006 其余不动，保留为历史）；《v6 组权限重设计 v1.1》（定稿，2026-11-21）；《music 搬家设计稿 v1.0》第 1 步；SGX-SPEC-004（路由盘点）、SGX-SPEC-005 §8（割接） |

## 1. 背景

1.1 v6 的模型（权限 = 组，路由表唯一来源，`permits()` 唯一判断）不变，问题出在组本身：命名三种风格（`listen` 是动词，`ai`、`status` 是名词，写组是 `<子站>-write`）；分类是隐式的（只有特权组、写组两个常量，其余是「剩下的」）；read / write 容易和 HTTP 方法混（`POST /api/ai` 是用不是写）；音乐要独立成产品，写权限不该继续挂在 `curio-write` 上。

1.2 私密行和「能写」绑在一起：`curio/api/_auth.js`、`daymark/api/_auth.js` 两份一样的 `readAccess` 只问一次 action `private`，结果同时当 `showPrivate` 和 `canWrite`。私密档一旦不等于写组，就会出现「看得到管理按钮、点了才 403」。

## 2. 决定

### 2.1 三类权限

- **不归组的档**：`public`、`user`、`webmaster`（站长 = uid 1000）、`root`，只看路由表。
- **产品组**：每个产品一对 `<产品>-use` / `<产品>-manage`。use = 用这个产品（听歌、AI 窗口、状态卡、看这个产品的私密行）；manage = 管这个产品的内容（上传、新增、编辑、单条删除）。**manage 包含 use**，在 `permits()` 第 3 步一处实现（档是 `X-use` 且身份在 `X-manage` → 放行）。
- **特殊组**：`wheel`、`sudoers`。

批量 / 结构删除（album.del、artist.merge / del、删整个专题、导入导出）仍只属 root；root 不进任何组。

### 2.2 组表（`workers/account/src/core/groups.js`）

```js
SPECIAL_GROUPS = ['wheel', 'sudoers']
USE_GROUPS     = ['music-use', 'curio-use', 'daymark-use', 'status-use', 'ai-use']
MANAGE_GROUPS  = ['music-manage', 'curio-manage', 'daymark-manage']
GROUPS = [...SPECIAL_GROUPS, ...USE_GROUPS, ...MANAGE_GROUPS]
STYRIGX_DEFAULT_GROUPS = GROUPS
```

旧名 → 新名：`listen` → `music-use`，`ai` → `ai-use`，`status` → `status-use`，`curio-write` → `curio-manage`，`daymark-write` → `daymark-manage`；新增 `curio-use`、`daymark-use`、`music-manage`（音乐的写权限从 `curio-write` 拆出；原计划的 `music-write` 从没进过生产，作废）。`PRIVILEGED_GROUPS` 改名 `SPECIAL_GROUPS`、`WRITE_GROUPS` 改名 `MANAGE_GROUPS`。

### 2.3 谁能进哪个组

站长默认全部组。普通用户（uid 1001 起，含临时用户）只能被 root 授 `-use` 组；`canJoinGroup` 拒绝特殊组和 manage 组（**manage 不放权**，Gray 2026-11-20 22:23）。

### 2.4 私密行给 use（方案 A，Gray 2026-11-20 23:33）

公开读接口的 `actions.private` 问 `<产品>-use`。v5.6 第四节「奇趣 / 日刻私密条目只给站长与 root」改为「私密内容给有该产品 use 的人，默认只有站长」。今天只有站长有组，行为不变。AI 的私密召回（`POST /api/ai` 的 `private` = webmaster）是另一条路径，不变。

### 2.5 路由表写 product，组名由它推出

`core/route-access.js` 的行写 `product`（和 `kind`），`R()` 推组名：`kind: 'read'` → 档 public、`private` = `<产品>-use`、`manage` = `<产品>-manage`；`kind: 'use'` → `<产品>-use`；`kind: 'manage'` → `<产品>-manage`。手写的档 / action 仍可覆盖，覆盖处写 `overrideWhy`（表自检兜住；目前只有 `POST /api/ai`）。单测断言推出的组都在 `GROUPS` 里，带 product 的行只用本产品的组。

### 2.6 一个公用入口、一个公用过滤

- `workers/atlas-core/src/common/visibility.js` 的 `visibility(context)`：产品取 context 里命中路由行（atlas-core 自己的路由表行也写 `product`）的 product，分别问 action `private`、`manage` 两档，返回 `{ showPrivate, canManage }`；奇趣、日刻、音乐都用它，两份 `readAccess` 删除。
- 列表用 `filterPrivate()`（约定列 `private` 0/1；没有这一列 = 整表公开；日刻句子的 `visibility` 列用自定的判断，不改列）；附件（照片、图标）用 `privateNotFound()`：看不到 = 404，同不存在。
- 接口回给前端的字段 `canWrite` 改名 **`canManage`**，不留别名；前端只改字段名，界面不动。

### 2.7 音乐（搬家第 1 步）

音乐仍在 `/curio/api/music*`，只换档：GET `music` 的 `private` / `manage` → `music-use` / `music-manage`；POST `music`、`music-upload` → `music-manage`；`music-play`、`music-stream`（GET / HEAD）→ `music-use`；root 的 action 与 sudoTicket 不变。`/music/api/*` 与页面搬家是第 2–4 步。

## 3. 割接与回滚

不写 migration、不跑生产 SQL（受影响的只有站长一人）。部署账号 Worker（Gray 单独批）与 atlas-core 后，旧组名在会话读组时被过滤掉（`identity-session.js` 只认 `GROUPS`）；站长 `sudo usermod -aG music-use,music-manage,curio-use,curio-manage,daymark-use,daymark-manage,status-use,ai-use styrigx` 并重新登录。旧名的库行用 `usermod -rG` 清理（本次让 `-rG` 允许删除不在 `GROUPS` 里的名字，不放开添加）。回滚：revert 并重新部署，旧名的行还在，自动重新生效。详见 SGX-SPEC-005 §8。

## 4. 不做的事

不升 owner / group / other + rwx；不加数字 gid；不改判断顺序和救援白名单；不给普通用户开放 manage 组；不加写组的单条删除接口；不动生产 SQL。

## 5. 以后加一样东西

1. 表里要不要 `private` 列（要就在新表里建）。
2. 路由表加行，写 `product`（和 `kind`）；新产品在 `USE_GROUPS` / `MANAGE_GROUPS` 加一对。
3. 接口里只调 `visibility()` 和公用过滤，不自己比组。
4. 拷一份测试模板（`tests/workers/atlas-core/curio-v6-cutover.test.mjs`、`daymark-v6-cutover.test.mjs` 末尾的「组权限 v1.1 模板」）：访客看不到私密行；只有 use 的看得到私密行、`canManage` 为 false、写接口 403；有 manage 的都行。
