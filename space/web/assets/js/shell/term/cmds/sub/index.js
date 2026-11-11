import { layer, notHere, v6RootGate, FLOW } from '../keys/gate.js';
import { SUB_ARGS, subSubArgs } from './args.js';

/**
 * sub（代理订阅 v3.1）：一条命令 + 子命令（show / add / upload / mv / rm / on / off / key / token），账号命令，要 root。
 * 在同一个终端里原地跑：y/N、遮挡输入、选文件都在这里做完。子命令的参数检查和流程在 shell/account/proxy.js（C.cmdSub，
 * 来源名大小写敏感，传原样的一行）；这里只把门（root）。
 * v6（v6-commands「授权与订阅（root，或 sudo）」；路由表 POST /api/account/proxy = root 档）：v6 root 直接做；
 * 别的已登录身份提示先 sudo <这一行>（P4-3，定稿 v5.5 §四「站长用 sudo 提权、不必 su root」：sudo sub … 在 keys/sudo.js 接通）；
 * 访客提示先 su <用户>。v6 P4 起旧路径（sudo root 登录 + reauth）删除。
 */
export const SUB_CMD = {
  name: 'sub',
  args: SUB_ARGS.slice(),
  subArgs: subSubArgs,
  audience: /** @type {any} */ (['root6']),
  /** @param {any} p @param {any} x @param {string} line */
  run: function (p, x, line) {
    const v6 = v6RootGate(x, 'sudo ' + String(line || '').trim());
    if ('out' in v6) return v6;
    const A = layer(x, 'acct');
    if (!A) return notHere(x, 'sub');
    if (typeof A.sudo === 'function') A.sudo(null); /* 不是 sudo 的一条（sudo sub … 在 keys/sudo.js） */
    A.cmdSub(String(line || '').trim(), { direct: true });
    return FLOW;
  },
};
