/**
 * @fileoverview 生成文件，别手改：node space/scripts/gen-csp.mjs（先 hugo --minify -s space/web）。CI 用 --check 核对。
 * 生产构建里每段会执行的内联 <script> 的 sha256，给 security-headers.js 的 Content-Security-Policy-Report-Only 用。
 */
export const INLINE_SCRIPT_HASHES = Object.freeze([
  'sha256-3cnYCRXIA6PvNuskoomZSRzThARfCNNwL5rAwESJLec=', // 404.html（30 页）: addEventListener('error',function(e){var t=e.target;if(!t||t
  'sha256-75E40M3nXqFNbW3FNVzGAXcrDBPBdEx2RXzC6SybHng=', // 404.html（30 页）: function __sgxUaMobile(){try{var t=navigator,e=t.userAgentDa
  'sha256-EXXy0XPvXTtUhwj3HaX4YeIspqPULX4vksSB4X+ltm4=', // 404.html（30 页）: document.documentElement.classList.add('no-module');
  'sha256-FEweR2S8GQoFITD46Ym/ONW0WtcGzMDNUoDVH4fLS/o=', // 404.html（30 页）: (()=>{var p=["blog","curio","daymark"],L=new RegExp("^/("+p.
  'sha256-OJmjzPv5GPxJWCxz5XsqT+kxRohb5rwl7RHxVEolbkA=', // about/index.html（2 页）: document.getElementById('copy-year').textContent=new Date().
  'sha256-PlaJWDLqr4EAqLojCYCQNd2s/cWllJVH2MMm6J5a6QU=', // 404.html（30 页）: addEventListener('pagereveal',function(e){window.__sgxReveal
  'sha256-i1XMiEvbVUtdwdw3UvJJ8q9wEIV5cxYfeWksDFT51NY=', // 404.html（30 页）: function __layoutMode(){ try{ if(new URLSearchParams(l
]);
