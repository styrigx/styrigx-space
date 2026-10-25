/**
 * @fileoverview 页面入口：账号 → 临时钥匙（给访客的临时 LockKey：签发 / 列表 / 作废；分享短链）= 公共 core + 子页模块。
 */
import { initCore } from '../shell/core.js';
import '../apps/account-tempkeys.js';
import '../apps/account-share-links.js';
initCore();
