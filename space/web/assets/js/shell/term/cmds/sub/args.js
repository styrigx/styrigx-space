/** sub 的子命令（代理订阅 v3.1；顺序 = 补全 / man 顺序）：命令表（./index.js）和 shell/account/proxy.js 共用这一份（最后一个 token 带第三个词 reset） */
export const SUB_ARGS = Object.freeze(['show', 'add', 'upload', 'mv', 'rm', 'enable', 'disable', 'key', 'token']);
/** sub 第三个词的补全（sub token reset，S9） @param {string} a 第二个词 @returns {string[]} */
export function subSubArgs(a) { return a === SUB_ARGS[SUB_ARGS.length - 1] ? ['reset'] : []; }
