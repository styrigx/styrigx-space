/**
 * 奇趣接上顶栏（2026-11-04 P5-1 全大椭圆，四站同一个；标记是共享外壳 partials/sgx-shell-topbar.html）。
 * 开合 / 互斥 / 导航面板 / 快捷设置 / 磁贴都在共享外壳 topbar.js（四站同一套，P4-3 PR-4b）；这里把依赖传进去：
 * - 状态机 modal-sheet.js；外观写端 prefs-write.js（写 localStorage + sgx-ui cookie，同源后主站同步生效，定案第 5 条）；
 * - 语言行（跟随系统 / 中文 / English）：写偏好，实际语言变了就去语言行的 data-href（另一种语言的同一页）；布局行写 sgx-layout；
 * - 终端里的 v6 身份层 = shell/identity/layer.js、账号层 = shell/account/cmd/layer.js、账号卡片 = shell/account/window.js（只展示）；
 * - AI 窗口内容 ai.js（v6 P4 起「分享本页」磁贴随分享短链删除）。
 * 取代原来的 topbar.js（导航抽屉）、share-host.js（右圆分享）。
 */
import { mountTopbar } from '../../../js/shell/topbar-panel.js';
import { modalSheet } from '../../../js/shell/modal-sheet.js';
import { mountAiChat } from '../../../js/shell/ai-panel.js';
import { mountAccountWindow, layerFromPath } from '../../../js/shell/account/window.js';
import { mountAccountLayer } from '../../../js/shell/account/cmd/layer.js';
import { mountIdentityLayer } from '../../../js/shell/identity/layer.js';
import { whoami as identityWhoami, hasMarker as identityMarker } from '../../../js/shell/identity/api.js';
import { KEY_SPACE_PASSWORD } from '../../../js/lib/key-names.js';
import { onKeyboardHeight } from '../../../js/shell/vk.js';
import * as prefs from '../../../js/lib/prefs-write.js';
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
    /* v6 身份层（同主站 quick-panel.js；全站一个终端，v5「终端合一」+ 定稿 §六：子站终端里 su / su root / sudo / exit / lock / whoami … 同样能用） */
    identityTerm: mountIdentityLayer,
    identityWhoami: identityWhoami,
    identityMarker: identityMarker,
    /* 密码输入行的隐藏用户名（密码管理器认它；v6 su / sudo 的 Password: 行用同一个） */
    pmUser: KEY_SPACE_PASSWORD,
    /* 全站终端（Ctrl / ⌘ K、NAVIGATE「$ terminal」；v5 S5 终端合一） */
    terminal,
    keyboard: onKeyboardHeight,
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
