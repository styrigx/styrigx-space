// 博客 e2e 共用：写主站外观 cookie sgx-ui（base64url(JSON)，同 space/web/assets/common/js/prefs/ui-cookie-read.js 的 encode）。
// sgx-inherit.spec.js 断言继承，blog-visual.spec.js 固定截图调色板，两边同一份编码。

export const enc = (o) =>
  Buffer.from(JSON.stringify(o))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** 在 baseURL 的主机名、path '/' 写入 sgx-ui cookie（goto 之前调用，首帧就能读到） */
export async function setUi(context, baseURL, ui) {
  const u = new URL(baseURL);
  await context.addCookies([{ name: 'sgx-ui', value: enc(ui), domain: u.hostname, path: '/' }]);
}
