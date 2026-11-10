/**
 * v6 身份统一（P1）：用户、组与权限判断——全站唯一一处回答「这个身份够不够这一档」。
 *
 * - uid：root = 0（唯一超级用户，只管用户 / 凭据 / 授权 / 删除）；styrigx = 1000（第一个普通用户）；之后的普通用户从 1001 起。
 * - 组（GROUPS）：wheel（可 su root）、sudoers（可 sudo）、listen（听歌）、ai（AI 窗口）、status（旷野状态卡）、
 *   curio-write / daymark-write（上传、编辑、单条删除）。删除不做组：批量 / 结构删除只属 root。
 * - fail-closed：新用户默认无组；styrigx 的默认组 = STYRIGX_DEFAULT_GROUPS。
 * - 临时用户（有 expires_at）永不进 wheel、sudoers、写组（canJoinGroup 拒绝，代码级，不靠 root 自觉）。
 * - 访问档（ACCESS 的取值）：public（谁都行）/ user（任一已登录身份，含无组的临时用户：改自己的凭据、whoami 这类）/
 *   组名 / root。不认识的档一律拒绝。
 * - 救援会话（rescue）：是 root 会话，但只放 rescue 白名单里的档（RESCUE_LEVELS）和标了 rescue 的路由（core/route-access.js）。
 *
 * 判断只在这里：permits(identity, level, { rescue })。网关与子站接口 Worker 只传路由（或拿结论），不自己比组。
 *
 * 叶子模块：不 import 任何东西。
 */

/** root 的 uid（Linux 语义） */
export const ROOT_UID = 0;
/** styrigx 的 uid（第一个普通用户） */
export const STYRIGX_UID = 1000;
/** 新建普通用户的起始 uid */
export const FIRST_USER_UID = 1001;
/** 用户名：小写字母开头，小写字母 / 数字 / 连字符，2–32 位（Linux useradd 的常见约束收窄） */
export const USER_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** 全部组（顺序 = 展示顺序） */
export const GROUPS = Object.freeze(['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']);
/** 特权组：可 su root / sudo */
export const PRIVILEGED_GROUPS = Object.freeze(['wheel', 'sudoers']);
/** 写组：上传、编辑、单条内容删除 */
export const WRITE_GROUPS = Object.freeze(['curio-write', 'daymark-write']);
/** styrigx 的默认组（v6 定稿 §三） */
export const STYRIGX_DEFAULT_GROUPS = Object.freeze(['wheel', 'sudoers', 'listen', 'ai', 'status', 'curio-write', 'daymark-write']);

/** 访问档里不是组名的三个取值（组名不许和它们重名） */
export const ACCESS = Object.freeze({ PUBLIC: 'public', USER: 'user', ROOT: 'root' });
/** 全部合法的访问档 */
export const ACCESS_LEVELS = Object.freeze([ACCESS.PUBLIC, ACCESS.USER, ...GROUPS, ACCESS.ROOT]);

/**
 * 某组能不能加给这个用户（usermod -aG / useradd -G 都先过这里）。
 * - 不认识的组 → unknown-group
 * - root 不进组（root 本来就是全部权限）→ root
 * - 临时用户（expiresAt > 0）进特权组或写组 → temporary
 * @param {{uid:number, expiresAt:number}} user @param {string} group
 * @returns {{ok:true}|{ok:false, reason:'unknown-group'|'root'|'temporary'}}
 */
export function canJoinGroup(user, group) {
  if (GROUPS.indexOf(group) === -1) return { ok: false, reason: 'unknown-group' };
  if (!user || user.uid === ROOT_UID) return { ok: false, reason: 'root' };
  const temporary = Number(user.expiresAt) > 0;
  if (temporary && (PRIVILEGED_GROUPS.indexOf(group) !== -1 || WRITE_GROUPS.indexOf(group) !== -1)) return { ok: false, reason: 'temporary' };
  return { ok: true };
}

/**
 * @typedef {{ uid:number, name:string, groups:ReadonlyArray<string>, rescue:boolean }} Identity
 *   admit 判定出的当前身份（栈顶）。访客没有 Identity（null）。
 */

/**
 * 这个身份够不够这一档（全站唯一的判断）。
 * - public：谁都行（含访客 null）
 * - 访客（null / 不像身份的东西）：只有 public
 * - 救援会话：只放 opts.rescue === true 的路由（白名单在路由表里标），其余一律拒绝——即使它是 root
 * - user：任一已登录身份
 * - root：只有 uid 0
 * - 组名：root 全部通过（超级用户）；普通用户要在组里
 * - 不认识的档：拒绝（fail closed）
 * @param {Identity|null|undefined} identity @param {string} level @param {{rescue?:boolean}} [opts]
 * @returns {boolean}
 */
export function permits(identity, level, opts) {
  if (ACCESS_LEVELS.indexOf(level) === -1) return false;
  if (level === ACCESS.PUBLIC) return true;
  if (!identity || typeof identity !== 'object' || !Number.isInteger(identity.uid)) return false;
  if (identity.rescue === true) return !!(opts && opts.rescue === true);
  if (level === ACCESS.USER) return true;
  if (identity.uid === ROOT_UID) return true;
  if (level === ACCESS.ROOT) return false;
  return Array.isArray(identity.groups) && identity.groups.indexOf(level) !== -1;
}

/**
 * 救援会话里终端分发器的白名单（P2 / P3 的命令分发用；定稿 §七、Muse 复盘 1）：只放重置凭据和看自己 / 离开。
 * 救援不建用户、不改组。
 */
export const RESCUE_COMMANDS = Object.freeze(['passwd', 'passkey', 'recovery-key', 'whoami', 'groups', 'exit', 'lock']);
