/**
 * @fileoverview 旷野页（/）上方的小组件：日刻今日一句（P4-2c：双时钟、天气小组件删除）。
 * mountHome() 由 entries/entry-space.js 在加载时调一次（P4-3 PR-4b 起没有页内切换）；activate / deactivate 保留，现在没有要停的东西。
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
