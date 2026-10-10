/**
 * @fileoverview 统一语音搜索按钮组件（替代旧 window.__sgxVoice）。
 * 点击麦克风按钮进行语音识别，结果填入输入框并回调。
 */
import { on } from '../lib/events.js';
import { loadI18n } from '../lib/i18n.js';
import { toast } from '../lib/toast.js';

/**
 * @typedef {Object} VoiceOpts
 * @property {HTMLElement|(() => HTMLElement|null)} [input] 输入框元素或返回元素的函数
 * @property {() => void} [beforeStart]
 * @property {(txt: string) => void} [onResult]
 */

/**
 * 绑定语音输入按钮。不支持 SpeechRecognition 时隐藏按钮。
 * @param {HTMLElement|null} btn 麦克风按钮
 * @param {VoiceOpts} [opts]
 */
export function voiceInput(btn, opts) {
  opts = opts || {};
  if (!btn) return;
  const SR =
    /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
  if (!SR) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const T = loadI18n('sgx-i18n-core');
  const en = document.documentElement.lang === 'en';
  /** @type {any} */
  let rec = null;
  let listening = false;
  /** @type {number|null} */
  let stopTimer = null;

  /** @returns {HTMLElement|null} */
  function inputEl() {
    const i = opts.input;
    return typeof i === 'function' ? i() : i || null;
  }
  /** @param {boolean} on_ */
  function setUI(on_) {
    listening = on_;
    btn.classList.toggle('sgx-mic-on', on_);
    if (on_) btn.setAttribute('aria-pressed', 'true');
    else btn.removeAttribute('aria-pressed');
    const ip = inputEl();
    if (ip) {
      if (on_) {
        if (ip.getAttribute('data-sgx-ph') === null)
          ip.setAttribute('data-sgx-ph', ip.getAttribute('placeholder') || '');
        ip.setAttribute('placeholder', T.t('listening'));
      } else {
        const p = ip.getAttribute('data-sgx-ph');
        if (p !== null) ip.setAttribute('placeholder', p);
      }
    }
  }
  function stop() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    try {
      if (rec) rec.stop();
    } catch (e) {}
    rec = null;
    if (listening) setUI(false);
  }
  /** @param {Event} [e] */
  function toggle(e) {
    if (e) {
      e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
    }
    if (listening) {
      stop();
      return;
    }
    if (opts.beforeStart) {
      try {
        opts.beforeStart();
      } catch (err) {}
    }
    try {
      rec = new SR();
      rec.lang = en ? 'en-US' : 'zh-CN';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = function (/** @type {any} */ ev) {
        let txt = '';
        try {
          txt = String((ev.results[0][0].transcript || '')).trim();
        } catch (err) {}
        stop();
        if (txt) {
          const ip = /** @type {HTMLInputElement|null} */ (inputEl());
          if (ip) ip.value = txt;
          if (opts.onResult) {
            try {
              opts.onResult(txt);
            } catch (err) {}
          }
        } else {
          toast(T.t('noSpeech'));
        }
      };
      rec.onerror = function (/** @type {any} */ ev) {
        const c = (ev && ev.error) || '';
        stop();
        if (c === 'not-allowed') {
          toast(T.t('noPerm'));
        } else if (c === 'network' || c === 'service-not-allowed') {
          toast(T.t('noSr'));
        } else if (c === 'no-speech') {
          toast(T.t('noSpeech'));
        }
      };
      rec.onend = function () {
        if (listening) {
          rec = null;
          setUI(false);
        }
      };
      setUI(true);
      rec.start();
      stopTimer = window.setTimeout(stop, 8000);
    } catch (err) {
      stop();
    }
  }
  on(btn, 'click', toggle);
  if (btn.tagName !== 'BUTTON') {
    on(btn, 'keydown', function (/** @type {KeyboardEvent} */ e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(e);
      }
    });
  }
}
