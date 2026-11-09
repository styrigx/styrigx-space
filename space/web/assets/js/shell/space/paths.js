/**
 * @fileoverview 进站接口地址（进站 v3 L1：界面改版，接口照旧）。前端只有这里写 /api/lock-* 等地址：
 * shell/space/api.js（锁屏 / reset / 盾牌）和 shell/space/guard.js（core chunk 里的守卫，不 import api.js 以免把通行密钥代码带进每一页）。
 * L2（SPACE-V3 §2.3）把它们换成 GET /api/space、/api/space/{session,reauth,keys,reset,tempkeys} 时只改这一个文件和 api.js。
 */
export const API = Object.freeze({
  /** GET 锁屏上该列哪些方式 { passkey, password }（读失败按都设了） */
  entry: '/api/lock-entry',
  /** GET 有没有进站会话 { ok, by, exp, next }，401 = 没有（?return= 给子站回跳） */
  sessionCheck: '/api/lock-session-check',
  /** POST 解锁密码：verify（签会话；reauth:true 签 reauth）/ set / change / remove */
  password: '/api/lock-password',
  /** POST 通行密钥：challenge / auth（reauth:true 签 reauth）/ list / register / rename / delete */
  passkey: '/api/lock-passkey',
  /** POST 临时钥匙换进站会话 { code } */
  tempkeyUnlock: '/api/lock-tempkey-unlock',
  /** POST 临时钥匙管理 list / create / revoke */
  tempkey: '/api/lock-tempkey',
  /** POST reauth 状态 / 结束 */
  reauth: '/api/lock-reauth',
  /** POST 恢复钥匙 → reset 票 / finish / end */
  reset: '/api/lock-reset',
  /** POST 本机立即锁屏 */
  lockNow: '/api/lock-now',
  /** POST 所有设备回锁屏（要 reauth） */
  lockAll: '/api/lock-all-devices',
  /** POST 分享链接（share Worker）list / create / revoke */
  share: '/api/share',
});
