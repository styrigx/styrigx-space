/**
 * 根凭证（SGX_ROOT_KEY）校验：全站只有这一份实现（PR3「根凭证统一」）。
 *
 * 实现在共享模块 workers/shared/root-check.js（按域参数化，账号拆分 PR1，零行为变化）；本文件只用网关的根域
 * REALM_ROOT（密值 SGX_ROOT_KEY、D1_ROOT_AUTH 上的限速和审计）绑好再导出，名字、参数和行为与以前相同。
 * 用到根凭证的两条路径（/api/root-auth、/api/lock-reset verify）都走这里，再各自按用途签票；本函数不签票、不读重置开关。
 */
import { REALM_ROOT } from './realms.js';
import { rootChecker } from '../../../shared/root-check.js';

export { sleep } from '../../../shared/root-check.js';

export const { checkRootCredential } = rootChecker(REALM_ROOT);
