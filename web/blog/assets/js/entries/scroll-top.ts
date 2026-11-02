// 回到顶部按钮：页面滚过一屏（标记点 .scroll-top-marker 离开视口上方）才出现，点了平滑回顶（减弱动效时直接跳）。
const initScrollToTopButton = () => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-scroll-top-button]')) {
    if (button.dataset.scrollTopReady === 'true') {
      continue;
    }

    button.dataset.scrollTopReady = 'true';
    const marker = button.previousElementSibling;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const setVisible = (visible: boolean) => {
      button.dataset.visible = visible ? 'true' : 'false';
      button.setAttribute('aria-hidden', String(!visible));
      button.tabIndex = visible ? 0 : -1;
    };

    setVisible(false);

    if (marker) {
      const observer = new IntersectionObserver(([entry]) => {
        setVisible(entry.boundingClientRect.top < 0 && !entry.isIntersecting);
      });

      observer.observe(marker);
    }

    button.addEventListener('click', () => {
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion.matches ? 'auto' : 'smooth',
      });
    });
  }
};

initScrollToTopButton();
