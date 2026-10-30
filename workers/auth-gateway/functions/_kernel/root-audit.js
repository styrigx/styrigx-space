/**
 * 锁屏根密钥审计（/api/root-auth、/api/lock-reset 写，/api/root-audit 读）。
 * 实现在 lib/root-audit.js（按域参数化）；本文件用 REALM_LOCK（D1 audit 表 realm='lock'、D1_LOCK_AUTH）绑好再导出。
 * 账号根密钥的审计在账号 Worker（POST /api/account audit-list），这里不读。
 * 只追加、保留 7 天；写不进去返回 false（成功路径据此 fail closed）。
 */
import { REALM_LOCK } from './realms.js';
import { rootAuditor } from './lib/root-audit.js';

export { ipPrefix } from './lib/root-audit.js';

export const { writeRootAudit, listRootAudit } = rootAuditor(REALM_LOCK);
