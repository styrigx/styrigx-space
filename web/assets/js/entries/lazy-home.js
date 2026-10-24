/**
 * @fileoverview 按需加载的「home」栏（另外两栏的入口 entry-tab-*.js 用 import() 取）。
 * 顺带 import 一下 core：让 esbuild 把 core 用到的全部模块算作「所有入口都用」，合进同一个共享 chunk，
 * 不会因为按需入口用到其中一部分就把共享代码切成好几个碎 chunk（每页多好几个请求）。core.js 顶层没有副作用，import 不会多初始化什么。
 */
import '../shell/core.js';
export { mountHome } from '../apps/index.js';
