/**
 * @fileoverview 终端的 man 页（终端统一 T5，设计稿 v1.5 §4 / §6.3；v5 S5 一张表）：man.js 用 import() 懒加载，不进首包。
 * 格式同锁屏 `man styrigx`：<NAME>(1) / NAME / SYNOPSIS / (END)。d 是 NAME 说明的英文底，页面上以 #sgx-i18n-shell 的 man 节为准（键 = 命令名）；命令写法不翻译。
 */
/** 命令 → { d: NAME 说明（英文底）, desc?/auth?/notes?/see?: 代理订阅页多的几节（英文）, syn: SYNOPSIS 各行（{root} / {admin} 由 man.js 换成命令字；这个文件不 import，懒加载 chunk 不牵出共享代码） } */
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
  open: { d: 'open a path: a site, daymark/today or an account layer', syn: ['open [path]', 'open ~/account/profile'] },
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
  app: { d: 'list app access, or remove it', syn: ['app', 'app rm <n>'], auth: 'signed in (sudo {root})' },
  /* 代理订阅（P2，设计稿 v1.10 §8.3）：sub-* 是账号命令（sudo root 之后）。DESCRIPTION / AUTH / NOTES / SEE ALSO 英文 */
  sub: {
    d: 'show the proxy subscription: key, link and sources', syn: ['sub'],
    desc: ['Prints the public key (head and tail), whether a download token exists, and each source:', 'name · airport host or file · nodes · on / off / error.'],
    auth: 'signed in (sudo {root})',
    notes: ['Source urls are https://proxy-rules.styrigx.com/s/<token>/<name>; every output is age-encrypted to your public key.', 'Adding, uploading, switching, removing or changing the key refreshes once automatically.'],
    see: 'sub-key(1) sub-link(1) sub-add(1) sub-upload(1) sub-mv(1) sub-on(1) sub-off(1) sub-rm(1) sub-refresh(1)',
  },
  'sub-key': { d: 'set or change the age public key', syn: ['sub-key'], desc: ['Paste an age1… X25519 public key; every source is re-encrypted right after.'], auth: 'reauth (sudo {root} reauth)', notes: ['Post-quantum keys (age1pq1…) are not supported yet.'] },
  'sub-link': { d: 'create or replace the download token', syn: ['sub-link'], desc: ['Creates the token, or asks before replacing it, then prints the token and every source url, each with copy.'], auth: 'reauth (sudo {root} reauth)', notes: ['The token is shown only this once; the server keeps only its hash. Save it in Samsung Pass.', 'Replacing it breaks the old url of every source at once.'] },
  'sub-add': { d: 'add an airport, or change its link', syn: ['sub-add <name>'], desc: ['Asks for the subscription link (hidden). The same name again changes the link: old and new hosts are shown before you confirm.'], auth: 'signed in', notes: ['A new link is fetched once first; it replaces the old one only if that works, otherwise nothing changes.', 'Names use A–Z a–z 0–9 _ - (1–32) and are the last part of the url. At most 20 sources.'] },
  'sub-upload': { d: 'upload a local YAML file as a source', syn: ['sub-upload <name>'], desc: ['Opens the file picker, uploads with a progress bar and keeps only proxies:. The same name again overwrites it.'], auth: 'signed in', notes: ['Files are not refreshed; upload again to change nodes. 2 MB at most.'] },
  'sub-mv': { d: 'rename a source', syn: ['sub-mv <old> <new>'], desc: ['Renames only; nothing is refreshed. Shows the old and new paths (token hidden) before you confirm.'], auth: 'signed in', notes: ['The old path 404s at once; change that one url on your phone. The token stays the same.'] },
  'sub-on': { d: 'turn a source on', syn: ['sub-on <name>'], auth: 'signed in', notes: ['Refreshes the source once.'] },
  'sub-off': { d: 'turn a source off', syn: ['sub-off <name>'], auth: 'signed in', notes: ['Its download 404s; the link or file and the output are kept.'] },
  'sub-rm': { d: 'delete a source', syn: ['sub-rm <name>'], desc: ['Asks y/N, then deletes the link, nodes and output.'], auth: 'signed in', notes: ['Its download 404s at once.'] },
  'sub-refresh': { d: 'refresh every source now', syn: ['sub-refresh'], desc: ['Fetches every airport, rebuilds every output and prints a line per source.'], auth: 'signed in', notes: ['A source that fails keeps its last good nodes.'] },
});
