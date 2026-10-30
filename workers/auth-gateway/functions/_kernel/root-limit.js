/**
 * 锁屏根密钥输错限速（/api/root-auth、/api/lock-reset 共用一套）。
 * 实现在 lib/root-limit.js（按域参数化）；本文件用 REALM_LOCK（attempt_limit realm='lock'、kind='rootkey'、D1_LOCK_AUTH）绑好再导出。
 * 规则：单 IP 连错 5 次锁 15 分钟；全局每小时满 20 次后每次等 3 秒；成功清计数。账号根密钥的计数在账号 Worker，两边各算各的。
 */
import { REALM_LOCK } from './realms.js';
import { rootLimiter } from './lib/root-limit.js';

export { ROOT_GLOBAL_SLOW_AT, ROOT_GLOBAL_DELAY_MS } from './lib/root-limit.js';

export const { checkRootLimit, recordRootFail, clearRootFail } = rootLimiter(REALM_LOCK);
