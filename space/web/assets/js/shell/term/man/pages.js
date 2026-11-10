/**
 * @fileoverview tty2 的 man 页（终端统一 T5，设计稿 v1.5 §4 / §6.3）：man.js 用 import() 懒加载，不进首包。
 * 格式同锁屏 `man styrigx`：<NAME>(1) / NAME / SYNOPSIS / (END)。d 是 NAME 说明的英文底，页面上以 #sgx-i18n-shell 的 man 节为准（键 = 命令名）；命令写法不翻译。
 */
/** 命令 → { d: NAME 说明（英文底）, desc?/auth?/notes?/see?: 代理订阅页多的几节（英文）, syn: SYNOPSIS 各行（{root} / {admin} 由 man.js 换成命令字；这个文件不 import，懒加载 chunk 不牵出共享代码） } */
export const PAGES = Object.freeze({
  help: { d: 'list the commands', syn: ['help', '?'] },
  man: { d: 'read a command’s manual page', syn: ['man', 'man <command>'] },
  cd: { d: 'change the current directory (use open to go there)', syn: ['cd [blog | curio | daymark | wild | account | shield | ~ | ..]'] },
  ls: { d: 'list a directory', syn: ['ls [path]'] },
  cat: { d: 'print today’s daymark line', syn: ['cat daymark/today'] },
  sudo: { d: 'sign in to the account, or open site security', syn: ['sudo {root} [reauth | reset]', 'sudo {admin}'] },
  theme: { d: 'open the appearance panel, or set dark / light / auto', syn: ['theme', 'theme [dark | light | auto]'] },
  lock: { d: 'lock this device now', syn: ['lock'] },
  ask: { d: 'ask Gray AI a question', syn: ['ask <question>'] },
  clear: { d: 'clear the screen', syn: ['clear', 'cls'] },
  pwd: { d: 'print the current directory', syn: ['pwd'] },
  open: { d: 'open a path: a site, daymark/today, an account or shield layer', syn: ['open [path]', 'open ~/account/security', 'open ~/shield/keys'] },
  tty: { d: 'show this terminal, or open another (3 shield · 4 AI · 5 account)', syn: ['tty', 'tty [2 | 3 | 4 | 5]'] },
  /* 代理订阅（P2，设计稿 v1.10 §8.3）：sub-* 在账号终端（tty5）里跑，别的终端转过去。DESCRIPTION / AUTH / NOTES / SEE ALSO 英文 */
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
