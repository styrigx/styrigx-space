/* CSS 构建脚本，分两步：
   1. Tailwind CLI 单独构建 tw-input.css → 临时文件；
   2. 把整份 Tailwind 产物包进 @layer tw { }，再拼接自定义分层 CSS（input.css）。
   两步构建最初是因为 Tailwind 3 会把 @layer 里的 @media 变体提升到层外（优先级高于所有层）；
   现在是 Tailwind 4（产物自带 theme / base / components / utilities 层，包进 tw 后成为其子层），
   是否还必须两步没有重新验证，先保持不变。
   合站（2026-11）起顺带构建三个子站的样式（同一个 Hugo 站要全部样式才能构建），各自一份、互不扫描：
     博客  node space/scripts/blog/build-css.mjs → space/web/assets/blog/css/main.css
     奇趣 / 日刻  tailwindcss -i space/web/assets/<站>/css/input.css -o space/web/assets/<站>/css/main.css --minify
   子站样式一律压缩（同合站前），--minify 只管主站。--main-only：只构建主站。
   用法：node space/scripts/build/build-css.cjs [--minify] [--main-only] */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'web');
const minify = process.argv.includes('--minify');
const tmpTw = path.join(root, 'assets/shell/css/.tw-out.css');

execSync(
  `npx @tailwindcss/cli -i assets/shell/css/tw-input.css -o "${tmpTw}"${minify ? ' --minify' : ''}`,
  { cwd: root, stdio: 'inherit' }
);

const tw = fs.readFileSync(tmpTw, 'utf8');
const src = fs.readFileSync(path.join(root, 'assets/shell/css/input.css'), 'utf8');
fs.unlinkSync(tmpTw);
/* 2026-10-24 PR3：--minify 时自定义分层 CSS 也压缩（以前只压了 Tailwind 那段，input.css 的注释和缩进原样进 main.css）。
   只去注释、收空白（space/scripts/lib/css-min.cjs），不改任何选择器 / 属性 / 值 / 顺序；单测核对压缩前后逐条声明一致。 */
const custom = minify ? require('../lib/css-min.cjs').minifyCss(src) : src;

const out =
  '@layer tw, reset, tokens, sgx-base, sgx-components, sgx-utilities, overrides;\n' +
  '@layer tw{\n' + tw + '\n}\n' +
  custom;

fs.writeFileSync(path.join(root, 'assets/shell/css/main.css'), out);
console.log('CSS built:', out.length, 'bytes');

/* Tailwind 实际安装版本 → data/shell/tailwind.json（设置 › 关于 页显示）。
   Hugo 只能读网站目录内的文件，读不到根目录的 package-lock.json，所以在这里转一手。 */
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package-lock.json'), 'utf8'));
const twPkg = (lock.packages || {})['node_modules/tailwindcss'];
fs.writeFileSync(path.join(root, 'data/shell/tailwind.json'), JSON.stringify({ version: twPkg ? twPkg.version : '' }) + '\n');

/* 三个子站的样式（合站 2026-11；合站前在 space/scripts/build-sites.mjs 里各站构建前跑） */
if (!process.argv.includes('--main-only')) {
  const repo = path.join(__dirname, '..', '..', '..');
  execSync(`"${process.execPath}" space/scripts/blog/build-css.mjs`, { cwd: repo, stdio: 'inherit' });
  for (const site of ['curio', 'daymark']) {
    execSync(`npx --no-install tailwindcss -i space/web/assets/${site}/css/input.css -o space/web/assets/${site}/css/main.css --minify`, { cwd: repo, stdio: 'inherit' });
  }
}
