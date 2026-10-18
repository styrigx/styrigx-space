/**
 * @fileoverview 页面入口：设置页 = 公共 core + 设置模块 + 搜索胶囊 + 账户卡换头像。
 */
import { initCore } from '../shell/core.js';
import { initCapsule } from '../shell/capsule.js';
import '../apps/settings.js';
import { initAvatarEdit } from '../apps/avatar-edit.js';
initCore();
initCapsule();
initAvatarEdit();
