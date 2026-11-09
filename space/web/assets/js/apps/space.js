/**
 * @fileoverview 旷野页（/wild/）screen-time 窗的本机记录（+ 自定义主题色同步）。
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
import { wellLoad, wellFlush } from '../shell/goodlock.js';
import { renderWbTerm } from '../lib/wb-view.js';
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

  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  /* 自定义主题色（sgx-accent）：缓存缺失 / 过期时按种子重算整套角色（lib/palette-scheme.js）。
     风格页 /theme/ 的调色板网格 2026-11 对齐 PR-C 退役（功能在顶栏外观弹层，共享外壳 quick-panel.js），这里只剩这一步。 */
  syncAccent();

  /* ---- 旷野 › about 窗 neofetch 的 Uptime（自 2026-10-07，Gray 2026-11-09）：构建时写过一份，这里按今天重算（页面可能是几天前构建的） ---- */
  (function () {
    const up = document.querySelector('[data-about="uptime"][data-since]');
    if (up) up.textContent = uptimeText(uptimeDays(up.getAttribute('data-since') || '', Date.now()));
  })();

  /* ---- 旷野 › screen-time 窗（/wild/ #wb-card，2026-11 对齐 PR-B；原 /wellbeing/ 页的屏幕时间卡）：先画本机记录（sgx-well-v）；
     core 的 loadWb() 拉到 /api/wellbeing 且 detail:true（账号已登录，P2-2）时覆盖同一组 [data-wb] 槽位并把范围改成「所有设备」；
     detail:false 就保持本机记录（卡上的 data-wb-detail，lib/wb-view.js wbFits）。不看锁屏进门方式。
     15 分钟提醒开关按 Gray 04:01「数字健康不做设置，做成展示页」删除。 */
  (function () {
    const card = $('wb-card');
    if (!card) return;
    let v = wellLoad();
    try {
      v = wellFlush();
    } catch (e) {}
    const ar = v.areas || {};
    /* 读旧写新（P4-3 PR-4b）：旧区域键 'home'（主页）、'settings'（设置）和更早的 'goodlock'（原 Good Lock 页）并进旷野 'space'；
       搜索页的区域键是 'browser'（更早是 'links'） */
    const space = (ar.space || 0) + (ar.home || 0) + (ar.settings || 0) + (ar.goodlock || 0);
    const browser = (ar.browser || 0) + (ar.links || 0);
    const total = Math.max(0, v.min || 0);
    const scopeEl = card.querySelector('[data-wb="scope"]');
    renderWbTerm(card, {
      total: total * 60,
      sections: [{ k: 'space', sec: space * 60 }, { k: 'browser', sec: browser * 60 }],
      items: [],
    }, { scope: scopeEl ? scopeEl.textContent || '' : '' });
  })();

  return function destroy() {
    offs.splice(0).forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
  };
}
