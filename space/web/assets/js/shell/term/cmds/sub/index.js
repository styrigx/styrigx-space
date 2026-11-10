import { gate, layer, notHere, FLOW } from '../keys/gate.js';

/**
 * sub-*（代理订阅 P2，设计稿 v1.10 §8.1；sub v3.1 是下一个 PR）：账号命令，在同一个终端里直接跑（v5 S5：不再切到账号下拉）——
 * reauth、y/N、遮挡输入、选文件都在这里原地做完。命令本身在 shell/account/proxy.js（账号那一层的 cmdSub，来源名大小写敏感，传原样的一行）。
 */
const NAMES = ['sub', 'sub-key', 'sub-link', 'sub-add', 'sub-upload', 'sub-mv', 'sub-on', 'sub-off', 'sub-rm', 'sub-refresh'];

/** @param {string} name */
function make(name) {
  return {
    name: name,
    audience: /** @type {any} */ (['root']),
    /** @param {any} p @param {any} x @param {string} line */
    run: function (p, x, line) {
      const no = gate(x, 'root');
      if (no) return no;
      const A = layer(x, 'acct');
      if (!A) return notHere(x, name);
      A.cmdSub(String(line || '').trim());
      return FLOW;
    },
  };
}

export const SUB_CMDS = NAMES.map(make);
