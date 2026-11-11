// 跟随主站设置的「模块」那一半：
// 1. 自定义主题色没有缓存（第一次来 / 主站换了颜色 / 引擎升级）：按需加载共享外壳的引擎，算好交给共享读端 SgxUI.setRoles 插上并缓存；
//    首帧前的同步部分在 layouts/partials/sgx-inherit.html（内联共享读端 ui-cookie-read.js，自定义色时 <html> 上有内联 --sgx-seed）。
// （原第 2 项数字健康上报 v6 P4 随数字健康整套删除，定稿 v5.5 §四。）
// 引擎地址由模板经 js.Build params 传进来（引擎单独打包，只在需要时 import）。
import * as params from '@params';

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

void ensureSeedRoles();
