import { gate, layer, notHere, v6RootGate, FLOW } from '../keys/gate.js';
import { SUB_ARGS, subSubArgs } from './args.js';

/**
 * sub（代理订阅 v3.1）：一条命令 + 子命令（show / add / upload / mv / rm / on / off / key / token），账号命令，要 root。
 * 在同一个终端里原地跑：reauth、y/N、遮挡输入、选文件都在这里做完。子命令的参数检查和流程在 shell/account/proxy.js（C.cmdSub，
 * 来源名大小写敏感，传原样的一行）；这里只把门（root）。
 * 割接（v6-commands「授权与订阅（root，或 sudo）」；路由表 POST /api/account/proxy = root 档，#401）：有 v6 会话时按 v6 身份——
 * v6 root 直接做（{ direct: true }：不查旧账号会话、show / key / token 不跑旧的 sudo root reauth，同 #402 share）；
 * v6 普通用户提示先 su root（同 share）；访客提示先 su <用户>。没有 v6 会话时旧路径原样（sudo root 登录 + reauth，P4 删）。
 */
export const SUB_CMD = {
  name: 'sub',
  args: SUB_ARGS.slice(),
  subArgs: subSubArgs,
  audience: /** @type {any} */ (['root', 'root6']),
  /** @param {any} p @param {any} x @param {string} line */
  run: function (p, x, line) {
    const v6 = v6RootGate(x);
    if (v6 && 'out' in v6) return v6;
    if (!v6) {
      const no = gate(x, 'root');
      if (no) return no;
    }
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'sub');
    A.cmdSub(String(line || '').trim(), { direct: !!v6 });
    return FLOW;
  },
};
