import { DIRS, resolvePath, top } from '../fs/tree.js';
import { fill } from '../../core/out.js';

/** ~/account/<目录> → 账号下拉的层（同 shell/account/commands.js CD_DIRS） */
const ACCT = /** @type {Record<string, string>} */ ({ profile: 'profile', devices: 'devices', security: 'keys', apps: 'grants' });

/**
 * open [路径]：打开路径对应的东西（唯一会跳页 / 开下拉的文件系统命令）。
 * 四个站的目录：主页上滚到那一节、其他页去那个站；daymark/today：日刻；account[/层]：账号下拉（tty5）那一层；shield[/层]：盾牌下拉（tty3）那一层。
 */
export default {
  name: 'open',
  args: DIRS.concat(['account', 'shield', 'proxy', 'daymark/today', '~']),
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    const r = resolvePath(x.cwd(), p.args[0] || '.');
    if (!r) return { out: [x.k.noDir('open', p.args[0])] };
    const t = top(r.path);
    const sub = r.path.indexOf('/') > 0 ? r.path.slice(r.path.indexOf('/') + 1) : '';
    /** @type {any} */
    let res = null;
    if (t === 'proxy' && x.act.sub) res = x.act.sub('sub');
    else if (t === 'account' && x.act.account) res = x.act.account(ACCT[sub] || '');
    else if (t === 'shield' && x.act.shield) res = x.act.shield(sub);
    else if (t === '~' || DIRS.indexOf(t) >= 0) res = x.act.cd(t);
    if (res && res.kind === 'scroll') return { out: res.label ? [x.k.arrow(fill(x.S.scrolled, { x: ['', res.label] }))] : [] };
    if (res && res.go) return { out: [x.k.arrow(fill(x.S.opening, { x: ['k', res.href] }))], after: res.go };
    return { out: [] };
  },
};
