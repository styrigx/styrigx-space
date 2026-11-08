/**
 * @fileoverview 让密码管理器（Samsung Pass / Google 密码管理器）把已有的账号通行密钥条目改成服务端给的显示名：
 * PublicKeyCredential.signalCurrentUserDetails（原 apps/account-common.js signalAccountName）。
 * 只对「当前账号 handle」（passkey-list 回的 userHandle）发；旧 handle 和锁屏 LockKey 共用，绝不能对它发，否则会把 LockKey 条目改名。
 * 每页只发一次；不支持 / 没有 handle → 不发；API 抛错 / reject 都吞掉。
 */
import { PASSKEY_USER_NAME } from './api.js';

let signalled = false;

/** @param {{userHandle?: string, userName?: string, displayName?: string}|null} info passkey-list 的结果 @returns {boolean} 发了没有 */
export function signalPasskeyName(info) {
  try {
    const PKC = /** @type {any} */ (window).PublicKeyCredential;
    if (signalled || !PKC || typeof PKC.signalCurrentUserDetails !== 'function') return false;
    const uh = info && info.userHandle;
    if (!uh || typeof uh !== 'string') return false;
    signalled = true;
    const p = PKC.signalCurrentUserDetails({
      rpId: location.hostname,
      userId: uh,
      name: (info && info.userName) || PASSKEY_USER_NAME,
      displayName: (info && info.displayName) || 'Sloan Gray',
    });
    if (p && typeof p.catch === 'function') p.catch(function () {});
    return true;
  } catch (e) {
    return false;
  }
}

/** 单测用 */
export function _resetSignalForTest() { signalled = false; }
