/**
 * @fileoverview 旷野页（/wild/）与主页的页面模块：自定义主题色同步、首屏 about 卡 Uptime（screen-time 窗 v6 P4 随数字健康删除，定稿 v5.5 §四）。
 * 2026-11 对齐 PR-C：风格页 /theme/ 退役（调色板 / 恢复默认都在顶栏外观弹层），调色板网格代码删除。
 * 2026-11 对齐 PR-B：/wellbeing/ /about/ 并进旷野页 /wild/，15 分钟提醒删除（Gray 04:01）。
 * P4-3 PR-4b（2026-11-07，Gray）：显示页（/display/）整页删除——深色 / 跟随系统 / 语言 / 布局都在快捷面板（共享外壳），这里不再有主题模式、布局、语言三段。
 * P4-3 PR-4b（2026-11-07）：由 apps/settings.js 改名；主页和设置合成「旷野 / Space」一页，页内切换、DeX 双栏、旧 hash 跳转删除。
 * （2026-10-23 PR-E：字体大小、减弱动效、重置所有设置删除；P4-2c：日期和时间、天气、快捷键连同高级功能分类删除）
 * 文案来自页面内 sgx-i18n-space JSON（中英双语），JS 与语言无关。
 * mountSpace() 在加载时挂一次（入口 entry-space.js / entry-space-wild.js），返回 destroy()：拆掉本次挂的全部监听。
 */
import { on as evOn } from '../lib/events.js';
import { syncAccent } from '../lib/accent-roles.js';
import { uptimeDays, uptimeText } from '../lib/uptime.js';

/**
 * 挂旷野页 / 旷野子页。返回 destroy()：移除这次挂上的所有监听（含 features 订阅）。
 * @returns {() => void}
 */
export function mountSpace() {
  /** @type {Array<() => void>} */
  const offs = [];
  /** 同 lib/events.js on()，但记下清理函数，destroy 时统一拆 @type {typeof evOn} */
  const on = function (t, type, fn, o) {
    const off = evOn(t, type, fn, o);
    offs.push(off);
    return off;
  };

  /* 自定义主题色（sgx-accent）：缓存缺失 / 过期时按种子重算整套角色（lib/palette-scheme.js）。
     风格页 /theme/ 的调色板网格 2026-11 对齐 PR-C 退役（功能在顶栏外观弹层，共享外壳 quick-panel.js），这里只剩这一步。 */
  syncAccent();

  /* ---- 主页首屏 about 卡（v5 S7，原旷野 › about 窗）neofetch 的 Uptime（自 2026-10-07，Gray 2026-11-09）：构建时写过一份，这里按今天重算（页面可能是几天前构建的） ---- */
  (function () {
    const up = document.querySelector('[data-about="uptime"][data-since]');
    if (up) up.textContent = uptimeText(uptimeDays(up.getAttribute('data-since') || '', Date.now()));
  })();

  return function destroy() {
    offs.splice(0).forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
  };
}
