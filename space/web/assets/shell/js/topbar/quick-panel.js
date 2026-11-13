/**
 * @fileoverview 主站接上顶栏的导航面板 #sgx-nav、快捷面板 #sgx-qp 和 AI 窗口 #sgx-ai（2026-11-04 P5-1；P4-3 PR-4b 九宫格回来、快捷面板四站同一套）。
 * 开合、互斥、磁贴点击都在共享外壳组件 topbar/topbar-panel.js（四站同一份，子站经 gen-shell 同步成 topbar.js）；
 * 这里只把主站自己的东西传进去：
 * - 状态机 modal-sheet.js；外观 setter 是设置页同一套（prefs/prefs.js，经 features.js 写同一个 localStorage key，面板和设置页互相即时同步）；
 * - 语言行（跟随系统 / 中文 / English）：prefs/prefs.js setLang 写偏好、算目标语言的同一页地址，和本页不同就关面板后 replace 过去（不留历史）；
 * - 终端里的 v6 身份层 identity/layer.js、账号层 account/cmd/layer.js、账号卡片 account/window.js（S9 起只展示）（v5 S5 终端合一）；
 * - 布局行（手机 / 自动 / 桌面，P4-3 PR-4b；模式规则见 ui/layout-mode.js）；
 * - AI 窗口内容 ai/ai-panel.js（共享外壳 ai.js），键盘高度订阅 ui/vk.js（共享外壳 vk.js，P4-3 PR-3）。
 */
import { on as featOn } from '../features/features.js';
import { sgxNavigate, sgxReplace } from '../status/diag-jumptrace.js';
import {
  isDark,
  palette,
  setPalette,
  DEFAULT_PALETTE,
  layoutPref,
  setLayout,
  setLang,
} from '../prefs/prefs.js';
import { isLang } from '../i18n/lang-path.js';
import { modalSheet } from '../ui/modal-sheet.js';
import { mountTopbar } from './topbar-panel.js';
import { mountAiChat } from '../ai/ai-panel.js';
import { mountAccountWindow, layerFromPath } from '../account/window.js';
import { mountAccountLayer } from '../account/cmd/layer.js';
import { mountIdentityLayer } from '../identity/layer.js';
import { whoami as identityWhoami, hasMarker as identityMarker } from '../identity/api.js';
import { KEY_SPACE_PASSWORD } from '../core/key-names.js';
import { onKeyboardHeight } from '../ui/vk.js';
import * as terminal from '../term/terminal.js';

/** 语言偏好（sgx-lang：配置里的语言；'system' / 旧版没存 = 跟随系统） @returns {string} */
function langPref() {
  let v = null;
  try { v = localStorage.getItem('sgx-lang'); } catch (e) {}
  return isLang(v) ? /** @type {string} */ (v) : 'system';
}

export function initQuickPanel() {
  mountTopbar({
    modalSheet,
    prefs: {
      isDark,
      palette,
      setPalette,
      DEFAULT_PALETTE,
      setLang: function (v) { return setLang(v); },
      langPref,
      layoutPref,
      setLayout,
    },
    navigate: sgxNavigate,
    replace: sgxReplace,
    ai: mountAiChat,
    /* 账号窗口（头像）+ 终端里的账号层（v5 S5） */
    account: mountAccountWindow,
    accountTerm: mountAccountLayer,
    accountLayer: layerFromPath,
    /* v6 身份层（P2b）：su / sudo / exit / lock / whoami / groups / who / useradd / userdel / usermod / passwd */
    identityTerm: mountIdentityLayer,
    identityWhoami: identityWhoami,
    identityMarker: identityMarker,
    /* 密码输入行的隐藏用户名（密码管理器认它；v6 su / sudo 的 Password: 行用同一个） */
    pmUser: KEY_SPACE_PASSWORD,
    /* 全站终端（Ctrl / ⌘ K、NAVIGATE「$ terminal」；v5 S5 终端合一） */
    terminal,
    keyboard: onKeyboardHeight,
    /* 设置页（或别的标签页）改了同一项：面板开着时即时重绘 */
    subscribe: function (repaint) {
      ['palette', 'layout', 'lang'].forEach(function (id) {
        featOn(id, repaint);
      });
    },
  });
}
