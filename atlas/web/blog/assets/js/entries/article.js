// 文章页：分享按钮、代码块复制。（评论 2026-10-22 撤了）
// 分享 / 评论的配置从页面上的 data-* 读。

/* ---------- 分享 ---------- */
(() => {
  if (window.__styrigxShareButtons) return;
  window.__styrigxShareButtons = true;
  const root = document.querySelector('[data-share-root]');
  const title = root?.getAttribute('data-share-title') || document.title;
  const url = root?.getAttribute('data-share-url') || location.href;
  if (typeof navigator.share === 'function') {
    document.querySelectorAll('[data-share-native]').forEach((btn) => btn.removeAttribute('hidden'));
  }
  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const copyBtn = target.closest('[data-share-copy]');
    if (copyBtn) {
      const link = copyBtn.getAttribute('data-share-copy') || '';
      const label = copyBtn.querySelector('span');
      const original = label ? label.textContent : '';
      await copyText(link);
      if (label) {
        label.textContent = copyBtn.getAttribute('data-copied-label') || 'Copied';
        setTimeout(() => {
          label.textContent = original;
        }, 1600);
      }
      return;
    }
    const nativeBtn = target.closest('[data-share-native]');
    if (nativeBtn && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
      } catch {}
    }
  });
})();

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* ---------- 代码块复制（render-codeblock.html 的 .code-copy）：只复制代码，不带行号 ---------- */
document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest('[data-code-copy]');
  if (!btn) return;
  const block = btn.closest('.code-block');
  const lines = block ? [...block.querySelectorAll('.cl')] : [];
  const text = lines.length
    ? lines.map((l) => l.textContent || '').join('').replace(/\n$/, '')
    : block?.querySelector('code')?.textContent || '';
  await copyText(text);
  const label = btn.querySelector('[data-code-copy-label]');
  btn.setAttribute('data-copied', 'true');
  const original = label ? label.textContent : '';
  if (label) label.textContent = btn.getAttribute('data-copied-label') || 'Copied';
  clearTimeout(btn.__t);
  btn.__t = setTimeout(() => {
    btn.removeAttribute('data-copied');
    if (label) label.textContent = original;
  }, 1600);
});
