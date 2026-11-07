/**
 * @fileoverview baseof 内联执行（IIFE），渲染前应用继承自主站的外观和语言（sgx-ui cookie），不闪屏。
 * 紧跟在共享外壳读端 ui-cookie-read.js（baseof.html 原样内联，挂 window.SgxUI）之后执行。
 * - 语言：不在这里——首帧语言跳转是四站同一份共享外壳 lang-boot.js（baseof.html 在本脚本之前内联；语言清理 2026-11-07）
 * - 日刻没有自己的深浅色开关了：清掉旧的 sgx-theme-mode / sgx-theme-at，免得盖过主站设置
 * - 外观：SgxUI.apply(<html>) 落成和主站一样（class dark、data-theme-mode、data-dark、字号、data-palette（默认 dustyblue 不写）、
 *   自定义色内联 --sgx-seed + <style id="sgx-accent-roles">、reduced-motion / data-reduced-motion）；跟随系统时读端自己监听系统深浅色。
 * - 自定义主题色：读端有缓存首帧直接插；没缓存先按预设渲染，onMiss 再加载 <html data-sgx-accent-js> 指的引擎脚本（shell-accent.js）算好换上
 */
function loadEngine() {
  const d = document.documentElement;
  const src = d.getAttribute('data-sgx-accent-js');
  if (!src || document.getElementById('sgx-accent-js')) return;
  const s = document.createElement('script');
  s.id = 'sgx-accent-js';
  s.src = src;
  s.async = true;
  document.head.appendChild(s);
}

(() => {
  const U = /** @type {any} */ (window).SgxUI;
  try {
    localStorage.removeItem('sgx-theme-mode');
    localStorage.removeItem('sgx-theme-at');
  } catch (e) {}
  /* lang-boot 已经决定要跳就不再落外观（页面马上换掉） */
  if ((/** @type {any} */ (window)).__sgxLangGo) return;
  if (U) U.apply(document.documentElement, { onMiss: loadEngine });
})();
