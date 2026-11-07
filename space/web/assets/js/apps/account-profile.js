/**
 * @fileoverview 账号 → 个人资料（/account/profile/，2026-11-07 Gray 定）：头像、姓名、昵称、签名、邮箱一行一项，行内改。
 *
 * - 进页查一次账号会话（account-common.js requireAccountSession）：明确没有 → 回账号页登录，登录后回本页。
 * - 值：首帧是模板画的默认值（data/profile.yaml）；再 GET /api/profile（lib/profile.js fetchProfile）覆盖。
 * - 点一行（或回车 / 空格）→ 行下方展开编辑框，同一时间只开一行；再点这一行 / 「取消」/ Esc → 收起、丢掉没保存的改动。
 *   「保存」/ 回车 → 先前端校验（lib/profile.js checkValue：必填、长度、单行、邮箱格式），再 PUT /api/profile 只带这一项；
 *   成功 → 收起、更新这一行和页面上所有资料位置、提示「已保存」；失败 → 编辑框下面一行红字（没授权 profile.write、长度、格式、网络）。
 * - 头像行：展开「选择照片… / 移除照片」（没有自定义头像时只有第一项）+ 取消，调 apps/avatar-edit.js（全屏裁剪 → PUT /api/avatar）。
 * - 不用底部弹层（Gray 立规；check-frontend 规则 3），不跳页。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { PROFILE_FIELDS, PROFILE_EVENT, checkValue, effectiveProfile, readCache, fetchProfile, saveProfile } from '../lib/profile.js';
import { chooseAvatarPhoto, removeAvatar, avatarIsCustom } from './avatar-edit.js';
import { createT, requireAccountSession } from './account-common.js';

(function () {
  const root = document.getElementById('acct-profile');
  if (!root) return;
  const en = document.documentElement.lang === 'en';
  const t = createT();
  /** @type {import('../lib/profile.js').Profile} */
  let cur = effectiveProfile(readCache());

  /** @type {HTMLElement[]} */
  const items = Array.from(root.querySelectorAll('[data-pf-field]'));
  /** @type {HTMLElement|null} */
  let openItem = null;

  /** @param {HTMLElement} item */
  function fieldOf(item) { return item.getAttribute('data-pf-field') || ''; }
  /** @param {HTMLElement} item */
  function rowOf(item) { return /** @type {HTMLElement} */ (item.querySelector('.acct-pf-row')); }
  /** @param {HTMLElement} item */
  function edOf(item) { return /** @type {HTMLElement} */ (item.querySelector('.acct-pf-ed')); }
  /** @param {HTMLElement} item */
  function inputOf(item) { return /** @type {HTMLInputElement|HTMLTextAreaElement|null} */ (item.querySelector('[data-pf-in]')); }

  /** 每行显示的当前值（签名为空 → 「未设置」，变淡） */
  function paintValues() {
    items.forEach(function (item) {
      const id = fieldOf(item);
      const val = item.querySelector('[data-pf-val]');
      if (!val || !Object.prototype.hasOwnProperty.call(cur, id)) return;
      const v = /** @type {any} */ (cur)[id] || '';
      val.textContent = v || t('pfNotSet');
      val.classList.toggle('is-empty', !v);
    });
  }

  /** @param {HTMLElement} item @param {string} msg */
  function showErr(item, msg) {
    const err = /** @type {HTMLElement|null} */ (item.querySelector('[data-pf-err]'));
    if (!err) return;
    err.textContent = msg;
    err.hidden = !msg;
    const inp = inputOf(item);
    if (inp) inp.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  /** @param {HTMLElement} item */
  function paintCount(item) {
    const inp = inputOf(item);
    const c = item.querySelector('[data-pf-count]');
    if (!inp || !c) return;
    const max = parseInt(item.getAttribute('data-pf-max') || '0', 10) || 0;
    c.textContent = t('pfCount').replace('{n}', String(Array.from(inp.value).length)).replace('{max}', String(max));
  }

  /** @param {string} id @param {string} reason */
  function errText(id, reason) {
    const f = PROFILE_FIELDS.find(function (x) { return x.id === id; });
    if (reason === 'empty') return t('pfEmpty');
    if (reason === 'too-long') return t('pfTooLong').replace('{n}', String(f ? f.max : ''));
    if (reason === 'format') return f && f.kind === 'email' ? t('pfEmailFormat') : t('pfFormat');
    if (reason === 'scope') return t('pfNoScope');
    return t('pfFailed');
  }

  /** @param {HTMLElement} item @param {boolean} [focusRow] */
  function close(item, focusRow) {
    const ed = edOf(item);
    if (ed) ed.hidden = true;
    rowOf(item).setAttribute('aria-expanded', 'false');
    item.classList.remove('is-open');
    showErr(item, '');
    if (openItem === item) openItem = null;
    if (focusRow) { try { rowOf(item).focus({ preventScroll: true }); } catch (e) {} }
  }

  /** @param {HTMLElement} item */
  function open(item) {
    if (openItem && openItem !== item) close(openItem);
    openItem = item;
    const ed = edOf(item);
    item.classList.add('is-open');
    rowOf(item).setAttribute('aria-expanded', 'true');
    if (ed) ed.hidden = false;
    showErr(item, '');
    const id = fieldOf(item);
    const inp = inputOf(item);
    if (inp) {
      inp.value = /** @type {any} */ (cur)[id] || '';
      paintCount(item);
      try { inp.focus({ preventScroll: true }); inp.select(); } catch (e) {}
    }
    if (id === 'photo') {
      const rm = /** @type {HTMLElement|null} */ (item.querySelector('[data-pf-remove]'));
      avatarIsCustom().then(function (c) { if (rm) rm.hidden = !c; });
    }
    try { item.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }

  /** @param {HTMLElement} item */
  function toggle(item) {
    if (openItem === item) close(item, true);
    else open(item);
  }

  /** @param {HTMLElement} item */
  function save(item) {
    const id = fieldOf(item);
    const inp = inputOf(item);
    if (!inp) return;
    /* 签名是单行值：粘贴进来的换行合成空格 */
    const raw = id === 'motto' ? inp.value.replace(/[\r\n]+/g, ' ') : inp.value;
    const bad = checkValue(id, raw);
    if (bad) {
      showErr(item, errText(id, bad));
      try { inp.focus({ preventScroll: true }); } catch (e) {}
      return;
    }
    const v = raw.trim();
    if (v === (/** @type {any} */ (cur)[id] || '')) { close(item, true); return; }
    const btns = /** @type {HTMLButtonElement[]} */ (Array.from(item.querySelectorAll('button')));
    btns.forEach(function (b) { b.disabled = true; });
    inp.disabled = true;
    /** @type {Record<string, string>} */
    const change = {};
    change[id] = v;
    saveProfile(change).then(function (r) {
      btns.forEach(function (b) { b.disabled = false; });
      inp.disabled = false;
      if (r.ok && r.profile) {
        cur = r.profile;
        paintValues();
        close(item, true);
        toast(t('pfSaved'));
        return;
      }
      showErr(item, errText(id, r.error === 'scope' ? 'scope' : r.error === 'params' ? String(r.reason || '') : ''));
      try { inp.focus({ preventScroll: true }); } catch (e) {}
    });
  }

  items.forEach(function (item) {
    const row = rowOf(item);
    on(row, 'click', function () { toggle(item); });
    on(row, 'keydown', function (e) {
      const ev = /** @type {KeyboardEvent} */ (e);
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(item); }
    });
    item.querySelectorAll('[data-pf-cancel]').forEach(function (b) { on(b, 'click', function () { close(item, true); }); });
    const sv = item.querySelector('[data-pf-save]');
    if (sv) on(sv, 'click', function () { save(item); });
    const inp = inputOf(item);
    if (inp) {
      on(inp, 'input', function () { paintCount(item); showErr(item, ''); });
      on(inp, 'keydown', function (e) {
        const ev = /** @type {KeyboardEvent} */ (e);
        if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); save(item); }
        else if (ev.key === 'Escape') { ev.preventDefault(); close(item, true); }
      });
    }
    const pick = item.querySelector('[data-pf-pick]');
    if (pick) on(pick, 'click', function () { close(item); chooseAvatarPhoto(); });
    const rm = item.querySelector('[data-pf-remove]');
    if (rm) on(rm, 'click', function () { close(item); removeAvatar(); });
  });

  /* 资料在别处变了（接口回来 / 保存成功）：跟着重画 */
  window.addEventListener(PROFILE_EVENT, function (e) {
    const d = /** @type {CustomEvent} */ (e).detail;
    if (d && typeof d === 'object') { cur = d; paintValues(); }
  });

  paintValues();
  requireAccountSession(en).then(function (j) {
    if (!j) return;
    fetchProfile();
  });
})();
