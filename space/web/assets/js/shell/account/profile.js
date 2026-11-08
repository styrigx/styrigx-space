/**
 * @fileoverview 个人资料（P1–P8）：头像、姓名（40）、昵称（32）、签名（120）、邮箱（254，查格式）。
 *
 * 行下展开 `> 值_` + 字数 + `esc 取消 / enter 保存`，每次只开一行（P2）；检查和失败原因在展开区（P3）；保存后全站跟着换（P4，lib/profile.js 派发事件）。
 * 头像那一行展开「选择照片… / 移除照片」（只有自定义头像时有移除，P5 / P6）→ avatar-edit.js 的全屏裁剪（O7：交互不变，只换成稿的样子）。
 */
import { PROFILE_FIELDS, checkValue, readCache, effectiveProfile, profileDefaults, saveProfile, PROFILE_EVENT } from '../../lib/profile.js';
import { chooseAvatarPhoto, removeAvatar, avatarIsCustom } from './avatar-edit.js';

/** @param {any} C */
export function mountProfile(C) {
  const t = C.t;
  const esc = C.esc;
  const viewEl = C.viewEl;
  let photoCustom = false;

  /** 本机缓存的资料（改过的值盖住默认值） */
  C.who = function () { return effectiveProfile(readCache(), profileDefaults()); };

  C.renderProfile = function () {
    C.subHead(t('profile.title'), C.path('profile'));
    const p = C.who();
    const navImg = /** @type {HTMLImageElement|null} */ (C.doc.querySelector('#site-nav .sgx-tb-avatar'));
    const src = navImg ? navImg.src.replace(/\/avatar\/\d+\.webp/, '/avatar/96.webp') : '/avatar/96.webp';
    const ed = C.editing;
    let h = C.row({ k: t('profile.photo'), vHtml: '<img src="' + esc(src) + '" alt="" width="40" height="40" class="sgx-at-ph" data-sgx-avatar="96">', act: 'photo', armed: ed === 'photo' });
    if (ed === 'photo') {
      h += '<div class="sgx-at-ed"><div class="sgx-at-ac sgx-at-ac--start"><button type="button" class="sgx-at-a" data-at-act="photo-pick">' + esc(t('profile.choosePhoto')) + '</button>' +
        (photoCustom ? '<button type="button" class="sgx-at-a" data-at-act="photo-rm">' + esc(t('profile.removePhoto')) + '</button>' : '') +
        '<button type="button" class="sgx-at-a2" data-at-act="ed-cancel"><kbd>esc</kbd>' + esc(t('common.cancel')) + '</button></div><p class="sgx-at-ms">' + esc(t('profile.cropHint')) + '</p></div>';
    }
    /* 没改过的字段显示站点默认值（灰字，data-at-default）；只有默认值也没有时才是「未填写」 */
    const own = readCache();
    PROFILE_FIELDS.forEach(function (f) {
      const v = /** @type {any} */ (p)[f.id] || '';
      const isDef = /** @type {any} */ (own)[f.id] === undefined;
      const label = t('profile.' + f.id);
      h += C.row({ k: label, vHtml: v ? '<span translate="no" data-sgx-personal' + (isDef ? ' class="sgx-at-dim" data-at-default' : '') + '>' + esc(v) + '</span>' : '<span class="sgx-at-dim">' + esc(t('profile.notSet')) + '</span>', act: 'edit:' + f.id, chev: true, armed: ed === f.id });
      if (ed === f.id) {
        h += '<div class="sgx-at-ed"><label class="sgx-at-eln"><span class="sgx-at-p" aria-hidden="true">&gt;</span><input class="sgx-at-ein" data-at-ein="' + f.id + '" type="' + (f.kind === 'email' ? 'email' : 'text') + '" maxlength="' + (f.max * 2) + '" value="' + esc(v) + '" aria-label="' + esc(label) + '" autocomplete="off" spellcheck="false"><span class="sgx-at-ct" data-at-ct>' + Array.from(v).length + '/' + f.max + '</span></label>' +
          '<div class="sgx-at-ac"><button type="button" class="sgx-at-a2" data-at-act="ed-cancel"><kbd>esc</kbd>' + esc(t('common.cancel')) + '</button><button type="button" class="sgx-at-a" data-at-act="ed-save"><kbd>enter</kbd>' + esc(t('common.save')) + '</button></div>' +
          '<p class="sgx-at-ms" data-at-ems hidden></p></div>';
      }
    });
    viewEl.innerHTML = '<div class="sgx-pop-list">' + h + '</div>';
    C.foot('profile.ft');
    const ein = /** @type {HTMLInputElement|null} */ (viewEl.querySelector('[data-at-ein]'));
    if (ein) {
      const f = PROFILE_FIELDS.find(function (x) { return x.id === ed; });
      ein.addEventListener('input', function () { const ct = viewEl.querySelector('[data-at-ct]'); if (ct && f) ct.textContent = Array.from(ein.value).length + '/' + f.max; });
      ein.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveField(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); C.editing = ''; C.renderProfile(); }
      });
      try { ein.focus({ preventScroll: true }); const n = ein.value.length; ein.setSelectionRange(n, n); } catch (e) {}
    }
  };
  function saveField() {
    const ein = /** @type {HTMLInputElement|null} */ (viewEl.querySelector('[data-at-ein]'));
    const ems = /** @type {HTMLElement|null} */ (viewEl.querySelector('[data-at-ems]'));
    if (!ein) return;
    const id = ein.getAttribute('data-at-ein') || '';
    const f = PROFILE_FIELDS.find(function (x) { return x.id === id; });
    const v = ein.value.trim();
    const bad = checkValue(id, v);
    const show = function (/** @type {string} */ m) { if (ems) { ems.textContent = m; ems.hidden = false; ems.classList.add('is-er'); } };
    if (bad) { show(bad === 'empty' ? t('profile.errEmpty') : bad === 'too-long' ? C.tf('profile.errLong', { n: f ? f.max : 0 }) : t('profile.errFormat')); return; }
    ein.disabled = true;
    /** @type {Record<string, string|null>} */ const ch = {};
    ch[id] = v || null;
    saveProfile(ch).then(function (r) {
      if (r.ok) { C.editing = ''; C.renderProfile(); C.toast(t('common.saved')); return; }
      ein.disabled = false;
      show(r.error === 'scope' ? t('profile.errScope') : r.error === 'network' ? t('common.errNetwork') : r.error === 'account' ? t('reauth.expired') : t('common.errServer'));
    });
  }
  /** 进个人资料：问一次有没有自定义头像 */
  C.enterProfile = function () {
    avatarIsCustom().then(function (c) { photoCustom = c; if (C.layer === 'profile' && !C.editing) C.renderProfile(); });
  };

  /** @param {string} a @returns {boolean} */
  C.actProfile = function (a) {
    if (a === 'photo') { C.editing = C.editing === 'photo' ? '' : 'photo'; C.renderProfile(); return true; }
    if (a === 'photo-pick') { C.editing = ''; C.renderProfile(); chooseAvatarPhoto(); return true; }
    if (a === 'photo-rm') { removeAvatar().then(function (ok) { if (ok) photoCustom = false; C.editing = ''; C.renderProfile(); }); return true; }
    if (a === 'ed-save') { saveField(); return true; }
    if (a.indexOf('edit:') === 0) { C.editing = C.editing === a.slice(5) ? '' : a.slice(5); C.renderProfile(); return true; }
    return false;
  };

  try {
    window.addEventListener(PROFILE_EVENT, function () { if (C.o.ms.isShown() && C.st === 'in' && !C.inReset && (C.layer === 'home' || (C.layer === 'profile' && !C.editing))) C.render(); });
    window.addEventListener('sgx-avatar-changed', function (/** @type {any} */ e) { photoCustom = !!(e && e.detail && e.detail.custom); if (C.o.ms.isShown() && C.layer === 'profile' && !C.editing) C.renderProfile(); });
  } catch (e) {}
}
