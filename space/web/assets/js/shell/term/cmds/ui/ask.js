import { fill } from '../../core/out.js';

/**
 * ask <问题>：打开 AI 窗口代发。man 里按 ai 组列（定稿 v5.5 §四「ask：按本节 ai 组，ai 组成员的 man 都列出 ask；私密内容仍只给站长与 root」，
 * Gray 2026-11-11 19:59；私密档在服务端 POST /api/ai actions.private = webmaster）；root 看全部。
 * 访客（nobody，AI 上锁）：不开窗口，提示先 su、搜关键词用 find（v5 S4；割接起入口是 su，同 AI 窗口的「已上锁，su 登录后可用」，定稿 §七）。
 */
export default {
  name: 'ask',
  takesArgs: true,
  /* 普通用户层（man 分段），只给 ai 组成员列（core/who.js listedFor 的 group） */
  audience: /** @type {any} */ (['user', 'root6']),
  group: 'ai',
  /** @param {any} p @param {any} x */
  run: function (p, x) {
    if (x.who() === 'nobody') return { out: [{ t: 'line', seg: fill(x.S.askLocked, { s: ['k', 'su'], f: ['k', 'find'] }), cls: 'o' }] };
    const q = p.rest;
    return { out: [x.k.arrow([['', x.S.asking]])], after: function () { x.act.ask(q); } };
  },
};
