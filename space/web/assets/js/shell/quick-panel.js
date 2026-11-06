/**
 * @fileoverview 主站接上顶栏的快捷面板 #sgx-qp 和 AI 窗口 #sgx-ai（2026-11-04 P5-1）。
 * 开合、互斥、两页（导航 / 快捷设置）、磁贴点击都在共享外壳组件 shell/topbar-panel.js（四站同一份，子站经 gen-shell 同步成 topbar.js）；
 * 这里只把主站自己的东西传进去：
 * - 状态机 modal-sheet.js；外观 setter 是设置页同一套（lib/prefs.js，经 features.js 写同一个 localStorage key，面板和设置页互相即时同步）；
 * - 语言：切到另一种语言（显式 zh / en），关面板后 replace 到对应语言的同一页（lib/prefs.js setLang 算地址，不留历史）；
 * - 立即锁定：关面板后弹出与安全页相同的「立即锁定？」确认层（auth/lock-now.js）；
 * - 布局行（auto / mobile / dex；不够 DeX 时 DeX 置灰）；
 * - AI 窗口内容 shell/ai-panel.js（共享外壳 ai.js）。主站不设分享（定案第 4 条：模板层不输出分享磁贴）。
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
  layoutNarrow,
  setLayout,
  setLang,
} from '../lib/prefs.js';
import { accent } from '../lib/accent.js';
import { modalSheet } from './modal-sheet.js';
import { mountTopbar } from './topbar-panel.js';
import { mountAiChat } from './ai-panel.js';

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
      layoutPref,
      layoutNarrow,
      setLayout,
    },
    onLock: confirmLockNow,
    navigate: sgxNavigate,
    replace: sgxReplace,
    ai: mountAiChat,
    /* 设置页（或别的标签页）改了同一项：面板开着时即时重绘 */
    subscribe: function (repaint) {
      ['theme-mode', 'palette', 'layout'].forEach(function (id) {
        featOn(id, repaint);
      });
    },
  });
}
