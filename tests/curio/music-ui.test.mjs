/* 打磨 6.2：音乐页的小部件 space/web/assets/music/js/music-ui.js（从奇趣 curio.js 拆来的确认框 / 提示条 / sudo / sudoTicket）的纯函数。
   界面行为（确认框开关、提示条）在 e2e。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const UI = require('../../space/web/assets/music/js/music-ui.js');

const fetchOf = (body) => async () => ({ json: async () => body });

test('music-ui：常量同 curio.js / common/js/auth/sudo.js', () => {
  assert.equal(UI.TOAST_MS, 2400);
  assert.equal(UI.SUDO_GRANT_KEY, '__sgxSudoGrant');
});

test('music-ui whoIsRoot：whoami 回 root 才是；出错当不是', async () => {
  assert.equal(await UI.whoIsRoot(fetchOf({ user: { root: true } })), true);
  assert.equal(await UI.whoIsRoot(fetchOf({ user: {} })), false);
  assert.equal(await UI.whoIsRoot(async () => { throw new Error('net'); }), false);
});

test('music-ui sudoTicketOf：root 直接空票；不是 root 登记待办、发 sgx:sudo 预填行，终端交回票', async () => {
  globalThis.CustomEvent ??= class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  const g = { fetch: fetchOf({ user: { root: true } }) };
  assert.equal(await UI.sudoTicketOf(g, { dispatchEvent() {} }, 'sudo x', {}), '');
  const sent = [];
  const g2 = { fetch: fetchOf({ user: {} }) };
  const p = UI.sudoTicketOf(g2, { dispatchEvent: (e) => sent.push(e) }, 'sudo rm album', { method: 'POST', path: '/music/api/music', action: 'album.del' });
  await new Promise((r) => setTimeout(r, 0));
  const pend = g2[UI.SUDO_GRANT_KEY];
  assert.equal(pend.line, 'sudo rm album');
  assert.equal(pend.grant.action, 'album.del');
  assert.equal(sent[0].type, 'sgx:sudo');
  assert.equal(sent[0].detail.line, 'sudo rm album');
  pend.done('tkt');
  assert.equal(await p, 'tkt');
});
