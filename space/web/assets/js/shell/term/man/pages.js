/**
 * @fileoverview 终端的 man 页（终端统一 T5；v5 S5 一张表）：man.js 用 import() 懒加载，不进首包。
 * 格式：<NAME>(1) / NAME / SYNOPSIS / DESCRIPTION / AUTH / NOTES，在终端里的全屏阅读页显示（S9，less 式）。
 * 这里的文字是英文底：页面上 NAME 说明以 #sgx-i18n-shell 的 man 节为准（键 = 命令名），DESCRIPTION / AUTH / NOTES 以 manBody 节为准
 * （键 = 命令名，{ desc: [], auth: '', notes: [] }，行数和这里一一对应；中文页每一页都要有，tests/space/ui/shell/man-i18n.test.mjs 查）。命令写法不翻译。
 */
/** 命令 → { d: NAME 说明, syn: SYNOPSIS 各行, desc? / auth? / notes?: 正文（{root} / {admin} 由 man.js 换成命令字；这个文件不 import，懒加载 chunk 不牵出共享代码） } */
export const PAGES = Object.freeze({
  man: { d: 'read a command’s manual page', syn: ['man', 'man <command>'] },
  cd: { d: 'change the current directory (use open to go there)', syn: ['cd [blog | curio | daymark | wild | account | proxy | ~ | ..]'] },
  ls: { d: 'list a directory', syn: ['ls [path]'] },
  cat: { d: 'print today’s daymark line', syn: ['cat daymark/today'] },
  sudo: {
    d: 'enter the site (sudo styrigx), sign in to the account (sudo root), or verify again (sudo -v)', syn: ['sudo {admin}', 'sudo {admin} reset', 'sudo {root} [reauth | reset]', 'sudo -v'],
    desc: ['sudo {admin}: verify with the unlock password or a passkey right here; the terminal closes and the space boots.', 'sudo -v: verify again for 3 min (as root@account it verifies the account).', 'reset: use a recovery key to reset passwords and passkeys.'],
    notes: ['A share-link session (nobody@space:~#) can’t verify again, share or change keys.'],
  },
  theme: { d: 'open the appearance panel, or set dark / light / auto', syn: ['theme', 'theme [dark | light | auto]'] },
  lock: {
    d: 'lock now, or manage the unlock password and passkeys', syn: ['lock', 'lock passwd', 'lock passkey [add | rm <n>]', 'lock --all'],
    desc: ['lock: lock this device now (no verification).', 'passwd / passkey: the keys that enter the site (not the account ones).', '--all: send every device back to visitor.'],
    auth: 'entered; passwd, passkey and --all need reauth (sudo -v)',
  },
  ask: { d: 'ask Gray AI a question', syn: ['ask <question>'] },
  find: { d: 'search the four sites’ public pages by keyword', syn: ['find <keyword>'] },
  clear: { d: 'clear the screen', syn: ['clear', 'cls'] },
  pwd: { d: 'print the current directory', syn: ['pwd'] },
  open: { d: 'open a path: a site, daymark/today or the account card', syn: ['open [path]', 'open ~/account'] },
  history: { d: 'list this session’s commands', syn: ['history'] },
  exit: { d: 'leave the current layer, sign out of the account, or close the terminal', syn: ['exit'], desc: ['In reset: leave reset. As root@account: sign out and go back to {admin}@space. Otherwise: close the terminal.'] },
  share: {
    d: 'list, create or revoke share links', syn: ['share', 'share add', 'share rm <n>', 'share rm --all'],
    desc: ['share add: name, page, how long the link lasts, and whether it carries a session.'],
    auth: 'entered with your own key; listing and revoking need reauth (sudo -v)',
  },
  passwd: { d: 'change the account password', syn: ['passwd'], auth: 'signed in (sudo {root}); reauth' },
  passkey: { d: 'list, add or remove account passkeys', syn: ['passkey', 'passkey add', 'passkey rm <n>'], auth: 'signed in (sudo {root}); reauth' },
  device: { d: 'list signed-in devices, or sign one out', syn: ['device', 'device rm <n>', 'device rm --all'], auth: 'signed in (sudo {root}); --all needs reauth' },
  app: {
    d: 'list app access, allow or deny an app', syn: ['app', 'app allow <n>', 'app deny <n>'],
    desc: ['app: every app with its scopes, when and on which device it was allowed.', 'allow: give an app access again. deny: take it away (asks y/N); the app can still read, it just can’t change anything.'],
    auth: 'signed in (sudo {root}); allow needs reauth (sudo -v)',
  },
  profile: {
    d: 'show or change your profile and photo', syn: ['profile', 'profile set name | nick | sign | email <value>', 'profile avatar'],
    desc: ['profile: name, nickname, signature and email (a site default shows when you haven’t set one).', 'set: change one field; the whole site follows at once. Name up to 40, nickname up to 32, email checked for format.', 'avatar: pick a photo and crop it, or remove yours.'],
    auth: 'signed in (sudo {root})',
  },
  /* 代理订阅（sub v3.1）：一条 sub + 子命令，账号命令（sudo root 之后） */
  sub: {
    d: 'proxy subscription: status, urls, sources, key and token',
    syn: ['sub', 'sub show [name]', 'sub add <name>', 'sub upload <name>', 'sub mv <old> <new>', 'sub rm <name>', 'sub enable | disable <name>', 'sub key', 'sub token reset'],
    desc: [
      'sub: the public key (head and tail), the token state and each source: name · airport host or file · nodes · enabled / disabled / error.',
      'show: print the token and every source url (or just one), each with copy; works any time.',
      'add: asks for the airport link (hidden). The same name again changes the link: it is fetched once first and replaces the old one only if that works.',
      'upload: pick a local YAML file; only proxies: is kept. The same name again overwrites it.',
      'mv: rename only, nothing is refreshed; the old path 404s at once. rm: asks y/N, then deletes link, nodes and output.',
      'enable / disable: a disabled source 404s; its link or file and output are kept.',
      'key: paste an age1… X25519 public key; every source is re-encrypted right after.',
      'token reset: makes a new token (asks y/N when one exists); every old url stops working at once.',
    ],
    auth: 'signed in (sudo {root}); show, key and token reset need reauth (sudo -v)',
    notes: [
      'Urls are https://proxy-rules.styrigx.com/s/<token>/<name>; every output is age-encrypted to your public key.',
      'The server keeps the token sealed with its own key, so sub show can print it again.',
      'Adding, uploading, enabling, disabling, removing or changing the key refreshes once automatically; airports also refresh every 6 hours.',
      'Names use A–Z a–z 0–9 _ - (1–32). At most 20 sources, 2 MB per file. Post-quantum keys (age1pq1…) are not supported yet.',
    ],
  },
  /* v6 身份命令（P2b）：只给 v6 身份列；正文译文在 manBody */
  whoami: { d: 'print who you are (v6 identity)', syn: ['whoami'], desc: ['Prints the current user; after su root it also shows the path, e.g. root via styrigx.'] },
  su: {
    d: 'switch user: sign in as a user, or become root (wheel)', syn: ['su <user>', 'su root'],
    desc: ['su <user>: sign in as that user with its password or a passkey; a new user sets a new password on first sign-in.', 'su root: only members of wheel; asks for root’s credentials; at most 1 h, and 15 min idle in the foreground goes back.', 'exit leaves one layer; lock signs everything out.'],
    notes: ['root never signs in directly from visitor. While signed in as a user, exit first before su to another user.'],
  },
  groups: { d: 'list a user’s groups', syn: ['groups', 'groups <user>'], auth: 'signed in; another user’s groups need root' },
  who: { d: 'list signed-in sessions with their identity path', syn: ['who'], desc: ['Each session’s identity path (root via styrigx) and when it started; you see only your own unless you are root.'] },
  useradd: {
    d: 'create a user (one-time password, shown once)', syn: ['useradd <name> [-e YYYY-MM-DD] [-G group,group]'],
    desc: ['-e: the account stops working at 00:00 (Beijing time) on that date. -G: groups, comma separated.', 'Prints a one-time password once (expires in 24 h); the user must change it at first sign-in.'],
    auth: 'root, or sudo useradd (sudoers)',
    notes: ['A user with an expiry can’t join wheel, sudoers or the write groups.'],
  },
  userdel: { d: 'delete a user with its sessions, keys and groups', syn: ['userdel <name>'], auth: 'root, or sudo userdel (sudoers)', notes: ['root and styrigx can’t be deleted.'] },
  usermod: {
    d: 'add a user to groups or remove it from them', syn: ['usermod -aG <group[,group]> <name>', 'usermod -rG <group[,group]> <name>'],
    desc: ['-aG adds the groups, -rG removes them; the user’s sessions end and it signs in again.'],
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
