/**
 * 根凭证审计（所有 root 路径共用一套：/api/root-auth、/api/lock-reset、/api/root-audit 读）。
 *
 * 实现在共享模块 workers/shared/root-audit.js（按域参数化，账号拆分 PR1，零行为变化）；本文件只用网关的根域
 * REALM_ROOT（D1 audit 表 realm='root'、D1_ROOT_AUTH）绑好再导出，名字、参数和行为与以前相同。
 * 只追加、保留 7 天；写不进去返回 false（成功路径据此 fail closed）。
 */
import { REALM_ROOT } from './realms.js';
import { rootAuditor } from '../../../shared/root-audit.js';

export { ipPrefix } from '../../../shared/root-audit.js';

export const { writeRootAudit, listRootAudit } = rootAuditor(REALM_ROOT);
