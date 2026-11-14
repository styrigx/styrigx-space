/**
 * @fileoverview 终端的 man 页（终端统一 T5；v5 S5 一张表）：man.js 用 import() 懒加载，不进首包。
 * 格式照 man 手册规范 v1（Gray 2026-11-14，man-pages(7)）：页眉 / NAME / SYNOPSIS / DESCRIPTION（auth 并进末行 Requires:）/ OPTIONS / NOTES / EXAMPLES / SEE ALSO，在终端里的全屏阅读页显示（S9，less 式）。
 * 写法：<x> 是参数，阅读页画成下划线、不显示尖括号；[ ] 可选，| 二选一，... 可重复。opt = [[选项, 说明]]（说明译文在 manBody.opt），ex / see 不翻译。
 * 这里的文字是英文底：页面上 NAME 说明以 #sgx-i18n-frame 的 man 节为准（键 = 命令名），DESCRIPTION / AUTH / NOTES 以 manBody 节为准
 * （键 = 命令名，{ desc: [], auth: '', notes: [] }，行数和这里一一对应；中文页每一页都要有，tests/space/ui/shell/man-i18n.test.mjs 查）。命令写法不翻译。
 */
/** 命令 → { d: NAME 说明, syn: SYNOPSIS 各行, desc? / auth? / notes?: 正文，opt?: OPTIONS，ex?: EXAMPLES，see?: SEE ALSO（这个文件不 import，懒加载 chunk 不牵出共享代码）。v6 P4 起旧命令（sudo styrigx / sudo root / sudo -v、lock passwd / passkey / --all、share）的页删了或改成 v6 写法 } */
export const PAGES = Object.freeze({
  man: { d: 'read a command’s manual page', syn: ['man [<command>]'] },
  cd: { d: 'change the current directory (use open to go there)', syn: ['cd [blog | curio | daymark | account | proxy | ~ | ..]'], see: ['ls', 'open', 'pwd'] },
  ls: { d: 'list a directory', syn: ['ls [<path>]'], see: ['cd', 'open', 'pwd'] },
  cat: { d: 'print today’s daymark line', syn: ['cat daymark/today'] },
  sudo: { d: 'run one command as root with your own credentials (sudoers only; no ticket kept)', syn: ['sudo useradd | userdel | usermod | passwd <name>', 'sudo groups [<name>]', 'sudo who'], see: ['su', 'useradd', 'userdel', 'usermod'] },
  theme: { d: 'open the palette panel, or switch to a palette', syn: ['theme [<palette>]'] },
  lock: { d: 'sign everything out and go back to visitor', syn: ['lock'], auth: 'no verification', see: ['exit', 'su'] },
  ask: { d: 'ask Gray AI a question', syn: ['ask <question>'], desc: ['opens the Gray AI window with your question. Gray AI is for the ai group.'] },
  find: { d: 'search the four sites’ public pages by keyword', syn: ['find <keyword>'] },
  clear: { d: 'clear the screen', syn: ['clear | cls'] },
  pwd: { d: 'print the current directory', syn: ['pwd'], see: ['cd', 'ls'] },
  open: { d: 'open a path: a site, daymark/today or the account card', syn: ['open [<path>]'], see: ['cd', 'ls'] },
  history: { d: 'list this session’s commands', syn: ['history'] },
  exit: { d: 'leave one layer, or close the terminal', syn: ['exit'], see: ['lock', 'su'], desc: ['Back one layer (root → styrigx → visitor; a rescue session goes straight to visitor). Not signed in: close the terminal.'] },
  passwd: { d: 'change the account password', syn: ['passwd'], auth: 'signed in; asks your current password first', see: ['passkey'] },
  passkey: { d: 'list, add or remove account passkeys', syn: ['passkey [add | rm <n>]'], auth: 'signed in', see: ['passwd', 'device'] },
  device: { d: 'list signed-in devices, or sign one out', syn: ['device [rm <n>]', 'device rm --all'], opt: [['--all', 'sign out every other device.']], auth: 'signed in', see: ['passkey'] },
  profile: {
    d: 'show or change your profile and photo', syn: ['profile [avatar]', 'profile set name | nick | sign | email <value>'],
    desc: ['profile: name, nickname, signature and email (a site default shows when you haven’t set one).', 'set: change one field; the whole site follows at once. Name up to 40, nickname up to 32, email checked for format.', 'avatar: pick a photo and crop it, or remove yours.'],
    auth: 'signed in',
  },
  /* 代理订阅（sub v1.13）：一条 sub + 子命令，root 档 */
  sub: {
    d: 'proxy subscription: status, urls, sources, node words, fingerprint, key and token',
    syn: ['sub', 'sub show [<name>]', 'sub add | upload | rm | on | off | update <name>', 'sub mv <old> <new>', 'sub map [<word> [<target>]]', 'sub map rm <word>', 'sub map ls <name>', 'sub fp [<value>]', 'sub key', 'sub token reset'],
    ex: ['sub add dishu', 'sub map 剩余流量', 'sub map 狮城 SG', 'sub map ls dishu', 'sub fp safari'],
    desc: [
      'sub: the public key (head and tail), the token state and each source: name · airport host or file · nodes · unmatched (airports) · enabled / disabled / error.',
      'show: print the token and every source url (or just one), each with copy; works any time.',
      'add: asks for the airport link (hidden). The same name again changes the link: it is fetched once first and replaces the old one only if that works.',
      'upload: pick a local YAML file; only proxies: is kept. The same name again overwrites it.',
      'mv: rename only, nothing is refreshed; the old path 404s at once. rm: asks y/N, then deletes link, nodes and output.',
      'on / off: an off source isn\'t fetched and 404s; its link or file and output are kept. on fetches once right away.',
      'update: fetch one airport now (airports only).',
      'map: list source words. map <word>: drop every node whose name has it. map <word> <target>: put the target\'s flag (ISO 3166-1 code, two or three letters) on nodes whose name has it; the same word again changes the target. map rm <word> removes it; map ls <name> lists that airport\'s nodes that got no flag.',
      'fp [<value>]: show or set the TLS fingerprint added to every airport node: chrome (default), firefox, safari, ios, android, edge, 360, qq, random, none.',
      'key: paste an age1… X25519 public key; every source is re-encrypted right after.',
      'token reset: makes a new token (asks y/N when one exists); every old url stops working at once.',
    ],
    auth: 'root only; show, key and token reset need no reauth',
    notes: [
      'Urls are https://proxy.styrigx.com/s/<token>/<name>; every output is age-encrypted to your public key.',
      'The server keeps the token sealed with its own key, so sub show can print it again.',
      'Adding, uploading, on, off, removing or changing the key refreshes once automatically; airports also refresh every 6 hours. Changing words or the fingerprint reprocesses airports from their stored nodes without fetching. Uploaded files are never processed.',
      'Names use A–Z a–z 0–9 _ - (1–32). At most 20 sources, 800 nodes each, 2 MB per file; at most 100 map words and 50 drop words. Post-quantum keys (age1pq1…) are not supported yet.',
    ],
  },
  /* v6 身份命令（P2b）：只给 v6 身份列；正文译文在 manBody */
  whoami: { d: 'print who you are (v6 identity)', syn: ['whoami'], see: ['groups', 'who'], desc: ['Prints the current user; after su root it also shows the path, e.g. root via styrigx.'] },
  su: {
    d: 'switch user: sign in as a user, or become root (wheel)', syn: ['su <user>', 'su root'], see: ['exit', 'lock', 'whoami'],
    desc: ['su <user>: sign in as that user with its password or a passkey; a new user sets a new password on first sign-in.', 'su root: only members of wheel; asks for root’s credentials; at most 1 h, and 15 min idle in the foreground goes back.', 'exit leaves one layer; lock signs everything out.'],
    notes: ['root never signs in directly from visitor. While signed in as a user, exit first before su to another user.'],
  },
  groups: { d: 'list a user’s groups', syn: ['groups [<user>]'], see: ['usermod', 'whoami'], auth: 'signed in; another user’s groups need root' },
  who: { d: 'list signed-in sessions with their identity path', syn: ['who'], see: ['whoami'], desc: ['Each session’s identity path (root via styrigx) and when it started; you see only your own unless you are root.'] },
  useradd: {
    d: 'create a user (one-time password, shown once)', syn: ['useradd [-e <date>] [-G <group>[,<group>]...] <name>'],
    opt: [['-e <date>', 'the account stops working at 00:00 (Beijing time) on that date (YYYY-MM-DD).'], ['-G <group>[,<group>]...', 'the groups to join, comma separated.']],
    ex: ['useradd alice', 'useradd -e 2027-01-01 -G ai alice'],
    see: ['userdel', 'usermod', 'groups'],
    desc: ['Prints a one-time password once (expires in 24 h); the user must change it at first sign-in.'],
    auth: 'root, or sudo useradd (sudoers)',
    notes: ['A user with an expiry can’t join wheel, sudoers or the write groups.'],
  },
  userdel: { d: 'delete a user with its sessions, keys and groups', syn: ['userdel <name>'], see: ['useradd', 'usermod'], auth: 'root, or sudo userdel (sudoers)', notes: ['root and styrigx can’t be deleted.'] },
  usermod: {
    d: 'add a user to groups or remove it from them', syn: ['usermod -aG | -rG <group>[,<group>]... <name>'],
    opt: [['-aG <group>[,<group>]...', 'add the user to these groups.'], ['-rG <group>[,<group>]...', 'remove the user from these groups.']],
    ex: ['usermod -aG ai,sudoers alice', 'usermod -rG sudoers alice'],
    see: ['useradd', 'groups'],
    desc: ['The user’s sessions end and it signs in again.'],
    auth: 'root, or sudo usermod (sudoers)',
    notes: ['Removing the last member of wheel or sudoers asks first.'],
  },
  /* v6 P3 救援入口（定稿 v5.2 §九；文字同 v6 命令手册「救援」节） */
  rescue: {
    d: 'enter the recovery key → a 15-min root rescue session', syn: ['rescue'],
    desc: ['Only: passwd, passkey, whoami, groups, exit, lock', 'A used key can’t be used again; after a rescue, set a new value in Cloudflare'],
    notes: ['Changing the key isn’t done in the terminal; Gray changes it in the Cloudflare dashboard'],
  },
});
