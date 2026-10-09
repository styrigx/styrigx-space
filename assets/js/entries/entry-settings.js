/**
 * @fileoverview 页面入口：设置页 = 公共 core + 设置模块 + 搜索胶囊。
 */
import { initCore } from '../sgx/core.js';
import { initCapsule } from '../sgx/capsule.js';
import '../sgx/page-settings.js';
initCore();
initCapsule();
