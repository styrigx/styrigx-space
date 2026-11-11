import { fill } from '../../core/out.js';

/** 22 套调色板 id（= 共享读端 SgxUI.PRESETS 的顺序；四站 <head> 都有读端） @returns {string[]} */
function ids() {
  const u = /** @type {any} */ (typeof window !== 'undefined' ? window : globalThis).SgxUI;
  return u && u.PRESETS ? Object.keys(u.PRESETS) : [];
}

/** theme [调色板 id]：不带参数打开外观面板；带 id 切到那套调色板（2026-11-12 调色板 v4：dark / light / auto 删除，深浅只由调色板决定） */
export default {
  name: 'theme',
  /* Tab 补全 = 22 个调色板 id（取值时现读，读端在命令表之后加载也不怕） */
  get args() {
    return ids();
  },
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const a0 = (p.args[0] || '').toLowerCase();
    if (!a0) return { out: [x.k.arrow([['', x.S.themeOpen]])], after: function () { x.act.theme(''); } };
    if (ids().indexOf(a0) < 0) return { out: [x.k.plain(x.S.usageTheme)] };
    x.act.theme(a0);
    return { out: [x.k.arrow(fill(x.S.themeSet, { x: ['k', a0] }))] };
  },
};
