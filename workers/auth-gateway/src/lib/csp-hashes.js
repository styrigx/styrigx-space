/**
 * @fileoverview 生成文件，别手改：node space/scripts/gen-csp.mjs（先 hugo --minify -s space/web）。CI 用 --check 核对。
 * 生产构建里每段会执行的内联 <script> 的 sha256，给 security-headers.js 的 Content-Security-Policy-Report-Only 用。
 */
export const INLINE_SCRIPT_HASHES = Object.freeze([
  'sha256-3cnYCRXIA6PvNuskoomZSRzThARfCNNwL5rAwESJLec=', // 404.html（34 页）: addEventListener('error',function(e){var t=e.target;if(!t||t
  'sha256-EXXy0XPvXTtUhwj3HaX4YeIspqPULX4vksSB4X+ltm4=', // 404.html（34 页）: document.documentElement.classList.add('no-module');
  'sha256-K+5YbLhiGipjfWqp6YcyJ1VwM9CVGLCm5SbwuKEX8sM=', // 404.html（34 页）: addEventListener('pagereveal',function(e){window.__sgxReveal
  'sha256-OJmjzPv5GPxJWCxz5XsqT+kxRohb5rwl7RHxVEolbkA=', // en/settings/about/index.html（2 页）: document.getElementById('copy-year').textContent=new Date().
  'sha256-OKqTZy8Akiw34SriMmV/dSVgWW0PGgwumuFIeu+te0c=', // 404.html（34 页）: function __layoutMode(){ var m=null; try{ var 
  'sha256-TipVAKejOiCJJ5RZBpuk5yhfgL1UyEskgUhRND+AeBc=', // en/settings/accessibility/index.html（5 页）: location.replace(document.documentElement.getAttribute('data
]);
