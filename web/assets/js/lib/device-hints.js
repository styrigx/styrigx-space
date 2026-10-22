/**
 * @fileoverview 登录时带上的设备信息（设置 › 账号 › 设备 显示用）。
 *
 * navigator.userAgentData.getHighEntropyValues 给型号（三星浏览器 / Chrome：SM-S918B）、
 * 平台和平台版本；Firefox / Safari 没有这个接口，返回 null，服务端只从 User-Agent 推。
 * 模块加载时就开始取（异步），登录提交时用已经拿到的值，不等待、不挡登录。
 */

/** @type {{model:string, platform:string, platformVersion:string}|null} */
let hints = null;

try {
  const uad = /** @type {any} */ (navigator).userAgentData;
  if (uad && typeof uad.getHighEntropyValues === 'function') {
    uad.getHighEntropyValues(['model', 'platform', 'platformVersion']).then(function (/** @type {any} */ v) {
      hints = {
        model: String((v && v.model) || '').slice(0, 40),
        platform: String((v && v.platform) || '').slice(0, 20),
        platformVersion: String((v && v.platformVersion) || '').slice(0, 20),
      };
    }, function () {});
  }
} catch (e) {}

/** 当前拿到的设备信息；还没拿到 / 不支持 → null */
export function deviceHints() {
  return hints;
}
