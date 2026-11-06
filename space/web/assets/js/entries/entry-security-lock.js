/**
 * @fileoverview 页面入口：锁屏凭证页 = 公共 core + 锁屏凭证模块。
 */
import { initCore } from '../shell/core.js';
import '../apps/security-lock.js';
/* 只为打包分组（2026-10-24 JS 拆分）：账号各页都带 account-common + account-api，这页只用 account-api；
   这里也引一下 account-common（纯函数，无副作用），两者就合进同一个 chunk，账号页少一个请求 */
import '../apps/account-common.js';
initCore();
