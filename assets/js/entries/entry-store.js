/**
 * @fileoverview 页面入口：应用商店页 = 公共 core + 商店模块 + 搜索胶囊。
 */
import { initCore } from '../sgx/core.js';
import { initCapsule } from '../sgx/capsule.js';
import '../sgx/page-store.js';
initCore();
initCapsule();
