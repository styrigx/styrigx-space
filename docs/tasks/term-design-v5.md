# 终端设计 v5（Gray 16:04：除 AI 外全合并到一处）
窗口：终端（原 tty1 锁屏 + tty2 主页 + tty3 盾牌 + tty5 账号）一个会话一份历史；tty4 AI 不动。
入口：顶栏终端按钮（所有人可见），打开全屏终端；主页首屏终端接同一会话；上锁页「解锁」= 跳终端敲 sudo styrigx。
提示符：nobody@space:~$ 访客 / styrigx@space:~# 已解锁（Gray 16:08 改 #，与账号对齐） / root@account:~# 账号。
通用：man [cmd]、open <页>、cd、ls、cat、clear、history、exit。
钥匙（命令字不变）：sudo styrigx 解锁；lock 重新上锁；sudo -v reauth；reset 层不变。
解锁凭据：lock passwd、lock passkey [add|rm <n>]（与账号 passwd/passkey 区分）。
分享：share、share add、share rm <n>、share rm --all（已解锁才能发；有效期档保留）。
账号：sudo root 登录；passwd、passkey [add|rm <n>]、device [rm <n>]、app [rm <n>]、sub …（v3.1）；exit 登出回上一层。
去掉：help、tempkey、share extend、链接会话、盾牌/账号分层提示符、cd 跳面板。
解锁流程（Gray 16:05）：上锁页点「解锁」→ 终端 sudo styrigx → 通过后终端自动收起 → 播原进站解锁动画 → 回到刚才的页面。动画保留不改。
搜索（Gray 16:13 定）：从 AI 拆出不走模型的关键词搜索，所有人可用。主站/博客 Hugo 构建静态索引；奇趣/日刻读现有 KV 索引 site:curio/site:daymark，加限速。终端命令 find <词>。AI 继续上锁。访客单独 AI 配额方案被否。
补（Gray 16:13）：解锁后搜索全走 AI；关键词搜索 find 只给未解锁访客（nobody）。
AI 锁（Gray 16:16）：AI 窗口模型小矩形保留，内容换锁图标；点击跳终端 sudo styrigx，解锁后收起→动画→回 AI。顶栏方案 A/B/C 截图已发（建议 B），待选。截图在 /workspace/work/tbshots。

## 16:25 更新
- AI 窗口锁（模型小矩形里换锁标）：Gray 16:25「ai窗口改的可以」，已批。
- 顶栏 D（待 Gray 确认截图 D-compare.png）：调色 · 导航四格 · 盾牌 | 终端 · 头像。导航面板去掉 share/lock 行，两个按钮挪进盾牌面板。
- ask：建议 nobody 下 man 只列 find，敲 ask 提示先 sudo styrigx；解锁后 ask <问题> 打开 AI 代发，find 不列。待 Gray 确认。
- 16:28 Gray「可以」→ ask 方案定：nobody 下 man 只列 find，ask 提示先 sudo styrigx；解锁后 ask 开 AI 代发，find 不列。

## 16:32 顶栏定稿 E（Gray 16:31–16:32）
- 顶栏：盾牌 · 调色 · 导航四格 | 终端 · 头像（截图 E-compare.png）。
- 盾牌不开任何窗口，当状态标志/吉祥物：已解锁时按一下＝退出进站会话（等同 lock）。nobody 态行为待定（建议：按一下跳终端 sudo styrigx）。
- 导航面板：保留 share，去掉 lock 按钮。

## 16:36 Gray
- 盾牌：访客点→跳终端 sudo styrigx；已解锁点→跳终端给确认（退出进站会话 y/N），一来一回对应。
- 主页命令行窗口（终端并入顶栏后会空）：Gray 提议放 about（现在旷野页的 neofetch），或数字健康屏幕时间。我建议 neofetch，待截图。
- 16:40 主页 neofetch 截图已发（home-nf.png）：about 卡原样替换主页内嵌终端；正式版提示符改成当前态（nobody@space:~$ 等）、路径 ~；顶栏按 E。旷野页 about 是否保留待定。
- 16:42 Gray「OK 就这样 可以定稿」：主页 neofetch 定稿（间距同原终端，提示符跟身份）。旷野页 about 去留未答。
- 16:45 PC 两版 mock 已发（/blog/ 页拍），推荐居中，待选。
- 16:48 Gray 定：桌面终端用居中大窗（1040×72vh，与顶栏留空）；嫌桌面下拉丑，Quake 否决。手机端仍为整块卡片。
- 16:48 Gray「删 只保留主页」：旷野页 about（neofetch）卡删除，只在主页保留。外观已全部定稿，待整理 v5 分期计划。
- 16:49 Gray「没进站头像当吉祥物」：访客态头像只作装饰（不开账号窗），解锁后点头像才开账号（我的理解，已在计划中注明待确认）。
- 16:55 Gray：删临时钥匙，分享链接会话改绑 share_link（by=link）。已改入 v5-plan S1。
- 17:00 Gray：链接会话提示符 nobody@space:~#（同访客名，$→#）。
- 17:01 Gray「OK 就按这个做法」：分享链接带解锁会话（by=link，可撤销，不能发分享/改凭据/reauth）定稿。计划待 Muse 审后开工。
- 17:05 Muse 审阅（/workspace/uploads/Styrigx Space v5 分期计划审阅意见.md，审的是旧 worktree）。#1 加 D1 绑定作废（share_link 与 tempkey 已同在 D1_SPACE）。采纳：validCombo 去 BY_TEMPKEY + 独立 isLinkId；删表删列单独收尾提交；清理挂 status :41（每天 3 点）一条 DELETE；S3 先列接口清单、/api/account 不进白名单；终端态以服务端为准。
- 待 Gray 拍板（已发 12 条卡片）：头像行为；find 改读 KV 四站不做 Hugo 静态索引；听歌页链接会话听不了（需账号+curio.write）；RSS/files-index 放开；账号页放开；15 天档；sub 等 S5；Ctrl K 保留；红字改灰进 S6；合并授权。
- 17:16 Gray 回 12 条：1 提示符 nobody@space:~#；2 头像访客态死按钮纯吉祥物；3 find 读 KV 四站不做 Hugo 索引（限流我评估）；4 听歌保持账号才可用不改；5 放开 RSS/files-index 接受（已加 Google SEO）；6 待澄清；7 15 天档保留；8 清理挂 :41 每天一次；9 顺序我定；10 Ctrl K 保留；11 未答；12 v5 PR 绿了我评估后直接合。直接采纳项不用再给 Muse 审。确认后开工。
- 17:20 全部定稿：6 无账号页网址（账号=头像弹窗，头像仅钥匙解锁后可点）；11 红字不改。开工 S1。
- 17:23 Gray 定（覆盖 17:19 Hark 提议）：头像必须已进站才可点（开账号窗）；未进站（访客）头像是死按钮，不跳终端、不开窗。S6 按此实现。
- 17:24 Gray 确认：所有正式进站同一逻辑、唯一入口 sudo styrigx（访客与链接会话皆然）。
- 18:37 Gray 定：S3 盖锁的三处 = 听歌页、AI 窗口（已定锁图标）、旷野页 status 卡（监控）。其余全部放开：屏幕时间、about、blog/curio/daymark 页面与数据、RSS、files-index。
- 18:42 Gray 定音乐三层：访客可看歌单/封面不能播；进站（含链接会话）可听；上传与管理=账号+curio.write（与其他子站写接口一致）。覆盖「听歌仅账号」。
- 18:42 访客点播放直接弹终端 sudo styrigx（Gray）。
- 19:21 顺序：S1 S2 S3 S4 S5 → sub v3.1 → S6 S7 S8 → tempkey 收尾（删表/列/TEMPKEY_PEPPER 绑定）。
- 19:22 Gray「你安排就行，又快又稳」→ Hark 定 8 个 PR：S1✓ S2✓ S3 S4 S5 → sub v3.1 → S6+S7 合一（截图一起批）→ S8（含 tempkey 删表删列删绑定，D1 DROP COLUMN 先 preview 实测）。
