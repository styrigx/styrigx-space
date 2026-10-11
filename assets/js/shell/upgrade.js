/**
 * 2.9.3：访客升级验证层。
 * 当访客访问主人专属路径时，首页返回 200 并带 data-sgx-upgrade="1"，
 * 本模块打开验证层：只显示通行密钥+密码，不显示访客入口，带「需要主人验证」提示。
 * 验证通过后跳回 data-sgx-upgrade-return。失败/取消留在原页，不跳转。
 */
export function initUpgrade() {
  const html = document.documentElement;
  if (html.getAttribute('data-sgx-upgrade') !== '1') return;
  const returnPath = html.getAttribute('data-sgx-upgrade-return') || '/';
  const isEn = html.lang === 'en';

  // 创建遮罩和对话框
  const overlay = document.createElement('div');
  overlay.id = 'sgx-upgrade-overlay';
  overlay.innerHTML =
    '<div class="sgx-upgrade-sheet" role="dialog" aria-modal="true" aria-label="' + (isEn ? 'Owner verification' : '主人验证') + '">' +
    '<div class="sgx-upgrade-title">' + (isEn ? 'Owner verification required' : '需要主人验证') + '</div>' +
    '<div class="sgx-upgrade-desc">' + (isEn ? 'This page requires owner verification.' : '此页面需要主人验证后才能进入。') + '</div>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pk">' + (isEn ? 'Verify with passkey' : '通行密钥验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-btn" id="sgx-upgrade-pw">' + (isEn ? 'Verify with password' : '密码验证') + '</button>' +
    '<button type="button" class="sgx-upgrade-cancel" id="sgx-upgrade-cancel">' + (isEn ? 'Cancel' : '取消') + '</button>' +
    '</div>';
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  document.getElementById('sgx-upgrade-cancel').addEventListener('click', close);

  // 通行密钥验证
  document.getElementById('sgx-upgrade-pk').addEventListener('click', async () => {
    try {
      // 复用现有的通行密钥验证流程
      const { verifyPasskey } = await import('./passkey.js').catch(() => ({}));
      if (verifyPasskey) {
        const ok = await verifyPasskey();
        if (ok) { location.href = returnPath; }
      } else {
        // 回退：触发锁屏的通行密钥流程
        document.dispatchEvent(new CustomEvent('sgx:upgrade-passkey', { detail: { returnPath } }));
      }
    } catch (e) { /* 留在原页 */ }
  });

  // 密码验证
  document.getElementById('sgx-upgrade-pw').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('sgx:upgrade-password', { detail: { returnPath } }));
  });
}
