/**
 * 网关 D1 的域描述（realm 列）。v6 P4（定稿 v5.2 §十三）起进站签发删除：三张锁屏票、签名钥匙对 SGX_SPACE_*、旧恢复钥匙、旧 pepper、
 * 进站 cookie 与锁屏凭证（解锁密码 / 锁屏通行密钥）都删了；身份只由账号 Worker styrigx-account 签发。
 *
 * 剩下的只有 realm='lock' 这个行标签和它所在的绑定：
 * - AI 全站总闸（attempt_limit realm='ai'，core/ai-limit.js 自己的域描述）
 * - 旧进站审计的只读列表（audit realm='lock'，core/space-audit.js / api/space-audit.js）
 * 存储：D1 styrigx-space-core，只经 D1_SPACE。
 * 叶子模块：不 import 任何东西。
 */

/** 锁屏域（行标签 'lock'，绑定 D1_SPACE） */
export const REALM_LOCK = Object.freeze({
  id: 'lock',
  d1Binding: 'D1_SPACE',
});

/** 全部域（按 id 索引，供测试与通用代码遍历） */
export const REALMS = Object.freeze({
  lock: REALM_LOCK,
});
