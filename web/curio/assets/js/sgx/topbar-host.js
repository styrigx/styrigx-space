/**
 * 奇趣接上顶栏（2026-11-04 P5-1 全大椭圆，四站同一个；标记是共享外壳 partials/sgx-shell-topbar.html）。
 * 开合 / 互斥 / 两页（导航 / 快捷设置）/ 磁贴都在共享外壳 topbar.js；这里把依赖传进去：
 * - 状态机 modal-sheet.js；外观写端 prefs-write.js（写 localStorage + sgx-ui cookie，同源后主站同步生效，定案第 5 条）；
 * - 语言磁贴：写偏好后去磁贴的 data-href（另一种语言的同一页）；
 * - AI 窗口内容 ai.js；「分享本页」磁贴 share.js（带临时会话的短链，生成前要锁侧复验，share.js 自带最小复验步骤）。
 * 取代原来的 topbar.js（导航抽屉）、share-host.js（右圆分享）。
 */
import { mountTopbar } from './shell/topbar.js';
import { modalSheet } from './shell/modal-sheet.js';
import { mountAiChat } from './shell/ai.js';
import * as prefs from './shell/prefs-write.js';
import { mountShare } from './shell/share.js';

function boot() {
  mountTopbar({
    modalSheet,
    prefs: {
      isDark: prefs.isDark,
      themeMode: prefs.themeMode,
      setTheme: prefs.setThemeMode,
      toggleFollowSystem: prefs.toggleFollowSystem,
      palette: prefs.palette,
      setPalette: prefs.setPalette,
      DEFAULT_PALETTE: prefs.DEFAULT_PALETTE,
      hasAccent: prefs.hasAccent,
      setLang: function (v) {
        prefs.setLangPref(v);
        return '';
      },
    },
    ai: mountAiChat,
    share: mountShare,
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
