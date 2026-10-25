/**
 * 「先读、有才删」（2026-10-26，PR E 的 E7）：验对之后清失败计数用。
 *
 * 免费计划的 KV 删除按整个账号每天 1000 次算（和写、列一样），读是 10 万次。绝大多数成功登录之前没有输错过，
 * 以前每次成功都无条件删 2 个（密码）/ 1 个（根凭证）计数键，等于白白花掉删除额度。
 *
 * 和无条件删除的安全语义相同（论证见 tests/workers/auth-gateway/kv-clear.test.mjs 的头注释和 PR 说明）：
 * - 读到有值 → 删，和以前一样；读到没有 → 不删。以前这时的删除只可能删掉「读之后、删之前」别的并发请求刚写进来的
 *   失败记录——那正是不该删的；现在保留它，只会让限速更严，不会更松
 * - 读出错（KV 不可用）→ 当作不知道，照旧去删（和以前一样尽力而为，出错吞掉）
 * - 只用在「清计数」上，计数的增加（recordFail / recordRootFail）和冷却判断都不经这里
 */

/**
 * @param {any} kv
 * @param {string} key
 * @returns {Promise<boolean>} 是否发出了删除
 */
export async function deleteIfPresent(kv, key) {
  let v;
  try {
    v = await kv.get(key);
  } catch (e) {
    v = undefined; /* 读不到 = 不知道有没有 → 照旧删 */
  }
  if (v === null) return false;
  await kv.delete(key);
  return true;
}
