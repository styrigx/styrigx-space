/**
 * @fileoverview 进站：终端里 sudo styrigx 验过之后（v5 S5，Gray 16:05「通过后终端自动收起 → 播原进站解锁动画 → 回到刚才的页面；动画保留不改」）。
 *
 * 先向服务端确认会话真的生效（GET /api/lock-session-check，guard.js askServer），再：终端收起 → 开机动画（原锁屏解锁后的那一段：
 * 逐行打印，任意键 / 点击跳过；减少动态效果时不放）→ guard.js proceed（服务端给的 next / 访客态页面重新取一次 / 原地）。
 * 没确认到 → 停在终端报错，绝不跳转。动画的 DOM / 类名沿用原锁屏（#sgx-entry、.sgx-entry-boot*），样式不变。
 */
import { reducedMotion, esc } from '../../lib/util.js';
import { ADMIN_COMMAND } from './commands.js';

/**
 * 开机动画，放完（或被跳过）调 then；减少动态效果时直接 then。
 * @param {{by?: string, exp?: number}} ans 服务端回答 @param {string} via 这次怎么进的（password / passkey） @param {string} user 名字（个人资料姓名第一个词）
 * @param {() => void} then
 * @returns {{ done: () => void }} done：动画层淡出收掉（原地开锁时）
 */
export function bootSequence(ans, via, user, then) {
  const doc = document;
  const ov = doc.createElement('div');
  ov.id = 'sgx-entry';
  ov.className = 'sgx-entry-anim';
  ov.setAttribute('aria-hidden', 'true');
  const cleanup = function () {
    if (ov.parentNode) ov.parentNode.removeChild(ov);
    doc.body.classList.remove('sgx-entry');
  };
  const done = function () {
    doc.body.classList.remove('sgx-entry');
    if (reducedMotion()) { cleanup(); return; }
    ov.classList.add('sgx-entry-booted');
    window.setTimeout(cleanup, 520);
  };
  if (reducedMotion()) { then(); return { done: cleanup }; }
  const by = String(ans.by || via || '');
  let sess = '';
  const left = Number(ans.exp || 0) - Date.now();
  if (left > 0 && left < 31 * 864e5) sess = left >= 36e5 ? Math.round(left / 36e5) + 'h' : Math.max(1, Math.ceil(left / 6e4)) + 'm';
  const ver = (by ? by + ' verified' : 'verified') + (sess ? ' · session ' + sess : '');
  const OK = ' <span class="sgx-entry-bok">ok</span>';
  const lines = [
    '<span class="sgx-entry-bh">&gt; styrigx space os — ' + esc(ADMIN_COMMAND) + '@space</span>',
    '<span class="sgx-entry-bok">&gt; ' + esc(ver) + '</span>',
    '&gt; mounting /space/blog ...' + OK,
    '&gt; mounting /space/curio ...' + OK,
    '&gt; mounting /space/daymark ...' + OK,
    '&gt; mounting /space/wild ...' + OK,
    '&gt; loading gray-ai ...' + OK,
    '&gt; welcome back, ' + esc(user) + '_',
  ];
  const el = doc.createElement('div');
  el.id = 'sgx-entry-boot';
  el.className = 'sgx-entry-boot';
  el.innerHTML = '<div class="sgx-entry-bout"><span class="sgx-entry-cur"></span></div>';
  ov.appendChild(el);
  doc.body.appendChild(ov);
  const outEl = /** @type {HTMLElement} */ (el.firstChild);
  try { if (doc.activeElement && doc.activeElement !== doc.body) /** @type {HTMLElement} */ (doc.activeElement).blur(); } catch (e) {}
  requestAnimationFrame(function () { el.classList.add('is-on'); doc.body.classList.add('sgx-entry'); });
  let n = 0;
  let timer = 0;
  let finished = false;
  /** @param {number} k */
  function render(k) {
    outEl.innerHTML = lines.slice(0, k).map(function (l) { return '<div>' + l + '</div>'; }).join('') + '<span class="sgx-entry-cur"></span>';
    el.setAttribute('data-lines', String(k));
  }
  function finish() {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    doc.removeEventListener('keydown', skip, true);
    doc.removeEventListener('pointerdown', skip, true);
    then();
  }
  /** @param {Event} e */
  function skip(e) {
    if (finished) return;
    try { e.preventDefault(); e.stopPropagation(); } catch (x) {}
    window.clearTimeout(timer);
    render(lines.length);
    finish();
  }
  doc.addEventListener('keydown', skip, true);
  doc.addEventListener('pointerdown', skip, true);
  function step() {
    render(++n);
    timer = window.setTimeout(n < lines.length ? step : finish, n < lines.length ? 190 : 520);
  }
  timer = window.setTimeout(step, 260);
  return { done: done };
}
