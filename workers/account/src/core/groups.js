/**
 * v6 身份统一（P1）：用户、组与权限判断——全站唯一一处回答「这个身份够不够这一档」。
 *
 * - uid：root = 0（唯一超级用户，只管用户 / 凭据 / 授权 / 删除）；styrigx = 1000（第一个普通用户）；之后的普通用户从 1001 起。
 * - 组（GROUPS，组权限重设计 v1.1 §二–§五，2026-11-21）：三类——
 *   特殊组 SPECIAL_GROUPS：wheel（可 su root）、sudoers（可 sudo）；
 *   产品组，每个产品一对 `<产品>-use` / `<产品>-manage`：use = 用这个产品（听歌、AI 窗口、状态卡、看这个产品的私密行），
 *   manage = 管这个产品的内容（上传、新增、编辑、单条删除）；manage 包含 use（permits 第 3 步一处实现，不靠同时加两个组）。
 *   USE_GROUPS：music-use、curio-use、daymark-use、status-use、ai-use、games-use；MANAGE_GROUPS：music-manage、curio-manage、daymark-manage、games-manage
 *   （games-use / games-manage：奇趣重组设计稿 v1.0 第三节 PR 1，游戏拆成第五个子站，新产品缀在最后）。
 *   删除不做组：批量 / 结构删除只属 root。（v1.1 前的旧名 listen / ai / status / curio-write / daymark-write 已不认，见 ADR-0007。）
 * - fail-closed：新用户默认无组；styrigx 的默认组 = STYRIGX_DEFAULT_GROUPS（= 全部组）。
 * - 普通用户（uid 1001 起，含临时用户）永不进特殊组、manage 组（canJoinGroup 拒绝，代码级，不靠 root 自觉；v1.1 §四「manage 不放权」）。
 * - 访问档（ACCESS 的取值）：public（谁都行）/ user（任一已登录身份，含无组的临时用户：改自己的凭据、whoami 这类）/
 *   组名 / webmaster（站长 = styrigx 的 uid；名片属于站长，P2）/ root。不认识的档一律拒绝。
 * - 判断顺序固定（定稿 v4 §三，P2）：① 救援会话 → 只放标了 rescue 的路由 / action（白名单），其余一律拒、不往下走；
 *   ② root → 一律放行，不留例外；③ 按档：public 谁都行、user 任一已登录身份、组名看组、webmaster 看是不是 styrigx。
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

/** 特殊组：可 su root / sudo（只有站长） */
export const SPECIAL_GROUPS = Object.freeze(['wheel', 'sudoers']);
/** use 组：用这个产品（含看这个产品的私密行；root 可授给任何人） */
export const USE_GROUPS = Object.freeze(['music-use', 'curio-use', 'daymark-use', 'status-use', 'ai-use', 'games-use']);
/** manage 组：管这个产品的内容——上传、新增、编辑、单条删除（只有站长） */
export const MANAGE_GROUPS = Object.freeze(['music-manage', 'curio-manage', 'daymark-manage', 'games-manage']);
/** 全部组（顺序 = 展示顺序） */
export const GROUPS = Object.freeze([...SPECIAL_GROUPS, ...USE_GROUPS, ...MANAGE_GROUPS]);
/** styrigx 的默认组（v1.1 §四：wheel、sudoers、全部 -use、全部 -manage） */
export const STYRIGX_DEFAULT_GROUPS = GROUPS;

/** 产品组名的写法：`<产品>-use` / `<产品>-manage` */
export const PRODUCT_GROUP_RE = /^([a-z][a-z0-9]*)-(use|manage)$/;
/** 有 use 组的产品（路由表 product 的合法取值；顺序同 USE_GROUPS） */
export const PRODUCTS = Object.freeze(USE_GROUPS.map((g) => g.slice(0, -'-use'.length)));
/** 产品的 use 组名（不认识的产品 → null） @param {string} product */
export function useGroupOf(product) {
  const g = product + '-use';
  return USE_GROUPS.indexOf(g) !== -1 ? g : null;
}
/** 产品的 manage 组名（没有 manage 组的产品，如 status、ai → null） @param {string} product */
export function manageGroupOf(product) {
  const g = product + '-manage';
  return MANAGE_GROUPS.indexOf(g) !== -1 ? g : null;
}

/** 访问档里不是组名的四个取值（组名不许和它们重名）；WEBMASTER = 站长（styrigx 的 uid，名片属于站长，P2） */
export const ACCESS = Object.freeze({ PUBLIC: 'public', USER: 'user', WEBMASTER: 'webmaster', ROOT: 'root' });
/** 全部合法的访问档 */
export const ACCESS_LEVELS = Object.freeze([ACCESS.PUBLIC, ACCESS.USER, ...GROUPS, ACCESS.WEBMASTER, ACCESS.ROOT]);

/** 临时用户：有期限（expires_at > 0）。临时用户永不进特殊组、manage 组 @param {{expiresAt:number}|null|undefined} user */
export function isTemporary(user) {
  return !!user && Number(user.expiresAt) > 0;
}

/** 只有站长能进的组：特殊组 + manage 组（v1.1 §四） @param {string} group */
export function isGuardedGroup(group) {
  return SPECIAL_GROUPS.indexOf(group) !== -1 || MANAGE_GROUPS.indexOf(group) !== -1;
}

/**
 * 某组能不能加给这个用户（usermod -aG / useradd -G 都先过这里）。
 * - 不认识的组 → unknown-group
 * - root 不进组（root 本来就是全部权限）→ root
 * - 临时用户（expiresAt > 0）进特殊组或 manage 组 → temporary
 * - 其余普通用户（uid 1001 起，无期限）进特殊组或 manage 组 → action（定稿 v5.5 §四「代码拒绝加入 wheel、sudoers、写组」，v1.1 §四写组换成 manage 组；
 *   自上而下按 man：报找不到命令，同未知命令的错误码 action，Gray 11-11 22:36）；站长 styrigx（1000）不受限
 * @param {{uid:number, expiresAt:number}} user @param {string} group
 * @returns {{ok:true}|{ok:false, reason:'unknown-group'|'root'|'temporary'|'action'}}
 */
export function canJoinGroup(user, group) {
  if (GROUPS.indexOf(group) === -1) return { ok: false, reason: 'unknown-group' };
  if (!user || user.uid === ROOT_UID) return { ok: false, reason: 'root' };
  const guarded = isGuardedGroup(group);
  const temporary = Number(user.expiresAt) > 0;
  if (temporary && guarded) return { ok: false, reason: 'temporary' };
  if (guarded && Number.isInteger(user.uid) && user.uid >= FIRST_USER_UID) return { ok: false, reason: 'action' };
  return { ok: true };
}

/**
 * @typedef {{ uid:number, name:string, groups:ReadonlyArray<string>, rescue:boolean }} Identity
 *   admit 判定出的当前身份（栈顶）。访客没有 Identity（null）。
 */

/**
 * 「救援 → root」两步的唯一实现（Muse 审查 v5 注意点 2）：permits() 和任何 root 快速放行（core/admit.js）都只调这里，不各写一份。
 * - 救援会话：opts.rescue === true（白名单路由 / action）→ true，否则 false（一律拒，不往下走）
 * - root（uid 0，非救援）→ true
 * - 其余 → null（交给按档判断）
 * @param {Identity|null|undefined} identity @param {{rescue?:boolean}} [opts]
 * @returns {boolean|null}
 */
export function precedence(identity, opts) {
  const id = identity && typeof identity === 'object' && Number.isInteger(identity.uid) ? identity : null;
  if (!id) return null;
  if (id.rescue === true) return !!(opts && opts.rescue === true);
  if (id.uid === ROOT_UID) return true;
  return null;
}

/**
 * 这个身份够不够这一档（全站唯一的判断）。顺序固定（定稿 v4 §三）：
 * 0. 不认识的档：拒绝（fail closed）
 * 1. 救援会话（identity.rescue === true）：只放 opts.rescue === true 的路由 / action（白名单在路由表里标），其余一律拒绝，
 *    不往下走——即使它是 root、即使这一档是 public
 * 2. root（uid 0）：一律放行，不留例外
 * 3. 按档：public 谁都行（含访客 null）；访客只有 public；user 任一已登录身份；root 档只有 root（第 2 步已放）；
 *    webmaster 只有站长 styrigx；组名要在组里；档是 `X-use` 时 `X-manage` 的成员也放行（manage 包含 use，v1.1 §五）
 * admit 若有 root 快速放行，同样要先过第 1 步（core/admit.js 只经这里判断，没有别的快速路径）。
 * @param {Identity|null|undefined} identity @param {string} level @param {{rescue?:boolean}} [opts]
 * @returns {boolean}
 */
export function permits(identity, level, opts) {
  if (ACCESS_LEVELS.indexOf(level) === -1) return false;
  const id = identity && typeof identity === 'object' && Number.isInteger(identity.uid) ? identity : null;
  const pre = precedence(id, opts);
  if (pre !== null) return pre;
  if (level === ACCESS.PUBLIC) return true;
  if (!id) return false;
  if (level === ACCESS.USER) return true;
  if (level === ACCESS.ROOT) return false;
  if (level === ACCESS.WEBMASTER) return id.uid === STYRIGX_UID;
  if (!Array.isArray(id.groups)) return false;
  if (id.groups.indexOf(level) !== -1) return true;
  /* manage ⊇ use：只认 USE_GROUPS 里的档，对应的 manage 组要真在 MANAGE_GROUPS 里 */
  if (USE_GROUPS.indexOf(level) === -1) return false;
  const mg = manageGroupOf(level.slice(0, -'-use'.length));
  return mg !== null && id.groups.indexOf(mg) !== -1;
}

/**
 * 救援会话的命令白名单（定稿 v4 §九）：只放重置 root 凭据和看自己 / 离开；R-34（稿 v3.11 第 8 节，Gray 2026-11-15 02:07）起
 * passwd 另含 passwd styrigx（路由表 passwd-user，服务端只收站长）。救援不建用户、不改组、不换钥匙
 * （换钥匙由 Gray 在 Cloudflare dashboard 改，不走终端）。路由表 /api/identity 的 rescueActions 与它一致（单测核对）。
 */
export const RESCUE_COMMANDS = Object.freeze(['passwd', 'passkey', 'whoami', 'groups', 'exit', 'lock']);
