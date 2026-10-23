/**
 * @fileoverview 账号 → 云同步页（/account/sync/，2026-10-24 PR4）每个同步项的「本机当前值」文字。纯函数，node --test 直接测
 * （tests/web/ui/sync-items.test.mjs）。同步项清单在 data/sync-items.yaml（模板 account-sync.html 渲染成行），
 * 每行带 data-sync-type / data-sync-default / data-sync-on / data-sync-off / data-sync-opts，这里按它们把 localStorage 原值翻成人话。
 *
 * 类型：
 * - enum   原值（null = 默认）→ 选项名；不认识的值原样显示
 * - bool   与 features.js get 同一规则：null = 默认；= on 存储值 → 开；= off 存储值 → 关；其他 → 默认
 * - string 原值（时区名等），null → 默认值
 * - json   null → 「默认」，有值 → 「已自定义」
 * - accent #rrggbb → 大写色值；没设 → 「未设置」（用调色板）
 * - city   {name} → 城市名；没设 / 坏了 → 「未设置」
 */

/**
 * @typedef {{type:string, def?:string|null, on?:string|null, off?:string|null, opts?:Record<string,string>}} SyncItemDef
 */

/**
 * @param {SyncItemDef} d
 * @param {string|null} raw localStorage 原值（null = 没有这个 key）
 * @param {function(string): string} t 文案（syncValOn / syncValOff / syncValDefault / syncValCustom / syncValUnset）
 * @returns {string}
 */
export function valueText(d, raw, t) {
  const opts = d.opts || {};
  switch (d.type) {
    case 'enum': {
      const v = raw === null || raw === undefined ? (d.def == null ? '' : String(d.def)) : raw;
      return opts[v] || v;
    }
    case 'bool': {
      const defOn = d.def === 'true' || d.def === '1';
      let on = defOn;
      if (raw !== null && raw !== undefined) {
        if (d.on != null && raw === d.on) on = true;
        else if (d.off != null && raw === d.off) on = false;
      }
      return t(on ? 'syncValOn' : 'syncValOff');
    }
    case 'string':
      return raw || (d.def == null ? '' : String(d.def));
    case 'json':
      return raw === null || raw === undefined ? t('syncValDefault') : t('syncValCustom');
    case 'accent':
      return raw && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : t('syncValUnset');
    case 'city': {
      try {
        const c = raw ? JSON.parse(raw) : null;
        if (c && typeof c.name === 'string' && c.name) return c.name;
      } catch (e) {}
      return t('syncValUnset');
    }
    default:
      return raw || '';
  }
}

/**
 * 从一行的 data-* 读出定义（模板 account-sync.html 输出）。
 * @param {{getAttribute(n:string): string|null}} el
 * @returns {SyncItemDef}
 */
export function defOf(el) {
  /** @type {Record<string,string>} */
  let opts = {};
  try { opts = JSON.parse(el.getAttribute('data-sync-opts') || '{}') || {}; } catch (e) {}
  return {
    type: el.getAttribute('data-sync-type') || 'string',
    def: el.getAttribute('data-sync-default'),
    on: el.getAttribute('data-sync-on'),
    off: el.getAttribute('data-sync-off'),
    opts: opts,
  };
}
