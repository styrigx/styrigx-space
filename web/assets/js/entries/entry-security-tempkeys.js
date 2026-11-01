/**
 * @fileoverview 页面入口：设置 → 安全与隐私 → 临时钥匙（/settings/security/tempkeys/；给访客的临时 LockKey：签发 / 列表 / 作废；分享短链）
 * = 公共 core + 子页模块。
 */
import { initCore } from '../shell/core.js';
import '../apps/security-tempkeys.js';
import '../apps/security-share-links.js';
initCore();
