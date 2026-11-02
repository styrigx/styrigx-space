// 标签页文章卡：点卡片空白处也打开文章。
(() => {
  if (window.__sgxArchivePostClick) return;
  window.__sgxArchivePostClick = true;
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a, button, input, select, textarea, summary, [data-no-card-click]')) {
      return;
    }
    const selection = window.getSelection?.();
    if (selection && selection.type === 'Range') return;
    const post = target.closest('[data-archive-post-href]');
    if (!(post instanceof HTMLElement)) return;
    const link = post.querySelector('.title-link');
    if (link instanceof HTMLElement) {
      link.click();
      return;
    }
    const href = post.dataset.archivePostHref;
    if (href) window.location.href = href;
  });
})();
