/**
 * @fileoverview 页面入口：浏览器搜索页 = 公共 core + 搜索胶囊 + 浏览器搜索模块。
 */
import { initCore } from '../shell/core.js';
import { initCapsule } from '../shell/capsule.js';
import '../apps/browser-search.js';
initCore();
initCapsule();
