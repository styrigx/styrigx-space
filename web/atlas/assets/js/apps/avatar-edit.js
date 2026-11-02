/**
 * @fileoverview 账号页账号卡（/account/ 登录后总览顶部）：换头像 / 移除头像（只有管理员会话可用）。
 *
 * 点头像 → 底部弹层「选择照片… / 移除照片」（没有自定义头像时只有第一项）。
 * 选照片 → 全屏裁剪：圆形取景框，单指拖动、双指缩放（电脑上滚轮缩放），照片始终盖满取景框。
 * 完成 → 本地用 canvas 裁成 512 / 192 / 96 / 32 四张（WebP，浏览器不支持时 PNG），
 *        PUT /api/avatar；成功后刷新浏览器里这四张的缓存，页面上的头像和标签页图标立刻换新。
 * 移除 → DELETE /api/avatar，回到默认头像。
 *
 * 有没有自定义头像：看 /avatar/32.webp 的 ETag，默认图是 "d-32"。
 */
import { on } from '../lib/events.js';
import { toast } from '../lib/toast.js';
import { openSheet } from '../shell/sheet.js';

const SIZES = [512, 192, 96, 32];
const ZOOM_MAX = 8; /* 最大放大到「刚好盖满」的 8 倍 */

const en = document.documentElement.lang === 'en';
const TXT = en
  ? { title: 'Profile photo', pick: 'Choose photo…', remove: 'Remove photo', crop: 'Move and scale', cancel: 'Cancel', done: 'Done',
      saved: 'Photo updated', removed: 'Photo removed', failed: 'Couldn’t save the photo. Try again.', badFile: 'This file can’t be opened as an image.' }
  : { title: '头像', pick: '选择照片…', remove: '移除照片', crop: '移动和缩放', cancel: '取消', done: '完成',
      saved: '头像已更新', removed: '已移除头像', failed: '头像没保存上，请重试', badFile: '这个文件打不开' };

/** 当前是不是自定义头像（看 ETag） */
/** 有没有自定义头像：进页面时查一次，换 / 删之后直接改 */
let custom = false;
async function hasCustom() {
  try {
    const r = await fetch('/avatar/32.webp', { cache: 'no-cache' });
    const etag = r.headers.get('ETag') || '';
    /* 自定义头像的 ETag 是 "<版本>-32"，默认图是 "d-32"；别的格式（本地静态服务器）都算默认 */
    return /^"(?!d-)[0-9a-z]+-32"$/.test(etag);
  } catch (e) {
    return false;
  }
}

/**
 * 换完 / 删完：刷新浏览器缓存里的四张，再把页面上的头像和标签页图标换成新地址。
 * @param {string} ver
 */
async function refreshAvatars(ver) {
  await Promise.all(
    SIZES.map(function (s) {
      return fetch('/avatar/' + s + '.webp', { cache: 'reload' }).catch(function () {});
    })
  );
  const q = '?v=' + encodeURIComponent(ver);
  document.querySelectorAll('img[data-sgx-avatar]').forEach(function (img) {
    const s = img.getAttribute('data-sgx-avatar');
    /** @type {HTMLImageElement} */ (img).src = '/avatar/' + s + '.webp' + q;
  });
  document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(function (l) {
    const href = l.getAttribute('href') || '';
    const m = /^\/avatar\/(\d+)\.webp/.exec(href);
    if (m) l.setAttribute('href', '/avatar/' + m[1] + '.webp' + q);
  });
}

/**
 * canvas → Blob：优先 WebP，浏览器不支持时 toBlob 自己回落 PNG。
 * @param {HTMLCanvasElement} c
 * @returns {Promise<Blob>}
 */
function toBlob(c) {
  return new Promise(function (resolve, reject) {
    c.toBlob(
      function (b) {
        if (b) resolve(b);
        else reject(new Error('toBlob'));
      },
      'image/webp',
      0.9
    );
  });
}

/**
 * 从原图裁出取景框里的正方形，生成四个尺寸（大图一步缩到 512，再逐级往下缩，小图不糊）。
 * @param {HTMLImageElement} img
 * @param {{sx:number, sy:number, sw:number}} src 原图坐标里的正方形
 * @returns {Promise<Record<string, Blob>>}
 */
async function renderSizes(img, src) {
  /** @type {Record<string, Blob>} */
  const out = {};
  /** @type {CanvasImageSource} */
  let from = img;
  let fx = src.sx, fy = src.sy, fw = src.sw;
  for (const s of SIZES) {
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(from, fx, fy, fw, fw, 0, 0, s, s);
    out[String(s)] = await toBlob(c);
    from = c;
    fx = 0;
    fy = 0;
    fw = s;
  }
  return out;
}

/* ---------- 裁剪弹层 ---------- */

/** @type {HTMLDialogElement|null} */ let dlg = null;
/** @type {HTMLElement|null} */ let stage = null;
/** @type {HTMLImageElement|null} */ let pic = null;
/** @type {HTMLElement|null} */ let ring = null;
/** @type {HTMLButtonElement|null} */ let doneBtn = null;
/* 照片在舞台上的位置：左上角 (tx,ty)，缩放 k；取景框圆心 (cx,cy)、直径 d */
let tx = 0, ty = 0, k = 1, kMin = 1, cx = 0, cy = 0, d = 0;
let natW = 0, natH = 0;
/** @type {Map<number, {x:number, y:number}>} */
const pts = new Map();
/** @type {string} */ let objUrl = '';

function layout() {
  if (!stage || !ring) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  d = Math.round(Math.min(w - 48, h - 220, 360));
  cx = w / 2;
  cy = h / 2 - 20;
  ring.style.width = d + 'px';
  ring.style.height = d + 'px';
  ring.style.top = cy + 'px';
  kMin = d / Math.min(natW, natH);
}

/** 照片必须盖满取景框：限制缩放和位置 */
function clamp() {
  k = Math.min(Math.max(k, kMin), kMin * ZOOM_MAX);
  const l = cx - d / 2, t = cy - d / 2;
  tx = Math.min(tx, l);
  ty = Math.min(ty, t);
  tx = Math.max(tx, l + d - natW * k);
  ty = Math.max(ty, t + d - natH * k);
}

function paint() {
  clamp();
  if (pic) pic.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + k + ')';
}

/**
 * 以舞台上的点 (px,py) 为中心缩放到 k2。
 * @param {number} k2 @param {number} px @param {number} py
 */
function zoomAt(k2, px, py) {
  const kk = Math.min(Math.max(k2, kMin), kMin * ZOOM_MAX);
  tx = px - ((px - tx) * kk) / k;
  ty = py - ((py - ty) * kk) / k;
  k = kk;
  paint();
}

/** 两指的中点和距离 */
function pinch() {
  const a = Array.from(pts.values());
  return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
}

function closeCrop() {
  if (dlg && dlg.open) dlg.close();
  pts.clear();
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = '';
}

function ensureDialog() {
  if (dlg) return;
  dlg = document.createElement('dialog');
  dlg.className = 'sgx-avc';
  dlg.setAttribute('aria-label', TXT.crop);
  dlg.innerHTML =
    '<div class="sgx-avc-stage"><img class="sgx-avc-img" alt=""><div class="sgx-avc-ring"></div></div>' +
    '<div class="sgx-avc-title">' + TXT.crop + '</div>' +
    '<div class="sgx-avc-bar"><button type="button" class="sgx-avc-btn" data-avc-cancel>' + TXT.cancel +
    '</button><button type="button" class="sgx-avc-btn primary" data-avc-done>' + TXT.done + '</button></div>';
  document.body.appendChild(dlg);
  stage = /** @type {HTMLElement} */ (dlg.querySelector('.sgx-avc-stage'));
  pic = /** @type {HTMLImageElement} */ (dlg.querySelector('.sgx-avc-img'));
  ring = /** @type {HTMLElement} */ (dlg.querySelector('.sgx-avc-ring'));
  doneBtn = /** @type {HTMLButtonElement} */ (dlg.querySelector('[data-avc-done]'));
  const st = stage;

  on(/** @type {Element} */ (dlg.querySelector('[data-avc-cancel]')), 'click', closeCrop);
  on(doneBtn, 'click', save);
  /* 系统返回 / Esc：当作取消 */
  on(dlg, 'cancel', function (e) {
    e.preventDefault();
    closeCrop();
  });

  on(st, 'pointerdown', function (/** @type {PointerEvent} */ e) {
    st.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  on(st, 'pointermove', function (/** @type {PointerEvent} */ e) {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    if (pts.size === 1) {
      tx += e.clientX - prev.x;
      ty += e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      paint();
      return;
    }
    if (pts.size === 2) {
      const before = pinch();
      prev.x = e.clientX;
      prev.y = e.clientY;
      const after = pinch();
      /* 跟着两指中点平移，再按距离比例缩放 */
      tx += after.x - before.x;
      ty += after.y - before.y;
      if (before.dist > 0) zoomAt((k * after.dist) / before.dist, after.x, after.y);
      else paint();
    }
  });
  const up = function (/** @type {PointerEvent} */ e) {
    pts.delete(e.pointerId);
  };
  on(st, 'pointerup', up);
  on(st, 'pointercancel', up);
  on(
    st,
    'wheel',
    function (/** @type {WheelEvent} */ e) {
      e.preventDefault();
      const r = st.getBoundingClientRect();
      zoomAt(k * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false }
  );
  on(window, 'resize', function () {
    if (!dlg || !dlg.open) return;
    layout();
    paint();
  });
}

/** @param {File} file */
function openCrop(file) {
  ensureDialog();
  if (!dlg || !pic) return;
  const d_ = dlg, p = pic;
  objUrl = URL.createObjectURL(file);
  p.onload = function () {
    natW = p.naturalWidth;
    natH = p.naturalHeight;
    if (!natW || !natH) {
      closeCrop();
      toast(TXT.badFile);
      return;
    }
    p.style.width = natW + 'px';
    p.style.height = natH + 'px';
    if (!d_.open) d_.showModal();
    layout();
    k = kMin;
    tx = cx - (natW * k) / 2;
    ty = cy - (natH * k) / 2;
    paint();
    if (doneBtn) doneBtn.disabled = false;
  };
  p.onerror = function () {
    closeCrop();
    toast(TXT.badFile);
  };
  p.src = objUrl;
}

async function save() {
  if (!pic || !doneBtn) return;
  doneBtn.disabled = true;
  try {
    const src = { sx: (cx - d / 2 - tx) / k, sy: (cy - d / 2 - ty) / k, sw: d / k };
    const blobs = await renderSizes(pic, src);
    const fd = new FormData();
    for (const s of SIZES) fd.append(String(s), blobs[String(s)], s + (blobs[String(s)].type === 'image/png' ? '.png' : '.webp'));
    const r = await fetch('/api/avatar', { method: 'PUT', body: fd, credentials: 'same-origin' });
    const j = await r.json().catch(function () {
      return {};
    });
    if (!r.ok || !j.ok) throw new Error(j.error || String(r.status));
    await refreshAvatars(j.ver || String(Date.now()));
    custom = true;
    closeCrop();
    toast(TXT.saved);
  } catch (e) {
    doneBtn.disabled = false;
    toast(TXT.failed);
  }
}

async function removeAvatar() {
  try {
    const r = await fetch('/api/avatar', { method: 'DELETE', credentials: 'same-origin' });
    const j = await r.json().catch(function () {
      return {};
    });
    if (!r.ok || !j.ok) throw new Error(j.error || String(r.status));
    await refreshAvatars('d' + Date.now());
    custom = false;
    toast(TXT.removed);
  } catch (e) {
    toast(TXT.failed);
  }
}

/* ---------- 入口 ---------- */

/** 绑定账户卡头像按钮（设置页可能有手机、宽屏两个账户卡）。只有管理员会话启用。 */
export function initAvatarEdit() {
  if (document.documentElement.getAttribute('data-sgx-role') !== 'admin') return;
  const btns = document.querySelectorAll('[data-avatar-edit]');
  if (!btns.length) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  document.body.appendChild(input);
  on(input, 'change', function () {
    const f = input.files && input.files[0];
    input.value = '';
    if (f) openCrop(f);
  });
  hasCustom().then(function (v) {
    custom = v;
  });
  btns.forEach(function (b) {
    /** @type {HTMLButtonElement} */ (b).disabled = false;
    on(b, 'click', function () {
      openSheet({
        title: TXT.title,
        options: [{ label: TXT.pick, value: 'pick' }].concat(custom ? [{ label: TXT.remove, value: 'remove' }] : []),
        onPick: function (v) {
          if (v === 'pick') input.click();
          else if (v === 'remove') removeAvatar();
        },
      });
    });
  });
}
