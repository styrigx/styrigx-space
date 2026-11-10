/**
 * 奇趣接上顶栏（2026-11-04 P5-1 全大椭圆，四站同一个；标记是共享外壳 partials/sgx-shell-topbar.html）。
 * 开合 / 互斥 / 导航面板 / 快捷设置 / 磁贴都在共享外壳 topbar.js（四站同一套，P4-3 PR-4b）；这里把依赖传进去：
 * - 状态机 modal-sheet.js；外观写端 prefs-write.js（写 localStorage + sgx-ui cookie，同源后主站同步生效，定案第 5 条）；
 * - 语言行（跟随系统 / 中文 / English）：写偏好，实际语言变了就去语言行的 data-href（另一种语言的同一页）；布局行写 sgx-layout；
 * - 立即锁屏：不传 onLock，topbar-panel.js 自带（只锁本机、不验证）POST /api/lock-now 后重新取这一页；终端里的钥匙层 = shell/space/layer.js、账号层 = shell/account/cmd/layer.js、账号窗口 = shell/account/window.js（照旧）（v5 S5）；
 * - AI 窗口内容 ai.js；「分享本页」磁贴 share.js（带临时会话的短链，只要进站会话，不验证）。
 * 取代原来的 topbar.js（导航抽屉）、share-host.js（右圆分享）。
 */
import { mountTopbar } from '../../../js/shell/topbar-panel.js';
import { modalSheet } from '../../../js/shell/modal-sheet.js';
import { mountAiChat } from '../../../js/shell/ai-panel.js';
import { mountAccountWindow, layerFromPath } from '../../../js/shell/account/window.js';
import { mountAccountLayer } from '../../../js/shell/account/cmd/layer.js';
import { mountSpace } from '../../../js/shell/space/layer.js';
import { PM_USER } from '../../../js/shell/space/api.js';
import { onKeyboardHeight } from '../../../js/shell/vk.js';
import * as prefs from '../../../js/lib/prefs-write.js';
import { mountShare } from '../../../js/shell/share-button.js';
import * as terminal from '../../../js/shell/terminal.js';

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
      langPref: prefs.langPref,
      layoutPref: prefs.layoutPref,
      setLayout: prefs.setLayout,
    },
    ai: mountAiChat,
    account: mountAccountWindow,
    accountTerm: mountAccountLayer,
    accountLayer: layerFromPath,
    space: mountSpace,
    pmUser: PM_USER.password,
    share: mountShare,
    /* 全站终端（Ctrl / ⌘ K、NAVIGATE「$ terminal」；v5 S5 终端合一） */
    terminal,
    keyboard: onKeyboardHeight,
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
