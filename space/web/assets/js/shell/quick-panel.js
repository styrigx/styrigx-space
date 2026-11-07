/**
 * @fileoverview 主站接上顶栏的导航面板 #sgx-nav、快捷面板 #sgx-qp 和 AI 窗口 #sgx-ai（2026-11-04 P5-1；P4-3 PR-4b 九宫格回来、快捷面板四站同一套）。
 * 开合、互斥、磁贴点击都在共享外壳组件 shell/topbar-panel.js（四站同一份，子站经 gen-shell 同步成 topbar.js）；
 * 这里只把主站自己的东西传进去：
 * - 状态机 modal-sheet.js；外观 setter 是设置页同一套（lib/prefs.js，经 features.js 写同一个 localStorage key，面板和设置页互相即时同步）；
 * - 语言行（跟随系统 / 中文 / English）：lib/prefs.js setLang 写偏好、算目标语言的同一页地址，和本页不同就关面板后 replace 过去（不留历史）；
 * - 立即锁定：关面板后弹出与安全页相同的「立即锁定？」确认层（auth/lock-now.js）；
 * - 布局行（手机 / 自动 / 桌面，P4-3 PR-4b；模式规则见 lib/layout-mode.js）；
 * - 分享本页 shell/share-button.js（共享外壳 share.js；PR-4b 起主站也有，四站快捷面板同一套）；
 * - AI 窗口内容 shell/ai-panel.js（共享外壳 ai.js），键盘高度订阅 shell/vk.js（共享外壳 vk.js，P4-3 PR-3）。
 */
import { on as featOn } from '../lib/features.js';
import { sgxNavigate, sgxReplace } from '../lib/diag-jumptrace.js';
import { confirmLockNow } from '../auth/lock-now.js';
import {
  themeMode,
  isDark,
  setTheme,
  toggleFollowSystem,
  palette,
  setPalette,
  DEFAULT_PALETTE,
  layoutPref,
  setLayout,
  setLang,
} from '../lib/prefs.js';
import { accent } from '../lib/accent.js';
import { modalSheet } from './modal-sheet.js';
import { mountTopbar } from './topbar-panel.js';
import { mountAiChat } from './ai-panel.js';
import { onKeyboardHeight } from './vk.js';
import { mountShare } from './share-button.js';

/** 语言偏好（sgx-lang：zh / en，没存 = 跟随系统） @returns {'system'|'zh'|'en'} */
function langPref() {
  let v = null;
  try { v = localStorage.getItem('sgx-lang'); } catch (e) {}
  return v === 'zh' || v === 'en' ? v : 'system';
}

export function initQuickPanel() {
  mountTopbar({
    modalSheet,
    prefs: {
      isDark,
      themeMode,
      setTheme,
      toggleFollowSystem,
      palette,
      setPalette,
      DEFAULT_PALETTE,
      hasAccent: function () { return !!accent(); },
      setLang: function (v) { return setLang(v); },
      langPref,
      layoutPref,
      setLayout,
    },
    onLock: confirmLockNow,
    navigate: sgxNavigate,
    replace: sgxReplace,
    ai: mountAiChat,
    share: mountShare,
    keyboard: onKeyboardHeight,
    /* 设置页（或别的标签页）改了同一项：面板开着时即时重绘 */
    subscribe: function (repaint) {
      ['theme-mode', 'palette', 'layout', 'lang'].forEach(function (id) {
        featOn(id, repaint);
      });
    },
  });
}
