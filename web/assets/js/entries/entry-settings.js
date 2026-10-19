/**
 * @fileoverview 页面入口：设置页 = 公共 core + 设置模块 + 搜索胶囊。
 * （账号卡和换头像已移到账号页 /settings/account/，见 entry-account.js）
 */
import { initCore } from '../shell/core.js';
import { initCapsule } from '../shell/capsule.js';
import '../apps/settings.js';
initCore();
initCapsule();
