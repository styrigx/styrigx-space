/**
 * @fileoverview 个人资料的终端命令（S9，Gray 2026-11-11：账号卡片只展示，改资料搬进终端）。
 *
 * - profile：姓名 · 昵称 · 签名 · 邮箱（没改过的显示站点默认值，标「默认」）· 头像（自定义 / 默认）
 * - profile set name | nick | sign | email <值>：改一项（检查同原来的编辑行：姓名 40、昵称 32、邮箱查格式；签名不限长度）；保存后全站跟着换（prefs/profile.js 派发事件）
 * - profile avatar：没有自定义头像 → 收起终端、打开系统选照片 → 原来的全屏裁剪（avatar-edit.js）；有 → [1] 选择照片 [2] 移除照片
 * 头像的裁剪层在页面上（不在终端的模态窗口里），所以先收起终端再选照片。
 */
import { PROFILE_FIELDS, checkValue, readCache, saveProfile } from '../../../prefs/profile.js';
import { chooseAvatarPhoto, removeAvatar, avatarIsCustom } from '../avatar-edit.js';
import { PROFILE_KEYS } from '../commands.js';

/** @param {any} C 账号层上下文（./layer.js） */
export function mountProfile(C) {
  const t = C.t;
  const tf = C.tf;
  const esc = C.esc;

  /** profile：列出 */
  C.profileShow = function () {
    const p = /** @type {any} */ (C.who());
    const own = /** @type {any} */ (readCache());
    const w = Math.max.apply(null, PROFILE_FIELDS.map(function (f) { return Array.from(t('profile.' + f.id)).length; }));
    PROFILE_FIELDS.forEach(function (f) {
      const v = p[f.id] || '';
      const label = t('profile.' + f.id);
      const pad = '\u3000'.repeat(Math.max(0, w - Array.from(label).length));
      const key = Object.keys(PROFILE_KEYS).find(function (k) { return /** @type {any} */ (PROFILE_KEYS)[k] === f.id; }) || f.id;
      C.out('<span class="sgx-at-dim">' + esc(label) + pad + '</span>  ' +
        (v ? '<span translate="no" data-sgx-personal>' + esc(v) + '</span>' + (own[f.id] === undefined ? ' <span class="sgx-at-dim">· ' + esc(t('profile.isDefault')) + '</span>' : '') : '<span class="sgx-at-dim">' + esc(t('profile.notSet')) + '</span>') +
        ' <span class="sgx-at-dim" translate="no">· profile set ' + key + '</span>');
    });
    C.setMode('busy');
    avatarIsCustom().then(function (c) {
      C.toCmd();
      const label = t('profile.photo');
      const pad = '\u3000'.repeat(Math.max(0, w - Array.from(label).length));
      C.out('<span class="sgx-at-dim">' + esc(label) + pad + '</span>  ' + esc(c ? t('profile.photoCustom') : t('profile.photoDefault')) + ' <span class="sgx-at-dim" translate="no">· profile avatar</span>');
    }, function () { C.toCmd(); });
  };

  /** profile set <字段> <值> @param {string} key name / nick / sign / email @param {string} raw 值（原样） */
  C.profileSet = function (key, raw) {
    const id = /** @type {any} */ (PROFILE_KEYS)[key];
    const f = PROFILE_FIELDS.find(function (x) { return x.id === id; });
    if (!f) { C.err(t('profile.usage')); return; }
    const v = String(raw || '').trim();
    const bad = checkValue(id, v);
    if (bad) { C.err(bad === 'empty' ? t('profile.errEmpty') : bad === 'too-long' ? tf('profile.errLong', { n: f.max || 0 }) : t('profile.errFormat')); return; }
    /** @type {Record<string, string|null>} */ const ch = {};
    ch[id] = v || null;
    C.setMode('busy');
    saveProfile(ch).then(function (r) {
      C.toCmd();
      if (r.ok) { C.ok('✓ ' + tf('profile.set', { k: t('profile.' + id) }), v); return; }
      C.err(r.error === 'network' ? t('common.errNetwork') : t('common.errServer'));
    }, function () { C.toCmd(); C.netErr(); });
  };

  /** 收起终端、打开系统选照片（裁剪层在页面上） */
  function pick() {
    C.note('profile.picking');
    C.term.close(function () { chooseAvatarPhoto(); });
  }
  /** profile avatar */
  C.profileAvatar = function () {
    C.setMode('busy');
    avatarIsCustom().then(function (custom) {
      C.toCmd();
      if (!custom) { pick(); return; }
      C.opts([['1', t('profile.choosePhoto')], ['2', t('profile.removePhoto')]]);
      C.pick({
        1: function () { C.echoPick('1'); C.toCmd(); pick(); },
        2: function () {
          C.echoPick('2');
          C.setMode('busy');
          removeAvatar().then(function (ok) { C.toCmd(); if (ok) C.ok('✓ ' + t('profile.avatar.removed')); });
        },
      });
      C.focusIn();
    }, function () { C.toCmd(); pick(); });
  };
}
