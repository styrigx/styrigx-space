---
url: /blog/zh/post/2026-11-12-command-handbook/
title: "小白命令手册：站内终端怎么用"
description: "站内终端每条命令能干什么、谁能用、要不要再验证。照着 v6 P4 的现状写，命令一变就跟着更新。"
date: 2026-11-12
series: ["styrigx 鉴权体系规范的变迁"]
seriesOrder: 11
tags: ["Styrigx UI", "鉴权", "终端"]
---

> 本文是「styrigx 鉴权体系规范的变迁」系列的一篇，是[《身份统一 v6》](/blog/zh/post/2026-11-12-identity-v6/)的配套手册。它是活文档：命令一改，这里就跟着改。现在写的是 v6 P4 的样子，设备标记等 2g 的内容上线后再补。

## 零、先会三件事

- **打开终端**：按 `Ctrl K`（Mac 上是 `⌘ K`），或点顶栏的 `>_`。
- **看提示符就知道自己是谁**：`nobody@space:~$` 是访客，`styrigx@space:~$` 是普通用户（这里以 styrigx 为例），`root@space:~#` 是 root（结尾换成了 `#`）。
- **不会就问 man**：`man` 列出所有命令，`man <命令>` 看这一条的完整说明。

## 一、谁都能用

| 命令 | 干什么 |
|---|---|
| `man`、`man <命令>` | 查看手册页 |
| `ls [路径]`、`cd <目录>`、`pwd` | 列目录、换目录、看当前目录。`cd` 只换目录，要真的过去用 `open` |
| `open [路径]` | 打开站点、`daymark/today` 或账号卡片（`open ~/account`） |
| `cat daymark/today` | 显示今天的 daymark 一句 |
| `find <关键词>` | 搜四个站的公开页面 |
| `theme`、`theme <调色板>` | 打开调色板，或直接切到某一套 |
| `history`、`clear`（`cls`） | 本会话敲过的命令、清屏 |
| `whoami` | 显示当前身份。`su root` 之后会带路径，比如 `root via styrigx` |
| `exit` | 退一层：root → 用户 → 访客。没登录时就是关掉终端 |
| `lock` | 全部退出，直接回到访客，不用验证 |

## 二、登录与切换：su

- `su <用户>`：用这个用户的密码或通行密钥登录。新用户第一次登录，要先设一个新密码。
- `su root`：只有 **wheel** 组能用，要输 root 的凭据。root 最多维持 1 小时，前台空闲 15 分钟就自动退回。
- root 不能从访客直接登录，要先 `su <用户>`，再 `su root`。
- 已经是某个用户时，要先 `exit` 才能 `su` 到另一个用户。

身份是一层一层叠上去的：`exit` 每次退一层，`lock` 一次全退。

## 三、登录后管自己

| 命令 | 干什么 | 要求 |
|---|---|---|
| `passwd` | 改密码 | 先输当前密码。改完后当前会话保留，其他会话全部作废 |
| `passkey`、`passkey add`、`passkey rm <n>` | 列出、添加、删除通行密钥 | 已登录 |
| `device`、`device rm <n>`、`device rm --all` | 列出登录的设备，或退出其中一台、全部 | 已登录 |
| `profile`、`profile set name｜nick｜sign｜email <值>`、`profile avatar` | 看、改个人资料和头像 | 已登录 |
| `groups` | 看自己在哪些组 | 已登录 |
| `who` | 看自己的会话：身份路径和开始时间 | 已登录 |
| `ask <问题>` | 问 Gray AI | 只对 ai 组开放 |

**重点：`passwd` 和 `passkey` 只管栈顶那个身份。** 要改 root 的密码或通行密钥，栈顶必须是 root，也就是先 `su root` 再改。没切过去时，改的是你自己这个用户的。

## 四、管理用户（root，或 sudoers 用 sudo）

| 命令 | 干什么 |
|---|---|
| `useradd <名> [-e YYYY-MM-DD] [-G 组,组]` | 新建用户，印出一次性密码（只显示一次，24 小时内有效，第一次登录必须改）。`-e` 是到那天 00:00（北京时间）起失效 |
| `userdel <名>` | 删用户，连同会话、钥匙和组。root 和 styrigx 删不了 |
| `usermod -aG <组> <名>`、`usermod -rG <组> <名>` | 加进组、移出组。该用户的会话会作废，要重新登录 |
| `passwd <名>` | 给别人重发一次性密码，对方的会话全部作废。不能对 root 用 |
| `groups <名>`、`who` | 看别人的组、看全站的会话 |

有期限的用户进不了 wheel、sudoers 和写组。移除 wheel 或 sudoers 的最后一个成员时，会先问你一次。

**sudo 是什么**：sudoers 组的人不用切成 root，前面加 `sudo` 就能借 root 执行**一条**命令，比如 `sudo useradd alice`。每次都要输自己的凭据，不留票据，也不压栈。sudo 只能做上表这几条，**碰不了 root 的凭据**：`sudo passwd root` 和 `sudo passkey` 一律拒绝。

## 五、代理订阅：sub（只有 root）

`sub` 看总览，`sub show [名]` 印出地址，`sub add` / `upload` / `mv` / `rm` / `enable` / `disable` 管来源，`sub key` 换公钥，`sub token reset` 换令牌。细节太多，直接 `man sub`。

## 六、救援：rescue

忘了 root 的密码、通行密钥也都丢了的时候用：

1. 在终端输 `rescue`，再输恢复钥匙。
2. 进入 15 分钟的 root 救援会话。这时**只能用**：`passwd`、`passkey`、`whoami`、`groups`、`exit`、`lock`。改密码不用先输旧密码。
3. 赶紧用 `passwd` / `passkey` 把 root 的凭据补回来。`exit` 直接回到访客。

**用过的恢复钥匙不能再用。** 救援一结束，就要换一把新的。

## 七、换钥匙走 dashboard，不走终端

恢复钥匙和各种 secret 都不在终端里改，终端里也没有这样的命令。要换，就由 Gray 在 Cloudflare dashboard 的 Secrets Store 里直接改值，不用改代码，也不用重新部署，最多 60 秒生效（恢复钥匙是即时生效）。

旧版那些「恢复密钥」相关的命令（`sudo root reset` 之类）都已删除。现在唯一的入口就是 `rescue`。

## 八、v5 的老命令去哪了

| 旧写法 | 现在 |
|---|---|
| `sudo styrigx`、`sudo root` | `su <用户>`、`su root` |
| `sudo -v`、`sudo root reauth` | 没了。sudo 每次都重新验证 |
| `sudo root reset` | `rescue` |
| `lock passwd`、`lock passkey`、`lock --all` | 没了。改密码、通行密钥用 `passwd` / `passkey`，全部退出用 `lock` |
| `share` | 没了，分享短链已下线 |
