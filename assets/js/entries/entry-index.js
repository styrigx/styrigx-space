/**
 * @fileoverview 页面入口：首页 = 公共 core + 首页模块 + 锁屏。
 */
import { initCore } from '../sgx/core.js';
import { initLock } from '../sgx/lock.js';
import '../sgx/page-index.js';
initCore();
initLock();
