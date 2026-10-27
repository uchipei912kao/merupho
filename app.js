// メルフォト: 撮った写真をメルカリ用に加工（正方形1080px・明るさと色の自動補正・軽いシャープ）。
// 写真は端末の中だけで処理する。fetch や送信は一切しない。
(() => {
  'use strict';
  const MAX = 20;            // メルカリの写真の上限
  const OUT = 1080;          // 出力サイズ（正方形）
  const WORK = 2000;         // 作業用キャンバスの長辺（iOSのキャンバス上限対策。原寸では描かない）
  const $ = (id) => document.getElementById(id);
  const items = [];          // {id, file, blob, url, busy}
  const opts = { shape: 'crop', tone: 'auto' };
  let seq = 0;

  try { const s = JSON.parse(localStorage.getItem('merupho-opts') || '{}'); if (s.shape) opts.shape = s.shape; if (s.tone) opts.tone = s.tone; } catch (e) {}

  // ---------- 画像処理 ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;   // <img> は写真の向き(EXIF)を自動で反映する
    });
  }

  function toneCorrect(d, strong) {
    const n = d.length, step = 16;              // 4画素に1つだけ見て統計を取る
    const lumHist = new Uint32Array(256);
    let cnt = 0;
    for (let i = 0; i < n; i += step) { const L = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; lumHist[L]++; cnt++; }
    const pct = (h, p) => { let acc = 0, t = cnt * p; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= t) return v; } return 255; };
    const lo = pct(lumHist, 0.01), hi = pct(lumHist, 0.99);
    // 1) ホワイトバランス: 明るい上位1%の平均色がほぼ無彩色のときだけ合わせる（赤い箱などが灰色にならないように）
    let r = 0, g = 0, b = 0, k = 0;
    const thr = pct(lumHist, 0.99);
    for (let i = 0; i < n; i += step) { const L = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; if (L >= thr) { r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; } }
    let wb = [1, 1, 1];
    if (k > 0) {
      r /= k; g /= k; b /= k;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mn > 60 && mx / mn < 1.25) wb = [r, g, b].map((c) => Math.min(1.2, Math.max(0.85, mx / c)));
    }
    // 2) レベル補正（全チャンネル共通・伸ばしすぎない）
    const cap = strong ? 1.6 : 1.35;
    const gain = Math.min(cap, 255 / Math.max(1, hi - lo));
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

  async function processFile(file, o) {
    const { img, url } = await loadImage(file);
    try {
      const sc = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, w, h);
      if (o.tone !== 'none') { const id = cx.getImageData(0, 0, w, h); toneCorrect(id.data, o.tone === 'strong'); cx.putImageData(id, 0, 0); }
      const out = document.createElement('canvas'); out.width = OUT; out.height = OUT;
      const ox = out.getContext('2d', { willReadFrequently: true });
      ox.fillStyle = '#FFFFFF'; ox.fillRect(0, 0, OUT, OUT); ox.imageSmoothingQuality = 'high';
      if (o.shape === 'crop') { const side = Math.min(w, h); ox.drawImage(c, (w - side) / 2, (h - side) / 2, side, side, 0, 0, OUT, OUT); }
      else { const k = OUT / Math.max(w, h), dw = w * k, dh = h * k; ox.drawImage(c, (OUT - dw) / 2, (OUT - dh) / 2, dw, dh); }
      if (o.tone !== 'none') sharpen(ox, OUT, o.tone === 'strong' ? 0.5 : 0.35);
      c.width = c.height = 0;   // メモリ解放
      return await new Promise((res) => out.toBlob((b) => { out.width = out.height = 0; res(b); }, 'image/jpeg', 0.9));
    } finally { URL.revokeObjectURL(url); }
  }

  // ---------- 画面 ----------
  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200); }

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
    const ready = items.filter((x) => x.blob).length;
    $('empty').hidden = items.length > 0;
    $('count').textContent = items.length + ' / ' + MAX + '枚';
    $('save').textContent = '写真を保存（' + ready + '枚）';
    $('save').disabled = ready === 0 || items.some((x) => x.busy);
  }

  function removeItem(id) {
    const i = items.findIndex((x) => x.id === id); if (i < 0) return;
    if (items[i].url) URL.revokeObjectURL(items[i].url);
    items.splice(i, 1); render();
  }

  async function runItem(it) {
    it.busy = true; render();
    try {
      const blob = await processFile(it.file, opts);
      if (it.url) URL.revokeObjectURL(it.url);
      it.blob = blob; it.url = URL.createObjectURL(blob);
    } catch (e) { toast(e.message || '加工に失敗しました'); }
    it.busy = false; render();
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
    if (!files.length) return;
    const room = MAX - items.length;
    if (room <= 0) { toast('写真は20枚までです'); return; }
    if (files.length > room) toast('20枚までなので、' + room + '枚だけ追加しました');
    const added = files.slice(0, room).map((f) => ({ id: ++seq, file: f, blob: null, url: null, busy: true }));
    items.push(...added); render();
    for (const it of added) await runItem(it);   // 1枚ずつ（メモリ節約）
  }

  async function reprocessAll() { for (const it of items) await runItem(it); }

  function setOpt(key, val) {
    opts[key] = val;
    try { localStorage.setItem('merupho-opts', JSON.stringify(opts)); } catch (e) {}
    document.querySelectorAll('[data-' + key + ']').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[key] === val)));
    reprocessAll();
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
  document.querySelectorAll('[data-shape]').forEach((b) => b.addEventListener('click', () => setOpt('shape', b.dataset.shape)));
  document.querySelectorAll('[data-tone]').forEach((b) => b.addEventListener('click', () => setOpt('tone', b.dataset.tone)));
  document.querySelectorAll('[data-shape]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.shape === opts.shape)));
  document.querySelectorAll('[data-tone]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tone === opts.tone)));
  window.__merupho = { addFiles, items, opts };   // 動作確認用
  render();
})();
