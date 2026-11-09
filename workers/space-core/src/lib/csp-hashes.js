/**
 * @fileoverview 生成文件，别手改：node space/scripts/gen-csp.mjs（先 hugo --minify -s space/web）。CI 用 --check 核对。
 * 生产构建里每段会执行的内联 <script> 的 sha256，给 security-headers.js 的 Content-Security-Policy-Report-Only 用。
 */
export const INLINE_SCRIPT_HASHES = Object.freeze([
  'sha256-3cnYCRXIA6PvNuskoomZSRzThARfCNNwL5rAwESJLec=', // 404.html（6 页）: addEventListener('error',function(e){var t=e.target;if(!t||t
  'sha256-EXXy0XPvXTtUhwj3HaX4YeIspqPULX4vksSB4X+ltm4=', // 404.html（6 页）: document.documentElement.classList.add('no-module');
  'sha256-LEyUD+QpBJGQuguZ7duNA1niRnvHFSc+poR8PASgVWQ=', // 404.html（6 页）: (()=>{var S=Object.freeze(["en","zh"]),_=["blog","curio","da
  'sha256-h5JNOR4zPHT8YecFgkGto7igIre3DOn8RLzWyBX/4IQ=', // 404.html（6 页）: addEventListener('pagereveal',function(e){window.__sgxReveal
  'sha256-i1XMiEvbVUtdwdw3UvJJ8q9wEIV5cxYfeWksDFT51NY=', // 404.html（6 页）: function __layoutMode(){ try{ if(new URLSearchParams(l
  'sha256-op3CP/1k6TQKGdurIATw2nTR/PE3++UTTQgtKCtXkEA=', // 404.html（6 页）: function __sgxUaMobile(){try{var t=navigator,e=t.userAgentDa
]);
