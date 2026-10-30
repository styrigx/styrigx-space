/**
 * 锁屏根密钥（SGX_ADMIN_KEY）校验：网关里只有这一份实现。
 * 实现在 lib/root-check.js（按域参数化）；本文件用 REALM_LOCK（rootKey = SGX_ADMIN_KEY，计数 / 审计经 D1_LOCK_AUTH，realm='lock'）绑好再导出。
 * 用到锁屏根密钥的两条路径（/api/root-auth、/api/lock-reset verify）都走这里，再各自按用途签票；本函数不签票、不读重置开关。
 */
import { REALM_LOCK } from './realms.js';
import { rootChecker } from './lib/root-check.js';

export { sleep } from './lib/root-check.js';

export const { checkRootCredential } = rootChecker(REALM_LOCK);
