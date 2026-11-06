/**
 * @fileoverview 首页：日刻今日一句（P4-2c：双时钟、天气小组件删除）。
 * 2026-10-24 页内切换（shell/inpage-tabs.js）：不再在 import 时直接跑，改成 mountHome()——
 * 首页这块 DOM 只挂一次（切走时连 DOM 一起留着，回来不重画）；activate / deactivate 留着给页内切换调，现在没有要停的东西。
 */
import { mountDaymarkToday } from '../lib/daymark-today.js';

/**
 * 挂首页（每块首页 DOM 只调一次）。返回 activate / deactivate（页内切换进出时调）；不在首页（没有 #home-widgets）返回 null。
 * @param {{direct?: boolean}} [o] direct：这一栏就是直接打开 / 刷新的那页（照旧回到顶部）
 * @returns {{activate: () => void, deactivate: () => void}|null}
 */
export function mountHome(o) {
  if (!document.getElementById('home-widgets')) return null;
  /* 首页刷新回到顶部（只管直接打开 / 刷新；页内切回来按记住的位置） */
  if (o && o.direct) {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);
  }
  /* 日刻 · 今日一句：/daymark/api/today（公开只读，同源）。与锁屏共用 lib/daymark-today.js：
     先画本地缓存（同一天才用），再静默拉新；拉失败且没缓存 → 卡片保持隐藏。只在挂上时拉一次。 */
  const dm = document.getElementById('w-daymark');
  if (dm) mountDaymarkToday(dm, { en: document.documentElement.lang === 'en' });
  return {
    activate() {},
    deactivate() {},
  };
}
