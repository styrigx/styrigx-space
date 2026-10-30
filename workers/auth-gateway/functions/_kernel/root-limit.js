/**
 * 根凭证限速（所有 root 路径共用一套：/api/root-auth、/api/lock-reset）。
 *
 * 实现在共享模块 workers/auth-gateway/functions/_kernel/lib/root-limit.js（按域参数化，账号拆分 PR1，零行为变化）；本文件只用网关的根域
 * REALM_ROOT（realm='root'、kind='rootkey'、D1_ROOT_AUTH）绑好再导出，名字、参数和行为与以前相同。
 * 规则：单 IP 连错 5 次锁 15 分钟；全局每小时满 ROOT_GLOBAL_SLOW_AT 次后每次先等 ROOT_GLOBAL_DELAY_MS；成功清计数。
 */
import { REALM_ROOT } from './realms.js';
import { rootLimiter } from './lib/root-limit.js';

export { ROOT_GLOBAL_SLOW_AT, ROOT_GLOBAL_DELAY_MS } from './lib/root-limit.js';

export const { checkRootLimit, recordRootFail, clearRootFail } = rootLimiter(REALM_ROOT);
