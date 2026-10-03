/*
  sketch.js — riso separator
  p5.js 1.x (global mode) + p5.riso.
  Splits an image into riso ink layers, previews the overprint with MULTIPLY
  and exports 300 dpi print masters (PDF / PNG).
*/

// ── CONSTANTS ───────────────────────────────────

const PAGE_MM = { A4: [210, 297], A3: [297, 420] }; // portrait
const PRINTABLE_MM = { A4: [190, 277], A3: [280, 400] }; // portrait, centred
const EXPORT_PX = { A4: [2480, 3508], A3: [3508, 4961] }; // 300 dpi, portrait
const EXPORT_DPI = 300;

const PREVIEW_LONG = 940; // preview canvas long side (keeps the image area under ~900 px)
const MAX_PREVIEW_IMG = 900; // max long side of the preview working image
const MAX_LAYERS = 4;
const DEFAULT_ANGLES = [15, 75, 0, 45];
const CMYK_CHANNELS = ["c", "m", "y", "k"];
const RGB_CHANNELS = ["r", "g", "b"];
const DEBOUNCE_MS = 200;
const GUIDE_COLOR = "#D0CCC4";

// Pipeline stages, cheapest first. Running a stage also runs every cheaper one.
const STAGE = { COMPOSITE: 0, PAINT: 1, SCREEN: 2, REBUILD: 3 };

// ── STATE ───────────────────────────────────────

const state = {
  workshop: "aoi",
  mode: "auto", // auto | cmyk | rgb
  format: "A4",
  orientation: "portrait", // portrait | landscape
  layers: [],
  // Global screening settings (layers may override them, except the angle which is always per layer)
  screen: {
    style: "continuous", // continuous | halftone | dither
    shape: "circle",
    frequency: 4, // halftone cell size, in preview pixels
    ditherType: "atkinson",
    threshold: 128,
  },
  scope: "global", // "global" or the uid of the layer being edited in TRAMA
};

let uidCounter = 0;
let srcImg = null; // full-resolution source image
let srcInfo = null; // { name, w, h }
let work = null; // preview working image + placement: { img, rect, pxScale }
let inkMaps = []; // per layer ink coverage at preview size (Uint8ClampedArray, 255 = full ink)
let screenedImgs = []; // per layer screened greyscale p5.Image (black = ink)
let busy = false; // an export is running

let pendingStage = -1;
let pendingTimer = null;

// ── CANVAS + LIBRARY PATCHES ────────────────────

// Separation reads pixels back from canvases constantly (p5.Image.loadPixels,
// Riso.image, getImageData at 300 dpi). Opt every 2D context into
// willReadFrequently: faster readbacks and no Chrome console warnings.
const nativeGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, options) {
  if (type === "2d") options = Object.assign({ willReadFrequently: true }, options);
  return nativeGetContext.call(this, type, options);
};


// p5.riso caches lookups with searchColor.join(""), so e.g. [1,23,4] and
// [12,3,4] collide. Use a numeric key instead (also much faster on big images).
RisoChannelMapper.prototype.findClosestColor = function (searchColor) {
  const key = (searchColor[0] << 16) | (searchColor[1] << 8) | searchColor[2];
  if (!this._cache) this._cache = new Map();
  let found = this._cache.get(key);
  if (found) return found;
  const toSearch = this.perceptual ? this.rgbToLab(searchColor) : searchColor;
  found = this.tree.nearestNeighbor([toSearch, []]).best;
  this._cache.set(key, found);
  return found;
};

// ── P5 ──────────────────────────────────────────

function setup() {
  const [w, h] = previewSize();
  const cnv = createCanvas(w, h);
  pixelDensity(1);
  cnv.parent("canvas-wrapper");
  noLoop();

  addLayer();
  addLayer();
  rebuildRisoLayers();

  bindUI();
  syncUI();

  // Redraw the empty state once web fonts are available
  if (document.fonts) document.fonts.ready.then(() => redraw());
}

function draw() {
  background(255);

  if (srcImg && work) {
    // Equivalent to drawRiso(), but skipping hidden layers
    blendMode(MULTIPLY);
    state.layers.forEach((L, i) => {
      const ch = Riso.channels[i];
      if (L.visible && ch) image(ch, 0, 0);
    });
    blendMode(BLEND);
  } else {
    drawEmptyState();
  }

  drawPrintableGuide();
}

function drawEmptyState() {
  noStroke();
  textAlign(CENTER, CENTER);
  fill("#2A2A2A");
  textFont("Chakra Petch");
  textStyle(BOLD);
  textSize(Math.round(width * 0.075));
  text("riso separator", width / 2, height / 2 - 22);
  fill("#7A7670");
  textFont("JetBrains Mono");
  textStyle(NORMAL);
  textSize(12);
  text("arrastra una imagen aquí o usa [ cargar imagen ]", width / 2, height / 2 + 26);
}

// Preview-only guide: never part of an export
function drawPrintableGuide() {
  const r = printableRect(width, height);
  noFill();
  stroke(GUIDE_COLOR);
  strokeWeight(1);
  rect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
}

// ── GEOMETRY ────────────────────────────────────

function orient([a, b]) {
  return state.orientation === "portrait" ? [a, b] : [b, a];
}

function pageMM() {
  return orient(PAGE_MM[state.format]);
}

function previewSize() {
  const [w, h] = pageMM();
  const k = PREVIEW_LONG / Math.max(w, h);
  return [Math.round(w * k), Math.round(h * k)];
}

function exportSize() {
  return orient(EXPORT_PX[state.format]);
}

// Printable area in pixels for a page of pw x ph pixels
function printableRect(pw, ph) {
  const [mw, mh] = pageMM();
  const [aw, ah] = orient(PRINTABLE_MM[state.format]);
  const sx = pw / mw;
  const sy = ph / mh;
  return { x: ((mw - aw) / 2) * sx, y: ((mh - ah) / 2) * sy, w: aw * sx, h: ah * sy };
}

// Fit (contain) an iw x ih image inside area, centred, in whole pixels
function containRect(area, iw, ih) {
  const s = Math.min(area.w / iw, area.h / ih);
  const w = Math.max(1, Math.round(iw * s));
  const h = Math.max(1, Math.round(ih * s));
  return {
    x: Math.round(area.x + (area.w - w) / 2),
    y: Math.round(area.y + (area.h - h) / 2),
    w,
    h,
  };
}

// ── INKS + LAYERS ───────────────────────────────

function currentWorkshop() {
  return WORKSHOPS[state.workshop];
}

function inkBySlug(slug, workshopKey = state.workshop) {
  const inks = WORKSHOPS[workshopKey].inks;
  return inks.find((k) => k.slug === slug) || inks[0];
}

function nextDefaultInk() {
  const ws = currentWorkshop();
  const used = new Set(state.layers.map((L) => L.ink));
  const free = ws.defaults.find((s) => !used.has(s)) || (ws.inks.find((k) => !used.has(k.slug)) || {}).slug;
  return free || ws.defaults[0];
}

function firstFree(values, used) {
  const found = values.find((v) => !used.includes(v));
  return found === undefined ? values[0] : found;
}

function addLayer() {
  if (state.layers.length >= MAX_LAYERS) return;
  const n = state.layers.length;
  state.layers.push({
    uid: ++uidCounter,
    ink: nextDefaultInk(),
    visible: true,
    density: 1,
    cmyk: firstFree([0, 1, 2, 3], state.layers.map((L) => L.cmyk)),
    rgb: n % RGB_CHANNELS.length,
    angle: firstFree(DEFAULT_ANGLES, state.layers.map((L) => L.angle)),
    screen: null, // null = follows the global screen
  });
}

function screenOf(L) {
  return L.screen || state.screen;
}

function scopeLayer() {
  return state.layers.find((L) => String(L.uid) === String(state.scope)) || null;
}

// Map each layer's ink to the closest one in the new workshop (exact hex matches win)
function remapInks(fromKey, toKey) {
  const target = WORKSHOPS[toKey].inks;
  const used = new Set();
  state.layers.forEach((L) => {
    const src = inkBySlug(L.ink, fromKey);
    const pool = target.filter((k) => !used.has(k.slug));
    let best = (pool.length ? pool : target)[0];
    let bestD = Infinity;
    (pool.length ? pool : target).forEach((k) => {
      const d =
        (src.rgb[0] - k.rgb[0]) ** 2 + (src.rgb[1] - k.rgb[1]) ** 2 + (src.rgb[2] - k.rgb[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    L.ink = best.slug;
    used.add(best.slug);
  });
}

// Riso.channels is static: clear it and free the old buffers before recreating,
// otherwise ghost layers pile up.
function rebuildRisoLayers() {
  Riso.channels.forEach((ch) => ch.remove());
  Riso.channels = [];
  state.layers.forEach((L) => new Riso(inkBySlug(L.ink).rgb.slice(), width, height));
}

function mappedSteps() {
  // (1/steps + 1)^N combinations: keep 4 inks at 0.1
  return state.layers.length >= 4 ? 0.1 : 0.05;
}

// ── SEPARATION ──────────────────────────────────

// Draw the source on white (transparent pixels read as paper) at w x h.
// Returns a p5.Graphics: the caller must .remove() it.
function renderSource(w, h) {
  const g = createGraphics(w, h);
  g.drawingContext.imageSmoothingQuality = "high";
  g.background(255);
  g.image(srcImg, 0, 0, w, h);
  return g;
}

function buildWorkImage() {
  const rect = containRect(printableRect(width, height), srcImg.width, srcImg.height);
  const s = Math.min(1, MAX_PREVIEW_IMG / Math.max(rect.w, rect.h));
  const ww = Math.max(1, Math.round(rect.w * s));
  const wh = Math.max(1, Math.round(rect.h * s));
  const g = renderSource(ww, wh);
  const img = g.get();
  g.remove();
  work = { img, rect, pxScale: ww / rect.w };
}

// Ink coverage per layer (Uint8ClampedArray, 255 = full ink).
// lean = true is used for 300 dpi exports to avoid allocating one full-size
// p5.Image per channel; wanted(i) lets cmyk/rgb skip layers that won't be used.
function computeInkMaps(img, lean = false, wanted = () => true) {
  const n = img.width * img.height;

  if (state.mode === "auto") {
    if (lean) return mappedInkMapsLean(img, mappedSteps());
    const channels = extractMappedChannels(img, mappedSteps(), true);
    return channels.map((ch) => {
      const ink = new Uint8ClampedArray(n);
      for (let i = 0, p = 3; i < n; i++, p += 4) ink[i] = ch.pixels[p];
      return ink;
    });
  }

  return state.layers.map((L, idx) => {
    if (!wanted(idx)) return null;
    const ch =
      state.mode === "cmyk" ? extractCMYKChannel(img, L.cmyk) : extractRGBChannel(img, L.rgb);
    // p5.riso channels are "light = no ink"
    const ink = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) ink[i] = 255 - ch.pixels[p];
    return ink;
  });
}

// Same mapping as extractMappedChannels(), writing straight into compact arrays
function mappedInkMapsLean(img, steps) {
  const mapper = new RisoChannelMapper(steps, true);
  img.loadPixels();
  const px = img.pixels;
  const n = img.width * img.height;
  const k = Riso.channels.length;
  const maps = Array.from({ length: k }, () => new Uint8ClampedArray(n));
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const opacities = mapper.findClosestColor([px[p], px[p + 1], px[p + 2]])[1];
    for (let j = 0; j < k; j++) maps[j][i] = opacities[j] * 255;
  }
  return maps;
}

// ── SCREENING ───────────────────────────────────

// ink → greyscale (Uint8ClampedArray, 0 = full ink, 255 = paper).
// pxScale = working pixels per preview pixel (≈1 in preview, ~3.7–5.3 at export).
function screenLayer(ink, w, h, cfg, angle, pxScale) {
  if (cfg.style === "halftone") {
    return renderHalftone(ink, w, h, cfg.shape, Math.max(1, cfg.frequency * pxScale), angle);
  }
  if (cfg.style === "dither") {
    return renderDither(ink, w, h, cfg.ditherType, cfg.threshold, pxScale);
  }
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 255 - ink[i];
  return out;
}

// Dither at preview-equivalent grain so exports keep the preview's look
function renderDither(ink, w, h, type, threshold, grain) {
  const g = Math.max(1, grain);
  const dw = Math.max(1, Math.round(w / g));
  const dh = Math.max(1, Math.round(h / g));
  const small = downsample(ink, w, h, dw, dh);

  const img = createImage(dw, dh);
  img.loadPixels();
  for (let i = 0, p = 0; i < dw * dh; i++, p += 4) {
    const v = 255 - small[i];
    img.pixels[p] = img.pixels[p + 1] = img.pixels[p + 2] = v;
    img.pixels[p + 3] = 255;
  }
  img.updatePixels();

  const dithered = ditherImage(img, type, threshold);
  dithered.loadPixels();
  const out = new Uint8ClampedArray(dw * dh);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = dithered.pixels[p];
  return upsampleNearest(out, dw, dh, w, h);
}

// Rotated-grid halftone drawn with canvas paths. Same shapes as p5.riso's
// halftoneImage(), but sized by area (dot area = ink coverage) and without the
// 2x-sized intermediate buffers, which matters at 300 dpi.
function renderHalftone(ink, w, h, shape, cell, angleDeg) {
  // Average coverage over ~half a cell so dots don't depend on single pixels
  const k = Math.max(1, cell / 2);
  const sw = Math.max(1, Math.round(w / k));
  const sh = Math.max(1, Math.round(h / k));
  const small = downsample(ink, w, h, sw, sh);

  const g = createGraphics(w, h);
  const ctx = g.drawingContext;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);

  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  const n = Math.ceil(Math.hypot(w, h) / 2 / cell) + 1;
  const pad = cell / 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.beginPath();
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const u = i * cell;
      const v = j * cell;
      const x = cx + u * cos - v * sin;
      const y = cy + u * sin + v * cos;
      if (x < -pad || y < -pad || x >= w + pad || y >= h + pad) continue;
      const sx = Math.min(sw - 1, Math.max(0, Math.floor((x / w) * sw)));
      const sy = Math.min(sh - 1, Math.max(0, Math.floor((y / h) * sh)));
      const d = small[sy * sw + sx] / 255;
      if (d < 0.01) continue;
      addDot(ctx, shape, u, v, cell, d);
    }
  }
  ctx.fillStyle = "#000";
  ctx.fill(); // one fill for the whole path: no seams between cells
  ctx.restore();

  const data = ctx.getImageData(0, 0, w, h).data;
  g.remove();
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = data[p];
  return out;
}

// Add one dot centred at (u, v) covering ~d of a c x c cell.
// Above 50% round dots flip to a filled cell with a hole (counter-wound subpath).
function addDot(ctx, shape, u, v, c, d) {
  const TAU = Math.PI * 2;
  if (shape === "line") {
    const t = c * d;
    ctx.rect(u - c / 2, v - t / 2, c, t);
  } else if (shape === "square") {
    const s = c * Math.sqrt(d);
    ctx.rect(u - s / 2, v - s / 2, s, s);
  } else if (shape === "cross") {
    // Two bars of width t: coverage = 2t - t²
    const t = c * (1 - Math.sqrt(1 - d));
    ctx.rect(u - c / 2, v - t / 2, c, t);
    ctx.rect(u - t / 2, v - c / 2, t, c);
  } else {
    const ratio = shape === "ellipse" ? 0.7 : 1;
    if (d <= 0.5) {
      const rx = c * Math.sqrt(d / (Math.PI * ratio));
      ctx.moveTo(u + rx, v);
      ctx.ellipse(u, v, rx, rx * ratio, 0, 0, TAU);
    } else {
      const rx = c * Math.sqrt((1 - d) / (Math.PI * ratio));
      ctx.rect(u - c / 2, v - c / 2, c, c);
      if (rx > 0.05) {
        ctx.moveTo(u + rx, v);
        ctx.ellipse(u, v, rx, rx * ratio, 0, TAU, 0, true);
      }
    }
  }
}

// Area-average downsample of a 1-channel buffer (tw <= sw, th <= sh)
function downsample(src, sw, sh, tw, th) {
  tw = Math.min(tw, sw);
  th = Math.min(th, sh);
  if (tw === sw && th === sh) return src;
  const sum = new Float32Array(tw * th);
  const cnt = new Uint32Array(tw * th);
  const colBin = new Uint32Array(sw);
  for (let x = 0; x < sw; x++) colBin[x] = Math.min(tw - 1, Math.floor((x * tw) / sw));
  for (let y = 0; y < sh; y++) {
    const row = Math.min(th - 1, Math.floor((y * th) / sh)) * tw;
    const off = y * sw;
    for (let x = 0; x < sw; x++) {
      const b = row + colBin[x];
      sum[b] += src[off + x];
      cnt[b]++;
    }
  }
  const out = new Uint8ClampedArray(tw * th);
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? sum[i] / cnt[i] : 0;
  return out;
}

function upsampleNearest(src, sw, sh, tw, th) {
  if (sw === tw && sh === th) return src;
  const out = new Uint8ClampedArray(tw * th);
  const colMap = new Uint32Array(tw);
  for (let x = 0; x < tw; x++) colMap[x] = Math.min(sw - 1, Math.floor((x * sw) / tw));
  for (let y = 0; y < th; y++) {
    const srow = Math.min(sh - 1, Math.floor((y * sh) / th)) * sw;
    const orow = y * tw;
    for (let x = 0; x < tw; x++) out[orow + x] = src[srow + colMap[x]];
  }
  return out;
}

function grayToImage(gray, w, h) {
  const img = createImage(w, h);
  img.loadPixels();
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    img.pixels[p] = img.pixels[p + 1] = img.pixels[p + 2] = gray[i];
    img.pixels[p + 3] = 255;
  }
  img.updatePixels();
  return img;
}

// ── PREVIEW PIPELINE ────────────────────────────

function runPipeline(stage) {
  if (stage >= STAGE.REBUILD) {
    const [w, h] = previewSize();
    if (w !== width || h !== height) resizeCanvas(w, h);
    rebuildRisoLayers();
    if (srcImg) {
      buildWorkImage();
      inkMaps = computeInkMaps(work.img);
    }
  }

  if (srcImg && work) {
    if (stage >= STAGE.SCREEN) {
      const { img, pxScale } = work;
      screenedImgs = state.layers.map((L, i) =>
        grayToImage(
          screenLayer(inkMaps[i], img.width, img.height, screenOf(L), L.angle, pxScale),
          img.width,
          img.height,
        ),
      );
    }
    if (stage >= STAGE.PAINT) {
      const r = work.rect;
      state.layers.forEach((L, i) => {
        const layer = Riso.channels[i];
        layer.clear();
        layer.fill(255 * L.density); // density scales the layer opacity
        layer.image(screenedImgs[i], r.x, r.y, r.w, r.h);
      });
    }
  }

  redraw();
}

// Debounced, coalesced recompute. The status is painted before the work starts.
function schedule(stage, delay = 0) {
  pendingStage = Math.max(pendingStage, stage);
  if (srcImg) setStatus("procesando…");
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => afterPaint(runPending), delay);
}

function runPending() {
  if (pendingStage < 0 || busy) return; // export resumes pending work when done
  const stage = pendingStage;
  pendingStage = -1;
  try {
    runPipeline(stage);
    setStatus(srcImg ? "listo" : "carga una imagen para empezar");
  } catch (err) {
    console.error(err);
    setStatus("error: " + err.message);
  }
}

function afterPaint(fn) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

function nextFrame() {
  return new Promise((resolve) => afterPaint(resolve));
}

// ── IMAGE LOADING ───────────────────────────────

function loadFile(file) {
  if (!file || busy) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    setStatus("formato no soportado: usa JPG, PNG o WebP");
    return;
  }
  setStatus("cargando…");
  const url = URL.createObjectURL(file);
  loadImage(
    url,
    (img) => {
      URL.revokeObjectURL(url);
      srcImg = img;
      srcInfo = { name: file.name, w: img.width, h: img.height };
      syncUI();
      schedule(STAGE.REBUILD);
    },
    () => {
      URL.revokeObjectURL(url);
      setStatus("no se pudo leer la imagen");
    },
  );
}

// ── EXPORT ──────────────────────────────────────

function visibleLayers() {
  return state.layers.map((L, i) => ({ L, i })).filter(({ L }) => L.visible);
}

function inkSuffix(list) {
  return list.map((item, k) => `${k + 1}-${item.ink.slug}`).join("_");
}

// Separate + screen the visible layers at 300 dpi
async function renderExportLayers() {
  const [PW, PH] = exportSize();
  const rect = containRect(printableRect(PW, PH), srcImg.width, srcImg.height);
  const pxScale = PW / previewSize()[0]; // scales halftone frequency / dither grain to match preview
  const visible = visibleLayers();

  setStatus("procesando… separando a 300 dpi");
  await nextFrame();
  const src = renderSource(rect.w, rect.h);
  const wantedIdx = new Set(visible.map((v) => v.i));
  const maps = computeInkMaps(src, true, (i) => wantedIdx.has(i));
  src.remove();

  const layers = [];
  for (let k = 0; k < visible.length; k++) {
    const { L, i } = visible[k];
    setStatus(`procesando… trama capa ${k + 1}/${visible.length}`);
    await nextFrame();
    layers.push({
      ink: inkBySlug(L.ink),
      density: L.density,
      gray: screenLayer(maps[i], rect.w, rect.h, screenOf(L), L.angle, pxScale),
    });
    maps[i] = null;
  }
  return { PW, PH, rect, layers };
}

// Off-screen page buffer (p5.Graphics + reusable ImageData)
function createPage(PW, PH) {
  const g = createGraphics(PW, PH);
  const ctx = g.drawingContext;
  return { g, ctx, data: ctx.createImageData(PW, PH) };
}

// One layer on white: in its ink colour (rgb) or greyscale (rgb = null, black = 100% ink).
// Density only simulates ink strength on colour pages; greyscale masters stay
// pure so halftone/dither dots aren't re-screened by the riso.
function fillLayerPage(page, rect, layer, rgb) {
  const d = page.data.data;
  const W = page.data.width;
  d.fill(255);
  const gray = layer.gray;
  const density = rgb ? layer.density : 1;
  const r = rgb ? 255 - rgb[0] : 255;
  const gg = rgb ? 255 - rgb[1] : 255;
  const b = rgb ? 255 - rgb[2] : 255;
  for (let y = 0; y < rect.h; y++) {
    let p = ((rect.y + y) * W + rect.x) * 4;
    let s = y * rect.w;
    for (let x = 0; x < rect.w; x++, p += 4, s++) {
      const a = ((255 - gray[s]) / 255) * density;
      d[p] = 255 - r * a;
      d[p + 1] = 255 - gg * a;
      d[p + 2] = 255 - b * a;
    }
  }
  page.ctx.putImageData(page.data, 0, 0);
}

// All layers multiplied over white, like the preview
function fillCompositePage(page, rect, layers) {
  const d = page.data.data;
  const W = page.data.width;
  d.fill(255);
  const inks = layers.map((l) => l.ink.rgb.map((c) => c / 255));
  for (let y = 0; y < rect.h; y++) {
    let p = ((rect.y + y) * W + rect.x) * 4;
    let s = y * rect.w;
    for (let x = 0; x < rect.w; x++, p += 4, s++) {
      let r = 255;
      let g = 255;
      let b = 255;
      for (let j = 0; j < layers.length; j++) {
        const a = ((255 - layers[j].gray[s]) / 255) * layers[j].density;
        const c = inks[j];
        r *= 1 - a + a * c[0];
        g *= 1 - a + a * c[1];
        b *= 1 - a + a * c[2];
      }
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
    }
  }
  page.ctx.putImageData(page.data, 0, 0);
}

function newPDF() {
  const { jsPDF } = window.jspdf;
  return new jsPDF({
    orientation: state.orientation === "portrait" ? "p" : "l",
    unit: "mm",
    format: state.format.toLowerCase(),
    compress: true,
  });
}

// PNG (lossless) page image, full page size
function addPageImage(doc, page, first) {
  const [mw, mh] = pageMM();
  if (!first) doc.addPage(state.format.toLowerCase(), state.orientation === "portrait" ? "p" : "l");
  doc.addImage(page.g.elt.toDataURL("image/png"), "PNG", 0, 0, mw, mh, undefined, "FAST");
}

async function exportPDF(color) {
  const out = await renderExportLayers();
  const page = createPage(out.PW, out.PH);
  const doc = newPDF();
  try {
    let first = true;
    if (color) {
      setStatus("procesando… composición");
      await nextFrame();
      fillCompositePage(page, out.rect, out.layers);
      addPageImage(doc, page, first);
      first = false;
    }
    for (let k = 0; k < out.layers.length; k++) {
      setStatus(`procesando… página capa ${k + 1}/${out.layers.length}`);
      await nextFrame();
      const layer = out.layers[k];
      fillLayerPage(page, out.rect, layer, color ? layer.ink.rgb : null);
      addPageImage(doc, page, first);
      first = false;
    }
  } finally {
    page.g.remove();
  }
  const name = `riso_${color ? "color" : "bn"}_${state.format}_${inkSuffix(out.layers)}.pdf`;
  doc.save(name);
  return name;
}

async function exportPNGLayers() {
  const out = await renderExportLayers();
  const page = createPage(out.PW, out.PH);
  try {
    for (let k = 0; k < out.layers.length; k++) {
      setStatus(`procesando… png capa ${k + 1}/${out.layers.length}`);
      await nextFrame();
      const layer = out.layers[k];
      fillLayerPage(page, out.rect, layer, null);
      const blob = await new Promise((res) => page.g.elt.toBlob(res, "image/png"));
      downloadBlob(blob, `riso_${state.format}_${k + 1}-${layer.ink.slug}.png`);
      await new Promise((res) => setTimeout(res, 350)); // let the browser start each download
    }
  } finally {
    page.g.remove();
  }
  return `${out.layers.length} png`;
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function runExport(job) {
  if (busy) return;
  if (!srcImg) return setStatus("primero carga una imagen");
  if (!visibleLayers().length) return setStatus("no hay capas visibles para exportar");
  busy = true;
  syncBusy();
  try {
    const name = await job();
    setStatus("listo · " + name);
  } catch (err) {
    console.error(err);
    setStatus("error al exportar: " + err.message);
  } finally {
    busy = false;
    syncBusy();
    if (pendingStage >= 0) schedule(pendingStage);
  }
}

// ── UI ──────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function setStatus(msg) {
  $("meta-status").textContent = msg;
}

function setActive(containerId, value, cls = "active") {
  document.querySelectorAll(`#${containerId} [data-value]`).forEach((b) => {
    b.classList.toggle(cls, b.dataset.value === String(value));
  });
}

function onPick(containerId, fn) {
  $(containerId).addEventListener("click", (e) => {
    const b = e.target.closest("[data-value]");
    if (b) fn(b.dataset.value);
  });
}

function bindUI() {
  // Image
  $("btn-load").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    loadFile(e.target.files[0]);
    e.target.value = "";
  });

  const area = $("canvas-area");
  area.addEventListener("dragover", (e) => {
    e.preventDefault();
    area.classList.add("dragging");
  });
  area.addEventListener("dragleave", (e) => {
    if (!area.contains(e.relatedTarget)) area.classList.remove("dragging");
  });
  area.addEventListener("drop", (e) => {
    e.preventDefault();
    area.classList.remove("dragging");
    loadFile(e.dataTransfer.files[0]);
  });
  // Don't let a file dropped elsewhere navigate away from the tool
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  // Workshop
  onPick("toggle-workshop", (v) => {
    if (v === state.workshop) return;
    remapInks(state.workshop, v);
    state.workshop = v;
    syncUI();
    schedule(STAGE.REBUILD);
  });

  // Separation mode
  onPick("group-mode", (v) => {
    if (v === state.mode) return;
    state.mode = v;
    syncUI();
    schedule(STAGE.REBUILD);
  });

  // Layers
  $("btn-add-layer").addEventListener("click", () => {
    addLayer();
    syncUI();
    schedule(STAGE.REBUILD);
  });

  const list = $("layer-list");
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    const L = layerFromEvent(e);
    if (!btn || !L) return;
    const act = btn.dataset.act;
    if (act === "remove") {
      if (state.layers.length <= 1) return;
      state.layers = state.layers.filter((x) => x !== L);
      if (String(state.scope) === String(L.uid)) state.scope = "global";
      syncUI();
      schedule(STAGE.REBUILD);
    } else if (act === "visible") {
      L.visible = !L.visible;
      renderLayers();
      redraw(); // composite only
    } else if (act === "channel") {
      const v = parseInt(btn.dataset.value, 10);
      if (state.mode === "cmyk") L.cmyk = v;
      else L.rgb = v;
      renderLayers();
      schedule(STAGE.REBUILD);
    }
  });
  list.addEventListener("change", (e) => {
    const L = layerFromEvent(e);
    if (!L || !e.target.classList.contains("ink-select")) return;
    L.ink = e.target.value;
    syncUI();
    schedule(STAGE.REBUILD);
  });
  list.addEventListener("input", (e) => {
    const L = layerFromEvent(e);
    if (!L || e.target.dataset.act !== "density") return;
    L.density = parseInt(e.target.value, 10) / 100;
    e.target.closest(".slider-row").querySelector(".slider-value").textContent = e.target.value + "%";
    schedule(STAGE.PAINT, DEBOUNCE_MS);
  });

  // Screening
  onPick("toggle-scope", (v) => {
    state.scope = v === "global" ? "global" : parseInt(v, 10);
    syncScreenUI();
  });
  $("btn-follow").addEventListener("click", () => {
    const L = scopeLayer();
    if (!L) return;
    L.screen = L.screen ? null : { ...state.screen };
    syncScreenUI();
    schedule(STAGE.SCREEN);
  });
  onPick("group-style", (v) => editScreen((s) => (s.style = v)));
  onPick("toggle-shape", (v) => editScreen((s) => (s.shape = v)));
  onPick("toggle-dither", (v) => editScreen((s) => (s.ditherType = v)));
  $("slider-frequency").addEventListener("input", (e) =>
    editScreen((s) => (s.frequency = parseInt(e.target.value, 10)), DEBOUNCE_MS),
  );
  $("slider-threshold").addEventListener("input", (e) =>
    editScreen((s) => (s.threshold = parseInt(e.target.value, 10)), DEBOUNCE_MS),
  );
  $("slider-angle").addEventListener("input", (e) => {
    const L = scopeLayer();
    if (!L) return;
    L.angle = parseInt(e.target.value, 10);
    syncScreenUI();
    schedule(STAGE.SCREEN, DEBOUNCE_MS);
  });

  // Format
  onPick("toggle-format", (v) => {
    if (v === state.format) return;
    state.format = v;
    syncUI();
    schedule(STAGE.REBUILD);
  });
  onPick("toggle-orientation", (v) => {
    if (v === state.orientation) return;
    state.orientation = v;
    syncUI();
    schedule(STAGE.REBUILD);
  });

  // Export
  $("btn-pdf-color").addEventListener("click", () => runExport(() => exportPDF(true)));
  $("btn-pdf-bw").addEventListener("click", () => runExport(() => exportPDF(false)));
  $("btn-png-layers").addEventListener("click", () => runExport(exportPNGLayers));
}

function layerFromEvent(e) {
  const el = e.target.closest(".layer");
  return el ? state.layers.find((L) => String(L.uid) === el.dataset.uid) : null;
}

// Edit the screen of the current scope; editing a layer gives it its own screen
function editScreen(mutate, delay = 0) {
  const L = scopeLayer();
  if (L) {
    if (!L.screen) L.screen = { ...state.screen };
    mutate(L.screen);
  } else {
    mutate(state.screen);
  }
  syncScreenUI();
  schedule(STAGE.SCREEN, delay);
}

function syncUI() {
  setActive("toggle-workshop", state.workshop);
  setActive("group-mode", state.mode, "on");
  setActive("toggle-format", state.format);
  setActive("toggle-orientation", state.orientation);

  $("meta-image").textContent = srcInfo
    ? `${srcInfo.name} · ${srcInfo.w} × ${srcInfo.h} px`
    : "sin imagen · también puedes arrastrarla al lienzo";

  const modeMeta = {
    auto: `mezcla las tintas elegidas para aproximar cada color · paso ${mappedSteps()}`,
    cmyk: "cada capa imprime un canal c / m / y / k",
    rgb: "cada capa imprime donde falta su canal r / g / b",
  };
  $("meta-mode").textContent = modeMeta[state.mode];

  renderLayers();
  $("btn-add-layer").disabled = state.layers.length >= MAX_LAYERS;
  $("meta-layers").textContent = `${state.layers.length} de ${MAX_LAYERS} capas · ${currentWorkshop().name}`;

  syncScreenUI();
  syncBusy();
}

function renderLayers() {
  const inks = currentWorkshop().inks;
  const single = state.layers.length <= 1;
  $("layer-list").innerHTML = state.layers
    .map((L, i) => {
      const ink = inkBySlug(L.ink);
      const pct = Math.round(L.density * 100);
      const options = inks
        .map((k) => `<option value="${k.slug}"${k.slug === L.ink ? " selected" : ""}>${k.name}</option>`)
        .join("");
      return `
        <div class="layer${L.visible ? "" : " hidden-layer"}" data-uid="${L.uid}">
          <div class="layer-head">
            <span class="layer-num">${i + 1}</span>
            <span class="swatch" style="background:${ink.hex}" title="${ink.hex}"></span>
            <select class="ink-select" aria-label="tinta de la capa ${i + 1}">${options}</select>
          </div>
          <div class="layer-row">
            <button class="btn btn-inline${L.visible ? " on" : ""}" type="button" data-act="visible">${L.visible ? "[ ver ]" : "[ oculta ]"}</button>
            <button class="btn btn-inline" type="button" data-act="remove" title="quitar capa"${single ? " disabled" : ""}>[ – ]</button>
          </div>
          ${channelToggleHTML(L)}
          <div class="slider-row">
            <div class="slider-head">
              <span class="field-label">densidad</span>
              <span class="slider-value">${pct}%</span>
            </div>
            <input type="range" min="0" max="100" step="1" value="${pct}" data-act="density" aria-label="densidad de la capa ${i + 1}" />
          </div>
        </div>`;
    })
    .join("");
}

function channelToggleHTML(L) {
  if (state.mode === "auto") return "";
  const names = state.mode === "cmyk" ? CMYK_CHANNELS : RGB_CHANNELS;
  const current = state.mode === "cmyk" ? L.cmyk : L.rgb;
  const buttons = names
    .map(
      (c, k) =>
        `${k ? '<span class="toggle-sep">|</span>' : ""}<button class="toggle-btn${k === current ? " active" : ""}" type="button" data-act="channel" data-value="${k}">${c}</button>`,
    )
    .join("");
  return `<div class="layer-channel"><span class="field-label">canal</span><div class="format-toggle">${buttons}</div></div>`;
}

function syncScreenUI() {
  if (state.scope !== "global" && !scopeLayer()) state.scope = "global";
  const L = scopeLayer();
  const cfg = L ? screenOf(L) : state.screen;

  // Scope toggle: global | 1 | 2* ...  (* = layer has its own screen)
  const opts = [["global", "global"]].concat(
    state.layers.map((x, i) => [String(x.uid), `${i + 1}${x.screen ? "*" : ""}`]),
  );
  $("toggle-scope").innerHTML = opts
    .map(
      ([v, label], k) =>
        `${k ? '<span class="toggle-sep">|</span>' : ""}<button class="toggle-btn" type="button" data-value="${v}">${label}</button>`,
    )
    .join("");
  setActive("toggle-scope", state.scope);

  $("btn-follow").hidden = !L;
  if (L) {
    $("btn-follow").classList.toggle("on", !L.screen);
    const idx = state.layers.indexOf(L) + 1;
    $("meta-scope").textContent = L.screen
      ? `capa ${idx}: trama propia`
      : `capa ${idx}: sigue la trama global · al cambiar algo pasa a tener trama propia`;
  } else {
    $("meta-scope").textContent = "aplica a todas las capas sin trama propia (*)";
  }

  setActive("group-style", cfg.style, "on");
  $("panel-halftone").hidden = cfg.style !== "halftone";
  $("panel-dither").hidden = cfg.style !== "dither";

  // Halftone
  setActive("toggle-shape", cfg.shape);
  $("slider-frequency").value = cfg.frequency;
  const exportCell = cfg.frequency * (exportSize()[0] / previewSize()[0]);
  $("val-frequency").textContent = `${cfg.frequency} px · ≈ ${Math.round(EXPORT_DPI / exportCell)} lpi`;

  $("row-angle").hidden = !L;
  if (L) {
    $("slider-angle").value = L.angle;
    $("val-angle").textContent = `${L.angle}°`;
    $("meta-angles").textContent = "";
  } else {
    $("meta-angles").textContent =
      "ángulo por capa: " +
      state.layers.map((x, i) => `${i + 1}·${x.angle}°`).join("  ") +
      " · elige una capa arriba para cambiarlo";
  }

  // Dither
  setActive("toggle-dither", cfg.ditherType);
  $("slider-threshold").value = cfg.threshold;
  $("val-threshold").textContent = String(cfg.threshold);
}

function syncBusy() {
  document.querySelector(".sidebar").classList.toggle("busy", busy);
  ["btn-pdf-color", "btn-pdf-bw", "btn-png-layers"].forEach((id) => {
    $(id).disabled = busy || !srcImg;
  });
}
