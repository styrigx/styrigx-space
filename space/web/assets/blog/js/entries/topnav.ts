// 顶栏（2026-11-04 P5-1 全大椭圆，四站同一个，标记 partials/sgx-shell-topbar.html）：快捷面板（导航 / 快捷设置，含「分享本页」）+ AI 窗口 + 文章页阅读进度细线。
// 开合 / 互斥 / 两页 / 磁贴都在共享外壳 topbar.js；这里把状态机、外观写端、AI 内容、分享传进去。整页跳转，末尾的 initTopbar() 直接初始化。
import { mountTopbar } from '../../../js/shell/topbar-panel.js';
import { modalSheet } from '../../../js/shell/modal-sheet.js';
import { mountAiChat } from '../../../js/shell/ai-panel.js';
import { onKeyboardHeight } from '../../../js/shell/vk.js';
import * as prefs from '../../../js/lib/prefs-write.js';
import { mountShare } from '../../../js/shell/share-button.js';
import * as terminal from '../../../js/shell/terminal.js';

/** 文章阅读进度：#article-start（正文）从顶栏下沿开始读，到正文底部离开视口底部为 100%；画在长条底边。 */
let ticking = false;
function updateProgress() {
  ticking = false;
  const bar = document.querySelector<HTMLElement>('[data-sgx-progress]');
  const body =
    document.querySelector<HTMLElement>('#article-start') || document.querySelector('main');
  if (!bar || !body) return;
  const r = body.getBoundingClientRect();
  const start = window.scrollY + r.top - 80;
  const end = window.scrollY + r.bottom - window.innerHeight;
  const span = Math.max(1, end - start);
  const p = Math.min(1, Math.max(0, (window.scrollY - start) / span));
  bar.style.setProperty('--p', p.toFixed(4));
  bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
}
function onScroll() {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(updateProgress);
  }
}

function initTopbar() {
  const r = document.querySelector<HTMLElement>('[data-sgx-topbar-root]');
  if (!r || r.dataset.sgxReady === 'true') return;
  r.dataset.sgxReady = 'true';

  /* 快捷面板 + AI 窗口（共享外壳 topbar.js）：外观写端 prefs-write.js（写 localStorage + sgx-ui cookie，同源后主站同步生效）；
     语言行写偏好，实际语言变了就去 data-href（另一种语言的同一页）；布局行写 sgx-layout（四站同一套快捷面板，PR-4b）；分享磁贴交给 share.js（带临时会话的短链，只要进站会话、不验证） */
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
      setLang: (v: 'system' | 'zh' | 'en') => {
        prefs.setLangPref(v);
        return '';
      },
      langPref: prefs.langPref,
      layoutPref: prefs.layoutPref,
      setLayout: prefs.setLayout,
    },
    ai: mountAiChat,
    share: mountShare,
    /* 全站终端（Ctrl / ⌘ K、NAVIGATE「$ terminal」；2026-11 PR-2） */
    terminal,
    keyboard: onKeyboardHeight,
  });

  updateProgress();
}

const w = window as unknown as { __sgxTopbarGlobal?: boolean };
if (!w.__sgxTopbarGlobal) {
  w.__sgxTopbarGlobal = true;
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('pageshow', onScroll);
}
initTopbar();
