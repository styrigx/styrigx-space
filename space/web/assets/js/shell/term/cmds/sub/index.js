import { fill } from '../../core/out.js';

/**
 * sub-*（代理订阅 P2，设计稿 v1.10 §8.1）在站内终端 / AI（tty2 / tty4）：转到账号终端（tty5）去跑——
 * 要 reauth、y/N、遮挡输入、选文件的都在那里原地做完（同 sudo root：切窗口，不跳页）。命令本身在 shell/account/proxy.js。
 */
const NAMES = ['sub', 'sub-key', 'sub-link', 'sub-add', 'sub-upload', 'sub-mv', 'sub-on', 'sub-off', 'sub-rm', 'sub-refresh'];

/** @param {string} name */
function make(name) {
  return {
    name: name,
    /* 不进 help（主页首屏自动 help 在视觉基线里）；man 索引里有 */
    /** @param {any} p @param {any} x @param {string} line */
    run: function (p, x, line) {
      if (!x.act.sub) return { out: [] };
      const r = x.act.sub(String(line || '').trim());
      return { out: [x.k.arrow(fill(x.S.opening, { x: ['k', r.href] }))], after: r.go };
    },
  };
}

export const SUB_CMDS = NAMES.map(make);
