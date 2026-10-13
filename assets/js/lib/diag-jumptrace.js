/**
 * @fileoverview 诊断：版本标记显示 + 跳转追踪（#1 诊断专用，临时）。
 *
 * - 页面加载时把 <html data-sgx-build> 的值填进 [data-sgx-build-tag]。
 * - sgxTraceJump(caller)：在跳转到 /settings/security/ 前记录：
 *   触发点、来源路径、data-sgx-* 状态、时间戳，存 sessionStorage。
 * - 安全与隐私页加载时若有记录，在页面顶部显示一次后清掉。
 *
 * 不改任何认证逻辑；不记录密钥、Cookie 值。
 */

const TRACE_KEY = 'sgx-jump-trace';

function readSgxState() {
  const el = document.documentElement;
  const d = el ? el.dataset : {};
  return {
    session: d.sgxSession || '',
    role: d.sgxRole || '',
    upgrade: d.sgxUpgrade || '',
    build: d.sgxBuild || '',
  };
}

/**
 * 在跳转到安全与隐私页之前调用，记录触发点。
 * @param {string} caller 触发点，如 'lock.js:1102'
 */
export function sgxTraceJump(caller) {
  try {
    const st = readSgxState();
    const rec = {
      caller,
      from: location.pathname + location.search,
      session: st.session,
      role: st.role,
      upgrade: st.upgrade,
      build: st.build,
      t: new Date().toISOString(),
    };
    sessionStorage.setItem(TRACE_KEY, JSON.stringify(rec));
  } catch (e) {}
}

/**
 * 安全页专用：记录根凭证成功后的跳转意图。
 * @param {string} dest 目标 URL
 */
export function sgxTraceRootOk(dest) {
  try {
    const st = readSgxState();
    const rec = {
      caller: 'security.js:root-ok',
      from: location.pathname + location.search,
      note: 'root ok → 跳 ' + dest,
      session: st.session,
      role: st.role,
      upgrade: st.upgrade,
      build: st.build,
      t: new Date().toISOString(),
    };
    sessionStorage.setItem(TRACE_KEY, JSON.stringify(rec));
  } catch (e) {}
}

/** 把构建 SHA 填进页面上的 [data-sgx-build-tag]。 */
export function sgxShowBuildTag() {
  try {
    const build = readSgxState().build;
    if (!build) return;
    const els = document.querySelectorAll('[data-sgx-build-tag]');
    els.forEach(function (el) {
      el.textContent = 'build ' + build;
    });
  } catch (e) {}
}

/**
 * 安全与隐私页加载时调用：若有跳转追踪记录，在页面顶部显示一次后清掉。
 */
export function sgxShowJumpTrace() {
  let rec = null;
  try {
    const raw = sessionStorage.getItem(TRACE_KEY);
    if (!raw) return;
    rec = JSON.parse(raw);
    sessionStorage.removeItem(TRACE_KEY);
  } catch (e) {
    return;
  }
  if (!rec || !rec.caller) return;
  try {
    const bar = document.createElement('div');
    bar.id = 'sgx-jump-trace';
    bar.style.cssText =
      'margin:12px 16px;padding:12px 14px;border-radius:12px;' +
      'background:#fff3cd;color:#664d03;font-size:13px;line-height:1.6;' +
      'border:1px solid #ffecb5;word-break:break-all;';
    const lines = [
      '跳转追踪（诊断）：',
      '触发点：' + rec.caller,
      '来源：' + rec.from,
      'session=' + rec.session + ' role=' + rec.role + ' upgrade=' + rec.upgrade,
      'build=' + rec.build,
      '时间：' + rec.t,
    ];
    if (rec.note) lines.splice(2, 0, rec.note);
    bar.textContent = lines.join('\n');
    bar.style.whiteSpace = 'pre-line';
    const main = document.querySelector('.set-layout') || document.body;
    main.insertBefore(bar, main.firstChild);
  } catch (e) {}
}
