import { gate, layer, notHere, FLOW } from '../keys/gate.js';
import { SUB_ARGS } from './args.js';

/**
 * sub（代理订阅 v3.1）：一条命令 + 子命令（show / add / upload / mv / rm / on / off / key / token），账号命令，要 sudo root。
 * 在同一个终端里原地跑：reauth、y/N、遮挡输入、选文件都在这里做完。子命令的参数检查和流程在 shell/account/proxy.js（C.cmdSub，
 * 来源名大小写敏感，传原样的一行）；这里只把门（root）。
 */
export const SUB_CMD = {
  name: 'sub',
  args: SUB_ARGS.slice(),
  audience: /** @type {any} */ (['root']),
  /** @param {any} p @param {any} x @param {string} line */
  run: function (p, x, line) {
    const no = gate(x, 'root');
    if (no) return no;
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'sub');
    A.cmdSub(String(line || '').trim());
    return FLOW;
  },
};
