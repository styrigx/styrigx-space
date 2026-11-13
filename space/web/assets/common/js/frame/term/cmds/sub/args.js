/** sub 的子命令（代理订阅 v1.13；顺序 = 补全 / man 顺序）：命令表（./index.js）和 account/proxy.js 共用这一份 */
export const SUB_ARGS = Object.freeze(['show', 'add', 'upload', 'mv', 'rm', 'on', 'off', 'update', 'map', 'fp', 'key', 'token']);

/** 上次 sub 状态里的来源名（补全用；关终端或换身份不必清，只是名字） @type {{ names: string[], airports: string[] }} */
const seen = { names: [], airports: [] };

/** account/proxy.js 拿到状态后记一下来源名 @param {any[]} list */
export function rememberSources(list) {
  seen.names = (list || []).map(function (/** @type {any} */ x) { return String(x.name); });
  seen.airports = (list || []).filter(function (/** @type {any} */ x) { return x.type === 'airport'; }).map(function (/** @type {any} */ x) { return String(x.name); });
}

/**
 * sub 第三个词的补全：token → reset；map → rm / ls；on / off → 来源名；update → 机场源名（来源名取自上次 sub 状态）
 * @param {string} a 第二个词 @returns {string[]}
 */
export function subSubArgs(a) {
  if (a === 'token') return ['reset'];
  if (a === 'map') return ['rm', 'ls'];
  if (a === 'on' || a === 'off') return seen.names.slice();
  if (a === 'update') return seen.airports.slice();
  return [];
}
