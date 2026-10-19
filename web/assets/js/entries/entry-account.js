/**
 * @fileoverview 页面入口：账号页（账号登录 / 账号总览）= 公共 core + 账号模块 + 账号卡换头像（原在设置页）。
 */
import { initCore } from '../shell/core.js';
import '../apps/account.js';
import { initAvatarEdit } from '../apps/avatar-edit.js';
initCore();
initAvatarEdit();
