// 跟随主站设置的「模块」那一半：
// 1. 自定义主题色没有缓存（第一次来 / 主站换了颜色 / 引擎升级）：按需加载共享外壳的引擎，算好交给共享读端 SgxUI.setRoles 插上并缓存；
//    首帧前的同步部分在 layouts/partials/sgx-inherit.html（内联共享读端 ui-cookie-read.js，自定义色时 <html> 上有内联 --sgx-seed）。
// 2. 数字健康：文章页记 post:<slug>（标题取 h1，3 分钟没操作才停表），其他页记 blog，上报主站 /api/wellbeing。
// 引擎地址由模板经 js.Build params 传进来（引擎单独打包，只在需要时 import）。
import * as params from '@params';
import { initWbTrack } from '../blog/wb-track.js';

const { schemeUrl } = params as unknown as { schemeUrl: string };

type SgxUIApi = { STYLE_ID: string; setRoles: (seed: string, css: string) => boolean };

async function ensureSeedRoles() {
  const UI = (window as unknown as { SgxUI?: SgxUIApi }).SgxUI;
  const root = document.documentElement;
  const seedOf = () => root.style.getPropertyValue('--sgx-seed').trim();
  const seed = seedOf();
  if (!UI || !seed) return;
  /* 读端首帧已经按缓存插好（缓存的引擎版本 / 种子对不上时读端会把旧的删掉） */
  if (document.getElementById(UI.STYLE_ID)) return;
  const { rolesCss } = await import(/* @vite-ignore */ schemeUrl);
  if (seedOf() !== seed) return;
  UI.setRoles(seed, rolesCss(seed));
}

const ENDPOINT = 'https://styrigx.com/api/wellbeing';

function start() {
  /* 文章地址：/blog/post/<slug>/、/blog/en/post/<slug>/（图志下的博客前缀 /blog） */
  const p = location.pathname.replace(/^\/blog(?=\/)/, '').replace(/^\/en(?=\/)/, '');
  const m = p.match(/^\/post\/([A-Za-z0-9_\-.%]{1,80})\/?$/);
  if (m) {
    initWbTrack({
      key: 'post:' + m[1],
      title: () => (document.querySelector('main h1')?.textContent || document.title || '').trim(),
      endpoint: ENDPOINT,
      idleMs: 180000,
    });
  } else {
    initWbTrack({ key: 'blog', endpoint: ENDPOINT });
  }
}

start();
void ensureSeedRoles();
