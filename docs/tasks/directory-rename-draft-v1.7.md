# 目录改名定稿 v1.7

## §0 背景

- 2026-11-13 13:55，Gray 问为什么有那么多同名 shell 文件夹（assets/shell/js/shell/）。当时是 Step 1（#445）把 assets/js/（里面本来就有 shell/ 子目录）整体挪进 assets/shell/js/，造成的嵌套。
- Step 2（#446）拆 lib 与 shell 平铺文件后，只剩一层 shell。但 Gray 仍觉得 shell 这个名字别扭，要改。
- Gray 定：迁移步骤只挪位置、不改名；全部步骤做完后，单开一次统一改名（2026-11-13 14:00）。
- 2026-11-13 15:38，Gray 改时机：改名在第 8 步（文档）之前做，第 7 步合了就可以做。
- 2026-11-13 15:41，Gray 再改：改名提前到第 7 步之前做。Hark 额度每日 91% 已用、16:06 重置；第 7 步分支 refactor/space-player 刚切出、还没动代码，改名合完后重切分支即可。
- 2026-11-13 15:52，Gray 定：改名定稿后，任务并进 v1.11，放到 6 之后 7 之前（到时新开 v1.12 文件，v1.11 原版留着）。
- 本稿 v1.7 是定稿：Gray 2026-11-13 16:36 定，批了文件名对照表（142 个文件：改 24、删 3、不变 115），另定 shell.css → frame.css 里面的标识符（@shell 标记、类名）本次不动，标识符任务（§9）时改。v1.0、v1.1 讨论稿、v1.2、v1.3、v1.4、v1.5、v1.6 定稿留着。

## §1 改名范围与原则（当前结构，main e75ee266）

| 位置 | 现状 | 说明 |
|---|---|---|
| assets/ | blog、curio、daymark、jsconfig.json、shell | shell 是 Platform 的代码 |
| assets/shell/js/ | account、ai、apps、auth、core、features、i18n、identity、nav、prefs、status、term、topbar、ui + tsconfig.json | 14 个分组 + 1 个配置文件 |
| layouts/partials/ | blog、curio、daymark、shell | shell 是 Platform 的 partials |
| data/ | curio、daymark、shell | shell 是 Platform 的数据（blog 无 data 目录） |
| scripts/ | blog、build、check、curio、daymark、deploy、gen、lib | build/check/deploy/gen 是 #450 新分的 4 组；blog/curio/daymark 是各产品脚本；lib 是共享库 |

改名原则（沿用 v1.11）：只改名字、不改逻辑、不改外观、不改路由。改完 CI 全绿、public/ 对照一致才算完。

**只改路径，不改标识符（Hark 建议，Gray 定）：** 本次改名只改文件/目录路径。带 shell 的 localStorage 键、cookie 名、CSS 类名、事件名、对外网址一律不动。路径是文件在仓库里的位置，改了只影响引用；标识符是代码运行时用来认东西的名字，改了会丢用户偏好、掉会话、变外观，超出“只改名字”。标识符改名是后续单独任务，见 §9。

## §2 shell → common（已定）

Gray 定：shell 改 common。三处一起改：

- assets/shell/ → assets/common/
- layouts/partials/shell/ → layouts/partials/common/
- data/shell/ → data/common/

理由（Hark 提名，Gray 定）：common 一眼看出是各产品共用的公共部分，和 blog/curio/daymark 并列不歧义；不撞 Space、Platform，也和 term（终端）无关。

已否掉的提议：

- **platform**（Muse 提议，Gray 否）：Space 本身就是 Platform 层，space/ 目录就是 Platform，再把里面的 shell/ 改成 platform，等于“Platform 的 platform”，重复、定位冲突。
- **site**（Muse 提议，Gray 否）：Gray 说不行。
- **base**（Hark 备选，未采用）：更短，但和 Hugo 的 baseof 容易联想到一起。
- 不提 core（和 js/core 撞）、kit、chrome（易联想浏览器）。

好消息（Hark 核过）：构建后 Platform JS 对外路径是 /js/，CSS 输出是 /css/main.*.css，JS 是内联，都不含 shell，改名大概率不动对外网址，以 public/ 对照为准。

## §3 common 与 frame 分组（已定）

标准（Hark 提议，Gray 定）：**shell 功能 = 套在每个页面外面、自己会画界面的外壳；common = 不自己画外壳的库和数据**，谁都能用。不按“产品有没有 import”分（产品页都套着外壳，topbar、term、ai 也被产品侧引用，光看引用分不开）。

分组（已定，引用图确认后）：

- frame（外壳功能）：topbar、nav、term、ai、apps、status、account（含并入的 identity）
- common（库和数据）：core、ui、prefs、i18n、auth、features

引用图（Hark 核过，Gray 定）：基于 #451 提交 1 的 assets/common/js/，去注释解析 import，共 10 处反向依赖：account → term 5 处、identity → term 4 处、auth → status 1 处。处理（都不开例外）：**A）account（含 identity）整组归 frame**，一口气清掉 9 处；**B）diag-jumptrace.js 挪进 core/**，清掉最后 1 处。结果 0 个例外。

落点：

- assets/common/js/<库>/（common 分组直接放 js/ 下）
- assets/common/js/frame/<外壳分组>/（frame 分组放 frame/ 子目录下）
- partials 和 data 的归属跟文件名对照表合并成一张表（见 §4），每行同时写“归属 + 新名”，Gray 一次勾完，不再单说“同理”。
- 只有一层 frame，不会再出现 shell/js/shell 那种嵌套。
- 子目录名用 **frame**，不用 shell（Gray 嫌 shell 这个词别扭，改完 common 里再冒出一个 shell 子目录等于没改干净）。

层规则（Gray 定）：**common 的库不许反过来依赖 frame**，编为 check-layers 规则 28，进 check-layers 强制执行。common 是底座，frame 是建在底座上的外壳，底座反过来依赖外壳就乱了。**规则 28 允许开例外**（Gray 定，Hark 倾向允许）：§5 例外表目前只对 23–26，规则 28 也纳入例外范围。

引用图不一定干净（Hark 提醒，Gray 定）：此前粗查即发现库与外壳互有引用。如果 ui、prefs、i18n 等 common 库里有 import frame 的，新层规则会直接红。处理：Hark 先报清单，由 Gray 逐条定“整组改归 frame”或“记例外”，不为过规则改代码逻辑。**已决（Gray 2026-11-13）：清单共 10 处，按 A、B 处理，0 个例外（见上）。**

## §4 文件名审查（已定）

**光改名目录不够，还要审查文件的名字。** 很多名字是以前搭建期起的，那时候是一步做一步、不像现在先出方案设计稿再做，修修补补就变成了现在这样。

- 范围：第一轮只审 common 三处（assets、partials、data），144 个文件（e75ee266，Hark 实数）；产品目录和 scripts 不在这次。
- 已看到的问题：partials 前缀混用 sgx-、shell-、space-、status- 和无前缀（icon、posts-sorted）；data 里 nav.json 和 shell-nav.json 同时存在，要核是不是重复；调色板三个文件 palettes.json、palette-roles.json、palette-source.yaml 命名没有规律。
- 规则：目录已说明归属，文件名去掉 sgx-、shell- 这类冗余前缀；同一类的文件用同一个开头。
- 交付：一张旧名 → 新名对照表，**每行同时写“归属 + 新名”**（归属指 common 还是 frame，见 §3），每行写原因，Gray 逐行勾。外部引用（如 Hugo 的 partial 名、workers 里的字符串）一并列出。
- **删兼容垫片（Gray 定，做干净、不留兼容）：** term/suggest.js（纯转出 term/core/suggest.js，注释写着“原有 import 路径不变”）和 prefs/ui-cookie.js（基本是转出，只保留原来的导入路径）删掉，引用方直接改指真文件，不动逻辑。放提交 3 一起列入对照表。
- **diag-jumptrace.js 改名：** 挪进 core/ 的同时改叫 navigate.js（文件头自己说是“页面跳转的统一入口”，名字是已删的诊断模块留下的），放对照表里定。
- **shell.css → frame.css 里面的标识符（Gray 定）：** 文件里的 @shell 标记、类名是标识符，本次改名不动，标识符任务（§9，单独 PR，第 7 步之后）时改。

## §5 其他（已定）

1. **apps / features：不合，features 不动。** features 是功能开关（features.js + feat-flags.d.ts），和 apps 不重。data 里 features.yaml 和模板读取都叫 features，只改 JS 目录会不一致，全改牵连太大。
2. **auth / identity / account：identity 并进 account，account 整组归 frame。** identity 只有 api.js、layer.js 两个文件，并进 account；account（含 identity）按引用图归 frame（window.js 画账号窗口，cmd/layer.js 和 identity/layer.js 是终端里的命令层），留 auth（进门守卫）在 common。先核引用再定（引用图已核，见 §3）。
3. **core：不动。** 里面就是基础工具，改名收益小、牵连大。
4. **scripts/lib/：留着。** build-css、check-worker-routes 和多个 tests 都在用，是真正共享的。
5. **tsconfig.json：不要挪。** 它的 include `**/*.js` 是相对它自己的目录（assets/shell/js/），挪到 assets/ 根会把 checkJs 扩到各产品 JS，等于改了行为。核过：include 里的 `features/feat-flags.d.ts` 在 features 留在 common/js/ 下时仍有效，`**/*.js` 会自动覆盖 frame/。

## §6 顺带改名（已定）

以下跟 shell 改名一起改，别留旧名：

- 脚本名：gen-shell.mjs → gen-common.mjs（以及其他带 shell 的脚本名，统计后定）。
- check-layers 规则里的路径。
- README 规范（space/README.md）里写到的旧路径。
- tests 里引用旧路径的。
- D2 里写的 /shell/js/（对外实际是 /js/，第 7 步时按改名后的结构重新写清即可）。
- **模板里的 `site.Data.shell` → `site.Data.common`**（data/shell 改名引起，点名在内）。
- **partial 按字符串名引用（"shell/xxx.html"）**，同样改成 common，点名在内。

## §7 时机与顺序

- 改名在第 7 步（播放器页）之前做，第 7 步等改名合完、Hark 重切分支后再做。
- 时机：等 16:06 额度重置后再动手（Hark 提议，Gray 同意）。改名要全仓 grep、跑全套测试和对照，余量未必够一口气做完。
- 改名一个 PR，拆三个提交：目录改名 → 分组 → 文件名，方便逐个核。
- **第三个提交有前置条件（Hark 建议，Gray 定）：** 文件名要 Gray 逐行勾，所以 PR 没法一口气做完。实际顺序：提交 1（目录改名）→ 提交 2（分组）→ 交对照表 → Gray 勾完 → 提交 3 → 全套测试、public/ 对照 → 转正式。中间 PR 保持 draft。
- 合并沿用规矩：Hark 开 PR、跑 CI、做 public/ 对照，Gray 或 Gray 指定的人合，Hark 不自合。
- 改名合完后，第 7 步、第 8 步（文档）再继续。第 8 步写文档时就是最终改完的名字，不用返工。
- v1.11 规范（space/README.md）和 check-layers 规则里写到的旧路径，要跟着改名一起改，别留旧名。

## §8 并进 v1.12

- 定稿后 Hark 写 v1.12 草稿：在 6 和 7 之间插入“改名”这一步，并把全文旧路径、§5 例外表里的路径一起换成 common，v1.11 原版不动。

## §9 代码标识符改名（后续单独任务，Gray 定）

Gray 2026-11-13 定：标识符这个建议改，但不是现在。顺序：

1. 命名任务完成（本稿的改名，§1–§8）。
2. 做完播放器的迁移（第 7 步）。
3. 然后改代码标识符：带 shell 的 localStorage 键、cookie 名、CSS 类名、事件名、对外网址。
4. 标识符改名在第 7 步之后、第 8 步（文档）之前，是第 7 步和第 8 步之间的一个单独步骤，不是第 8 步的一部分。
5. **另开 PR**：标识符改名单独开一个 PR，不跟改名 PR 混在一起。

注意：标识符改名会丢用户偏好、掉会话、变外观（见 §1），做之前要先评估影响、列出清单，Gray 逐条定。
