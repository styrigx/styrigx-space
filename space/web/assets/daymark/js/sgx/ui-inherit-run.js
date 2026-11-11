/**
 * @fileoverview baseof 内联执行（IIFE），渲染前应用继承自主站的外观和语言（sgx-ui cookie），不闪屏。
 * 紧跟在共享外壳读端 ui-cookie-read.js（baseof.html 原样内联，挂 window.SgxUI）之后执行。
 * - 语言：不在这里——首帧语言跳转是四站同一份共享外壳 lang-boot.js（baseof.html 在本脚本之前内联；语言清理 2026-11-07）
 * - 日刻没有自己的外观开关：清掉旧的 sgx-theme-at
 * - 2026-11-12 调色板 v4：深浅模式和自定义主题色删除，四站同源，首帧一次性清掉 sgx-theme-mode / sgx-accent / sgx-accent-css（和主站 baseof 同一批）
 * - 外观：SgxUI.apply(<html>) 落成和主站一样（class dark = 当前是深套、data-dark、字号、data-palette（默认 terra 不写）、
 *   color-scheme / theme-color 按本套、reduced-motion / data-reduced-motion）；深浅只由调色板决定，不读 prefers-color-scheme。
 */
(() => {
  const U = /** @type {any} */ (window).SgxUI;
  try {
    ['sgx-theme-at', 'sgx-theme-mode', 'sgx-accent', 'sgx-accent-css'].forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
  /* lang-boot 已经决定要跳就不再落外观（页面马上换掉） */
  if ((/** @type {any} */ (window)).__sgxLangGo) return;
  if (U) U.apply(document.documentElement);
})();
