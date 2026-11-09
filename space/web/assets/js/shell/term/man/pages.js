/**
 * @fileoverview tty2 的 man 页（终端统一 T5，设计稿 v1.5 §4 / §6.3）：man.js 用 import() 懒加载，不进首包。
 * 格式同锁屏 `man styrigx`：<NAME>(1) / NAME / SYNOPSIS / (END)。d 是 NAME 说明的英文底，页面上以 #sgx-i18n-shell 的 man 节为准（键 = 命令名）；命令写法不翻译。
 */
/** 命令 → { d: NAME 说明（英文底）, syn: SYNOPSIS 各行（{root} / {admin} 由 man.js 换成命令字；这个文件不 import，懒加载 chunk 不牵出共享代码） } */
export const PAGES = Object.freeze({
  help: { d: 'list the commands', syn: ['help', '?'] },
  man: { d: 'read a command’s manual page', syn: ['man', 'man <command>'] },
  cd: { d: 'move to a directory (on the home page, scroll to it)', syn: ['cd [blog | curio | daymark | wild | ~ | ..]'] },
  ls: { d: 'list a directory', syn: ['ls [blog | curio | daymark | wild]'] },
  cat: { d: 'print today’s daymark line', syn: ['cat daymark/today'] },
  sudo: { d: 'sign in to the account, or open site security', syn: ['sudo {root} [reauth | reset]', 'sudo {admin}'] },
  theme: { d: 'open the appearance panel, or set dark / light / auto', syn: ['theme', 'theme [dark | light | auto]'] },
  lock: { d: 'lock this device now', syn: ['lock'] },
  ask: { d: 'ask Gray AI a question', syn: ['ask <question>'] },
  clear: { d: 'clear the screen', syn: ['clear', 'cls'] },
});
