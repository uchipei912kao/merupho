// メルフォト: 撮った写真をメルカリ用に加工（正方形1080px・明るさと色の自動補正・軽いシャープ・背景の差し替え）。
// 写真は端末の中だけで処理する。外部への送信はしない（背景の切り抜きAIは初回にモデルを読み込むだけで、写真は送らない）。
(() => {
  'use strict';
  const MAX = 20;            // メルカリの写真の上限
  const OUT = 1080;          // 出力サイズ（正方形）
  const WORK = 1600;         // 作業用キャンバスの長辺（iOSのキャンバス上限対策。原寸では描かない）
  const FILL = 0.92;        // 背景を差し替えたときに商品が占める大きさ（長い辺）
  const RB_URL = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';
  const BG = {               // 背景の種類（white は塗りつぶし、ほかは画像）
    none: null, white: '#FFFFFF', marble: 'bg-marble.jpg', brick: 'bg-brick.jpg', wood: 'bg-wood.jpg', gray: 'bg-gray.jpg'
  };
  const $ = (id) => document.getElementById(id);
  const items = [];          // {id, file, blob, url, busy, mask}
  const opts = { shape: 'crop', tone: 'auto', bg: 'none', angle: 'auto' };
  let seq = 0;

  try { const s = JSON.parse(localStorage.getItem('merupho-opts') || '{}'); ['shape', 'tone', 'bg', 'angle'].forEach((k) => { if (s[k]) opts[k] = s[k]; }); } catch (e) {}
  if (!(opts.bg in BG)) opts.bg = 'none';

  // ---------- 画像の読み込み ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      img.src = src;   // <img> は写真の向き(EXIF)を自動で反映する
    });
  }
  async function workCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const sc = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, w, h);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
  const textures = {};
  async function texture(key) {
    if (!textures[key]) textures[key] = loadImage(BG[key]);
    return textures[key];
  }

  // ---------- 明るさ・色の補正 ----------
  function toneCorrect(d, strong) {
    const n = d.length, step = 16;              // 4画素に1つだけ見て統計を取る
    const lumHist = new Uint32Array(256);
    let cnt = 0;
    for (let i = 0; i < n; i += step) { const L = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; lumHist[L]++; cnt++; }
    const pct = (h, p) => { let acc = 0, t = cnt * p; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= t) return v; } return 255; };
    const lo = pct(lumHist, 0.01), hi = pct(lumHist, 0.99);
    // 1) ホワイトバランス: 明るい上位1%の平均色がほぼ無彩色のときだけ合わせる（赤い箱などが灰色にならないように）
    let r = 0, g = 0, b = 0, k = 0;
    for (let i = 0; i < n; i += step) { const L = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; if (L >= hi) { r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; } }
    let wb = [1, 1, 1];
    if (k > 0) {
      r /= k; g /= k; b /= k;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mn > 60 && mx / mn < 1.25) wb = [r, g, b].map((c) => Math.min(1.2, Math.max(0.85, mx / c)));
    }
    // 2) レベル補正（全チャンネル共通・伸ばしすぎない）
    const gain = Math.min(strong ? 1.6 : 1.35, 255 / Math.max(1, hi - lo));
    // 3) 明るさ: 平均が暗いときだけ持ち上げる（ガンマ）
    let sum = 0; for (let v = 0; v < 256; v++) sum += lumHist[v] * Math.min(255, Math.max(0, (v - lo) * gain));
    const mean = Math.max(1, sum / cnt), target = strong ? 160 : 145;
    let gamma = mean < target ? Math.log(target / 255) / Math.log(mean / 255) : 1;
    gamma = Math.max(strong ? 0.65 : 0.75, Math.min(1, gamma));
    const lut = [0, 1, 2].map((c) => {
      const t = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) { let x = Math.min(255, v * wb[c]); x = Math.min(255, Math.max(0, (x - lo) * gain)); t[v] = 255 * Math.pow(x / 255, gamma); }
      return t;
    });
    // 4) 少しだけ鮮やかに＋元の画像と混ぜて自然に
    const sat = strong ? 1.15 : 1.08, mix = strong ? 0.9 : 0.85;
    for (let i = 0; i < n; i += 4) {
      let R = lut[0][d[i]], G = lut[1][d[i + 1]], B = lut[2][d[i + 2]];
      const L = R * 0.299 + G * 0.587 + B * 0.114;
      R = L + (R - L) * sat; G = L + (G - L) * sat; B = L + (B - L) * sat;
      d[i] = d[i] * (1 - mix) + R * mix; d[i + 1] = d[i + 1] * (1 - mix) + G * mix; d[i + 2] = d[i + 2] * (1 - mix) + B * mix;
    }
  }

  // 背景を差し替えるときの補正: 切り抜いた商品だけを見て明るさと色を決める。
  // 背景（白い布や紙）が写っていれば、それを照明の色・明るさの基準にして白に合わせる。商品の色は描き変えない。
  function productTone(d, a, strong) {
    const n = a.length, step = 3;
    const lum = (i) => (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    const pct = (h, cnt, p) => { let acc = 0, t = cnt * p; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= t) return v; } return 255; };
    // 1) 背景の明るい側（中央値〜98%）の平均色
    const bh = new Uint32Array(256); let bc = 0;
    for (let p = 0; p < n; p += step) if (a[p] < 8) { bh[lum(p * 4)]++; bc++; }
    let wb = [1, 1, 1], gain = 1, fromBg = false;
    if (bc > n / step * 0.03) {
      const lo = pct(bh, bc, 0.5), hi = pct(bh, bc, 0.98);
      let r = 0, g = 0, b = 0, k = 0;
      for (let p = 0; p < n; p += step) if (a[p] < 8) { const i = p * 4, L = lum(i); if (L >= lo && L <= hi) { r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; } }
      if (k) {
        r /= k; g /= k; b /= k; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mn > 90 && mx / mn < 1.3) {   // 白っぽい無地の背景 → 照明の基準にできる
          wb = [r, g, b].map((c) => Math.min(1.25, Math.max(0.8, mx / c)));
          gain = Math.min(strong ? 1.7 : 1.6, Math.max(1, 246 / mx)); fromBg = true;
        }
      }
    }
    // 2) 商品の明るさの分布
    const ph = new Uint32Array(256); let pc = 0;
    for (let p = 0; p < n; p += step) if (a[p] > 200) { const i = p * 4; ph[Math.min(255, Math.round(((d[i] * wb[0]) * 0.299 + (d[i + 1] * wb[1]) * 0.587 + (d[i + 2] * wb[2]) * 0.114) * gain))]++; pc++; }
    if (!pc) return false;
    const g1 = fromBg ? 1 : Math.min(strong ? 1.5 : 1.35, Math.max(1, 245 / Math.max(1, pct(ph, pc, 0.99))));
    gain *= g1;
    // 3) 黒を締める: 商品のいちばん暗いところが浮いていたら下げる（フィルムの反射などの白いもやを取る）
    const bp = Math.min(40, Math.max(0, Math.min(255, pct(ph, pc, 0.005) * g1) - 8));
    let mean = 0; for (let v = 0; v < 256; v++) mean += ph[v] * Math.min(255, v * g1); mean = Math.max(1, (mean / pc - bp) / (255 - bp) * 255);
    // 4) 中間の明るさを持ち上げる（暗い商品を灰色にしないよう上限つき）
    const target = strong ? 178 : 170;
    let gamma = mean < target ? Math.log(target / 255) / Math.log(mean / 255) : 1;
    gamma = Math.max(strong ? 0.72 : 0.76, Math.min(1, gamma));
    const knee = 0.82;   // 明るいところは白飛びさせずに丸める
    const lut = [0, 1, 2].map((c) => {
      const t = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        let x = Math.max(0, v * wb[c] * gain - bp) / (255 - bp);
        if (x > knee) x = knee + (1 - knee) * (1 - Math.exp(-(x - knee) / (1 - knee)));
        t[v] = 255 * Math.pow(Math.min(1, x), gamma);
      }
      return t;
    });
    // 5) くすんだ色ほど鮮やかに（もともと鮮やかな色と、白・グレー・黒はそのまま）
    const vib = strong ? 1.3 : 0.8;
    for (let i = 0; i < d.length; i += 4) {
      let R = lut[0][d[i]], G = lut[1][d[i + 1]], B = lut[2][d[i + 2]];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), s = mx ? (mx - mn) / mx : 0, f = 1 + vib * (1 - s) * Math.min(1, s * 6);
      const L = R * 0.299 + G * 0.587 + B * 0.114;
      d[i] = L + (R - L) * f; d[i + 1] = L + (G - L) * f; d[i + 2] = L + (B - L) * f;
    }
    return true;
  }

  // メリハリ: 大きめのぼかしとの差を足して、文字や模様をくっきりさせる（明るさだけに効かせて色ズレを防ぐ）
  function clarity(d, w, h, amount) {
    const r = Math.max(2, Math.round(Math.max(w, h) / 120)), L = new Float32Array(w * h), T = new Float32Array(w * h);
    for (let p = 0, i = 0; p < L.length; p++, i += 4) L[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const blur = (src, dst, len, cnt, stride, lineStride) => {   // 1方向の箱ぼかし（累積和）
      for (let l = 0; l < cnt; l++) {
        const base = l * lineStride; let acc = 0;
        for (let k = -r; k <= r; k++) acc += src[base + Math.min(len - 1, Math.max(0, k)) * stride];
        for (let k = 0; k < len; k++) {
          dst[base + k * stride] = acc / (2 * r + 1);
          acc += src[base + Math.min(len - 1, k + r + 1) * stride] - src[base + Math.max(0, k - r) * stride];
        }
      }
    };
    blur(L, T, w, h, 1, w); const B = new Float32Array(w * h); blur(T, B, h, w, w, 1);
    for (let p = 0, i = 0; p < L.length; p++, i += 4) {
      const add = (L[p] - B[p]) * amount;
      d[i] += add; d[i + 1] += add; d[i + 2] += add;
    }
  }

  function sharpen(ctx, size, amount) {
    const im = ctx.getImageData(0, 0, size, size), s = im.data, src = new Uint8ClampedArray(s), w = size * 4;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * w + x * 4;
        for (let c = 0; c < 3; c++) {
          const j = i + c;
          const blur = (src[j - w - 4] + src[j - w] + src[j - w + 4] + src[j - 4] + src[j] + src[j + 4] + src[j + w - 4] + src[j + w] + src[j + w + 4]) / 9;
          s[j] = src[j] + (src[j] - blur) * amount;
        }
      }
    }
    ctx.putImageData(im, 0, 0);
  }

  // ---------- 背景の切り抜き（AI） ----------
  let rbPromise = null;
  function loadRemover() {
    if (!rbPromise) rbPromise = import(RB_URL).then((m) => m.removeBackground || m.default).catch((e) => { rbPromise = null; throw e; });
    return rbPromise;
  }
  function status(msg) { const s = $('status'); s.textContent = msg || ''; s.hidden = !msg; }

  async function getMask(it, work) {
    if (it.mask && it.mask.w === work.width && it.mask.h === work.height) return it.mask;
    status('背景を切り抜くAIを準備中…（初回だけ約40MB・Wi-Fi推奨）');
    const remove = await loadRemover();
    const input = await new Promise((res) => work.toBlob(res, 'image/jpeg', 0.95));
    const fg = await remove(input, {
      model: 'isnet_quint8', device: 'cpu', output: { format: 'image/png', type: 'foreground' },
      progress: (key, cur, total) => { if (total) status('背景を切り抜くAIを準備中… ' + Math.round(cur / total * 100) + '%（初回だけ）'); }
    });
    status('背景を切り抜き中…');
    const url = URL.createObjectURL(fg);
    try {
      const img = await loadImage(url);
      const c = document.createElement('canvas'); c.width = work.width; c.height = work.height;
      const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, c.width, c.height);
      const d = cx.getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
      c.width = c.height = 0;
      it.mask = { w: work.width, h: work.height, a };
      return it.mask;
    } finally { URL.revokeObjectURL(url); }
  }

  // ---------- 角度の補正（切り抜いた輪郭を使う） ----------
  // 輪郭の凸包 → 最小の外接長方形で傾きを出す。箱のような四角い商品は台形のゆがみも直す（ホモグラフィ）。
  function hullOf(mask) {
    const { w, h, a } = mask, st = Math.max(1, Math.ceil(Math.max(w, h) / 500)), pts = [];
    for (let y = 0; y < h; y += st) {
      let l = -1, r = -1;
      for (let x = 0; x < w; x += st) if (a[y * w + x] > 128) { if (l < 0) l = x; r = x; }
      if (l >= 0) { pts.push([l, y]); if (r !== l) pts.push([r, y]); }
    }
    if (pts.length < 3) return null;
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop(); return lo.concat(up);
  }
  const polyArea = (P) => { let s = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s) / 2; };
  function minRectAngle(hull) {
    let best = { area: Infinity, ang: 0 };
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length];
      const ang = Math.atan2(q[1] - p[1], q[0] - p[0]), c = Math.cos(-ang), s = Math.sin(-ang);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of hull) { const rx = x * c - y * s, ry = x * s + y * c; if (rx < x0) x0 = rx; if (rx > x1) x1 = rx; if (ry < y0) y0 = ry; if (ry > y1) y1 = ry; }
      const area = (x1 - x0) * (y1 - y0);
      if (area < best.area) best = { area, ang };
    }
    let a = best.ang; while (a > Math.PI / 4) a -= Math.PI / 2; while (a <= -Math.PI / 4) a += Math.PI / 2;   // -45°〜45°に
    return { ang: a, area: best.area };
  }
  function solveHomography(src, dst) {   // dst(長方形) → src(写真の四角) への変換
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = dst[i], [x, y] = src[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    for (let c = 0; c < 8; c++) {   // ガウスの消去法
      let m = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
      [A[c], A[m]] = [A[m], A[c]]; [b[c], b[m]] = [b[m], b[c]];
      if (Math.abs(A[c][c]) < 1e-9) return null;
      for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
    }
    return b.map((v, i) => v / A[i][i]);
  }
  function invert3(m) {   // 3x3 行列（9要素・最後は1）の逆行列
    const [a, b, c, d, e, f, g, h, i] = [...m, 1];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
    return r.map((v) => v / r[8]);
  }
  function warpQuad(pc, quad, W, H, hull) {
    const Hm = solveHomography(quad, [[0, 0], [W, 0], [W, H], [0, H]]); if (!Hm) return null;
    // 四隅の外にはみ出した部分（袋の丸みなど）も切れないように、輪郭全体が入る大きさで変換する
    const inv = invert3(Hm); let u0 = 0, v0 = 0, u1 = W, v1 = H;
    if (inv) for (const [x, y] of hull) { const den = inv[6] * x + inv[7] * y + inv[8], u = (inv[0] * x + inv[1] * y + inv[2]) / den, v = (inv[3] * x + inv[4] * y + inv[5]) / den; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    u0 = Math.floor(u0) - 2; v0 = Math.floor(v0) - 2; const OW = Math.ceil(u1) + 2 - u0, OH = Math.ceil(v1) + 2 - v0;
    if (OW * OH > 8e6) return null;
    const sw = pc.width, sh = pc.height, sd = pc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas'); out.width = OW; out.height = OH;
    const ox = out.getContext('2d', { willReadFrequently: true }), od = ox.createImageData(OW, OH), d = od.data;
    for (let vv = 0; vv < OH; vv++) for (let uu = 0; uu < OW; uu++) {
      const u = uu + u0, v = vv + v0;
      const den = Hm[6] * u + Hm[7] * v + 1, x = (Hm[0] * u + Hm[1] * v + Hm[2]) / den, y = (Hm[3] * u + Hm[4] * v + Hm[5]) / den;
      const x0 = Math.floor(x), y0 = Math.floor(y); if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) continue;
      const fx = x - x0, fy = y - y0, i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, o = (vv * OW + uu) * 4;
      for (let c = 0; c < 4; c++) d[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
    }
    ox.putImageData(od, 0, 0); return out;
  }
  function rotateCanvas(pc, ang) {
    const c = Math.abs(Math.cos(ang)), s = Math.abs(Math.sin(ang)), W = Math.ceil(pc.width * c + pc.height * s), H = Math.ceil(pc.width * s + pc.height * c);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const ox = out.getContext('2d', { willReadFrequently: true }); ox.imageSmoothingQuality = 'high';
    ox.translate(W / 2, H / 2); ox.rotate(-ang); ox.drawImage(pc, -pc.width / 2, -pc.height / 2); return out;
  }
  // 戻り値: 補正後のキャンバス（補正しない時は null）
  function straighten(pc, mask) {
    const hull = hullOf(mask); if (!hull || hull.length < 4) return null;
    const { ang, area: rectArea } = minRectAngle(hull);
    const deg = Math.abs(ang * 180 / Math.PI);
    let on = 0; for (let i = 0; i < mask.a.length; i++) if (mask.a[i] > 128) on++;
    // 四隅: 傾きを戻した座標で、x+y / x−y が最大・最小の点
    const c = Math.cos(-ang), s = Math.sin(-ang), R = hull.map(([x, y]) => [x * c - y * s, x * s + y * c, x, y]);
    const pick = (f) => R.reduce((m, p) => (f(p) > f(m) ? p : m));
    const tl = pick((p) => -(p[0] + p[1])), tr = pick((p) => p[0] - p[1]), br = pick((p) => p[0] + p[1]), bl = pick((p) => p[1] - p[0]);
    const quad = [tl, tr, br, bl].map((p) => [p[2], p[3]]);
    const qa = polyArea(quad);
    const boxy = on / qa > 0.92 && qa / rectArea > 0.85 && qa / polyArea(hull) > 0.93;   // 箱のように四角い
    if (boxy) {
      const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      const W = Math.round((dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2), H = Math.round((dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2);
      const skew = Math.abs(dist(quad[0], quad[1]) - dist(quad[3], quad[2])) / W + Math.abs(dist(quad[0], quad[3]) - dist(quad[1], quad[2])) / H;
      if ((deg > 0.7 || skew > 0.02) && W > 20 && H > 20 && W * H < 6e6) { const out = warpQuad(pc, quad, W, H, hull); if (out) return out; }
    }
    if (deg > 0.7 && deg < 25) return rotateCanvas(pc, ang);   // 四角くない商品は傾きだけ
    return null;
  }
  function alphaBox(cv) {
    const w = cv.width, h = cv.height, d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function bbox(mask) {
    const { w, h, a } = mask; let x0 = w, y0 = h, x1 = -1, y1 = -1, on = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x] > 24) { on++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const ratio = on / (w * h);
    if (x1 < 0 || ratio < 0.01 || ratio > 0.97) return null;   // 切り抜きに失敗したとみなす
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  async function composeOnBackground(work, mask, bgKey, fixAngle) {
    let box = bbox(mask); if (!box) return null;
    const w = work.width, h = work.height;
    let pc = document.createElement('canvas'); pc.width = w; pc.height = h;
    const px = pc.getContext('2d', { willReadFrequently: true }); px.drawImage(work, 0, 0);
    const id = px.getImageData(0, 0, w, h); for (let i = 0; i < mask.a.length; i++) id.data[i * 4 + 3] = mask.a[i];
    px.putImageData(id, 0, 0);
    if (fixAngle) {
      const fixed = straighten(pc, mask);
      if (fixed) { const b2 = alphaBox(fixed); if (b2) { pc.width = pc.height = 0; pc = fixed; box = b2; } }
    }
    const out = document.createElement('canvas'); out.width = OUT; out.height = OUT;
    const ox = out.getContext('2d', { willReadFrequently: true }); ox.imageSmoothingQuality = 'high';
    if (bgKey === 'white') { ox.fillStyle = '#FFFFFF'; ox.fillRect(0, 0, OUT, OUT); }
    else { const t = await texture(bgKey); ox.drawImage(t, 0, 0, OUT, OUT); }
    const k = Math.min(OUT * FILL / box.w, OUT * FILL / box.h), dw = box.w * k, dh = box.h * k;
    const dx = (OUT - dw) / 2, dy = (OUT - dh) / 2 + OUT * 0.02;
    ox.save();
    ox.shadowColor = bgKey === 'white' ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.30)';
    ox.shadowBlur = 36; ox.shadowOffsetY = 18;                 // 商品の下にやわらかい影
    ox.drawImage(pc, box.x, box.y, box.w, box.h, dx, dy, dw, dh);
    ox.restore();
    pc.width = pc.height = 0;
    return out;
  }

  // ---------- 1枚の加工 ----------
  async function processItem(it, o) {
    const work = await workCanvas(it.file);
    const original = o.bg !== 'none' ? (() => { const c = document.createElement('canvas'); c.width = work.width; c.height = work.height; c.getContext('2d').drawImage(work, 0, 0); return c; })() : null;
    try {
      const cx = work.getContext('2d', { willReadFrequently: true });
      const strong = o.tone === 'strong';
      let out = null, mask = null, failed = false;
      if (o.bg !== 'none') {
        try { mask = await getMask(it, original); }
        catch (e) { console.error(e); failed = true; toast('背景の切り抜きに失敗しました（電波を確認してください）'); }
      }
      if (o.tone !== 'none') {
        const id = cx.getImageData(0, 0, work.width, work.height);
        // 背景を差し替えるときは商品だけを基準に補正、それ以外は写真全体で補正
        if (mask && bbox(mask) && productTone(id.data, mask.a, strong)) clarity(id.data, work.width, work.height, strong ? 0.45 : 0.3);
        else toneCorrect(id.data, strong);
        cx.putImageData(id, 0, 0);
      }
      if (mask) {
        out = await composeOnBackground(work, mask, o.bg, o.angle !== 'off');
        if (!out && !failed) toast((items.indexOf(it) + 1) + '枚目は商品をうまく切り抜けなかったので、背景はそのままにしました');
      }
      if (!out) {
        out = document.createElement('canvas'); out.width = OUT; out.height = OUT;
        const ox = out.getContext('2d', { willReadFrequently: true });
        ox.fillStyle = '#FFFFFF'; ox.fillRect(0, 0, OUT, OUT); ox.imageSmoothingQuality = 'high';
        const w = work.width, h = work.height;
        if (o.shape === 'crop') { const side = Math.min(w, h); ox.drawImage(work, (w - side) / 2, (h - side) / 2, side, side, 0, 0, OUT, OUT); }
        else { const k = OUT / Math.max(w, h), dw = w * k, dh = h * k; ox.drawImage(work, (OUT - dw) / 2, (OUT - dh) / 2, dw, dh); }
      }
      if (o.tone !== 'none') sharpen(out.getContext('2d', { willReadFrequently: true }), OUT, o.tone === 'strong' ? 0.5 : 0.35);
      return await new Promise((res) => out.toBlob((b) => { out.width = out.height = 0; res(b); }, 'image/jpeg', 0.9));
    } finally { work.width = work.height = 0; if (original) original.width = original.height = 0; }
  }

  // ---------- 画面 ----------
  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }

  function render() {
    const grid = $('grid');
    grid.innerHTML = '';
    items.forEach((it, i) => {
      const tile = document.createElement('div'); tile.className = 'tile' + (it.busy ? ' busy' : '');
      if (it.url) { const im = document.createElement('img'); im.src = it.url; im.alt = '加工済みの写真 ' + (i + 1); tile.appendChild(im); }
      const no = document.createElement('span'); no.className = 'no'; no.textContent = i + 1; tile.appendChild(no);
      if (i === 0) { const tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = '表紙'; tile.appendChild(tg); }
      const del = document.createElement('button'); del.className = 'del'; del.type = 'button'; del.setAttribute('aria-label', (i + 1) + '枚目を消す'); del.textContent = '×';
      del.onclick = () => removeItem(it.id); tile.appendChild(del);
      grid.appendChild(tile);
    });
    const ready = items.filter((x) => x.blob).length, busy = items.some((x) => x.busy);
    $('empty').hidden = items.length > 0;
    $('count').textContent = items.length + ' / ' + MAX + '枚';
    $('save').textContent = '写真を保存（' + ready + '枚）';
    $('save').disabled = ready === 0 || busy;
    if (!busy) status('');
    document.querySelector('.opt-shape').classList.toggle('off', opts.bg !== 'none');
    document.querySelector('.opt-angle').classList.toggle('off', opts.bg === 'none');
  }

  function removeItem(id) {
    const i = items.findIndex((x) => x.id === id); if (i < 0) return;
    if (items[i].url) URL.revokeObjectURL(items[i].url);
    items.splice(i, 1); render();
  }

  async function runItem(it) {
    it.busy = true; render();
    try {
      const blob = await processItem(it, { ...opts });
      if (it.url) URL.revokeObjectURL(it.url);
      it.blob = blob; it.url = URL.createObjectURL(blob);
    } catch (e) { console.error(e); toast(e.message || '加工に失敗しました'); }
    it.busy = false; render();
  }

  let running = Promise.resolve();
  function enqueue(list) { running = running.then(async () => { for (const it of list) if (items.includes(it)) await runItem(it); }); return running; }

  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
    if (!files.length) return Promise.resolve();
    const room = MAX - items.length;
    if (room <= 0) { toast('写真は20枚までです'); return Promise.resolve(); }
    if (files.length > room) toast('20枚までなので、' + room + '枚だけ追加しました');
    const added = files.slice(0, room).map((f) => ({ id: ++seq, file: f, blob: null, url: null, busy: true, mask: null }));
    items.push(...added); render();
    return enqueue(added);   // 1枚ずつ（メモリ節約）
  }

  function setOpt(key, val) {
    opts[key] = val;
    try { localStorage.setItem('merupho-opts', JSON.stringify(opts)); } catch (e) {}
    document.querySelectorAll('[data-' + key + ']').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[key] === val)));
    items.forEach((it) => { it.busy = true; });
    render();
    return enqueue(items.slice());   // 切り抜き結果は覚えているので、背景や明るさを変えても速い
  }

  async function saveAll() {
    const ready = items.filter((x) => x.blob);
    if (!ready.length) return;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const files = ready.map((x, i) => new File([x.blob], 'mercari_' + stamp + '_' + String(i + 1).padStart(2, '0') + '.jpg', { type: 'image/jpeg' }));
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files }); toast('保存できたら「メルカリを開く」へ'); }
      catch (e) { if (e && e.name !== 'AbortError') toast('共有できませんでした。写真を長押しして保存してください'); }
      return;
    }
    // 共有できないブラウザ（パソコンなど）はダウンロードで保存
    files.forEach((f) => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); });
    toast('ダウンロードしました');
  }

  $('cam').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('album').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('clear').addEventListener('click', () => { items.forEach((x) => x.url && URL.revokeObjectURL(x.url)); items.length = 0; render(); });
  $('save').addEventListener('click', saveAll);
  ['shape', 'tone', 'bg', 'angle'].forEach((key) => {
    document.querySelectorAll('[data-' + key + ']').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset[key] === opts[key]));
      b.addEventListener('click', () => { if (opts[key] !== b.dataset[key]) setOpt(key, b.dataset[key]); });
    });
  });
  window.__merupho = { addFiles, items, opts, setOpt, idle: () => running };   // 動作確認用
  render();
})();
