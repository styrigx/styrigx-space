/**
 * @fileoverview 通行密钥行的显示名（语言清理 2026-11-07）。
 *
 * 服务端只存中性数据：name = 用户自己起的名字（没起 = ''），provider = 密码管理器 id（如 'google-password-manager'）。
 * - 用户自起的名字属于「个人信息类」：原样显示，不翻译（调用方给元素加 translate="no" data-sgx-personal，见 lib/personal.js）。
 * - 没起名时的默认名是界面文案：provider 的显示名（字符串表 pkProv_<id>）或 pkUnnamed，按页面语言。
 */

/**
 * provider id → 当前语言的显示名；字符串表里没有 → ''。
 * @param {string} id
 * @param {(key: string) => string} t
 */
export function providerLabel(id, t) {
  if (!id || !/^[a-z0-9-]+$/.test(String(id))) return '';
  return t('pkProv_' + String(id).replace(/-/g, '_')) || '';
}

/**
 * 没起名时显示的默认名：provider 显示名，没有就是 pkUnnamed。
 * @param {{ provider?: string }} k
 * @param {(key: string) => string} t
 */
export function defaultPasskeyName(k, t) {
  return providerLabel(k.provider || '', t) || t('pkUnnamed');
}
