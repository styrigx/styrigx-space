/* 2.4.0 B：CSS 构建脚本
   Tailwind v3 会把 @layer 包裹内的 @media 响应式变体提升到顶层（成为 unlayered，
   优先级高于所有层），破坏分层顺序。因此分两步构建：
   1. tailwindcss 单独构建 tw-input.css → 临时文件（含被提升的 @media 块）；
   2. 把整份 Tailwind 产物包进 @layer tw { }（@media 在层内合法），再拼接自定义分层 CSS。
   用法：node scripts/build-css.cjs [--minify] */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const minify = process.argv.includes('--minify');
const tmpTw = path.join(root, 'assets/css/.tw-out.css');

execSync(
  `npx @tailwindcss/cli -i assets/css/tw-input.css -o "${tmpTw}"${minify ? ' --minify' : ''}`,
  { cwd: root, stdio: 'inherit' }
);

const tw = fs.readFileSync(tmpTw, 'utf8');
const custom = fs.readFileSync(path.join(root, 'assets/css/input.css'), 'utf8');
fs.unlinkSync(tmpTw);

const out =
  '@layer tw, reset, tokens, sgx-base, sgx-components, sgx-utilities, overrides;\n' +
  '@layer tw{\n' + tw + '\n}\n' +
  custom;

fs.writeFileSync(path.join(root, 'assets/css/main.css'), out);
console.log('CSS built:', out.length, 'bytes');
