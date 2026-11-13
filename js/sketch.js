/*
  sketch.js — riso separator
  p5.js 1.x (global mode) + p5.riso.
  Splits an image into riso ink layers, previews the overprint with MULTIPLY
  and exports 300 dpi print masters (PDF / PNG).
*/

// ── CONSTANTS ───────────────────────────────────

const PAGE_MM = { A4: [210, 297], A3: [297, 420] }; // portrait
const MARGIN_MM = 6; // 0.6 cm on every side
const PRINTABLE_MM = { A4: [210 - 2 * MARGIN_MM, 297 - 2 * MARGIN_MM], A3: [297 - 2 * MARGIN_MM, 420 - 2 * MARGIN_MM] }; // portrait, centred
const EXPORT_PX = { A4: [2480, 3508], A3: [3508, 4961] }; // 300 dpi, portrait
const EXPORT_DPI = 300;

const PREVIEW_LONG = 940; // preview canvas long side (keeps the image area under ~900 px)
// Canvas resolution multiplier: 2 on retina/hi-dpi screens so the preview is
// drawn at device resolution, raised further while zoomed in (see zoom.js)
const BASE_PREVIEW_QUALITY = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
window.BASE_PREVIEW_QUALITY = BASE_PREVIEW_QUALITY;
let previewQuality = BASE_PREVIEW_QUALITY;
// Halftone / dither are computed at this many pixels per base-preview pixel,
// in the preview and in exports alike: finer dot edges, same screen and lpi
const SCREEN_SUPERSAMPLE = 2;
const MAX_PREVIEW_IMG = 900; // max long side of the preview working image
const MAX_LAYERS = 4;
const HALFTONE_THRESHOLD = 127; // p5.riso halftoneImage() "intensity": binarises the dots
const DEFAULT_ANGLES = [15, 75, 0, 45];
const CMYK_CHANNELS = ["c", "m", "y", "k"];
const RGB_CHANNELS = ["r", "g", "b"];
const DEBOUNCE_MS = 200;
const GUIDE_COLOR = "#BFC9DD"; // Medium Blue at 30 % on paper

// Pipeline stages, cheapest first. Running a stage also runs every cheaper one.
const STAGE = { COMPOSITE: 0, PAINT: 1, SCREEN: 2, REBUILD: 3 };

// ── STATE ───────────────────────────────────────

const state = {
  project: "poster", // poster | zine (8-page fanzine, zine.js) | flip (flipbook from a video, flip.js)
  zine: { pages: [null, null, null, null, null, null, null, null], tray: [] }, // image ids
  // flipbook: frame size s|m|l, margin X (left binding strip) and Y (above + below) in mm, marks layer uid
  flip: { size: "auto", binding: 10, marginY: 0, marks: "auto" }, // size: auto (fills the sheet) | s | m | l
  remap: false, // auto mode: false = mix inks, true = send each image colour to one ink (reassign)
  colorRules: [], // eyedropper replacements, see recolor.js: { id, rgb, target: uid | "paper", tol }
  workshop: "lab360", // default: Lab360 UDP inks (inks.js)
  mode: "auto", // auto | cmyk | rgb
  format: "A4",
  orientation: "portrait", // portrait | landscape
  fit: "contain", // contain (whole image, may leave paper bands) | cover (fills the printable area, crops)
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
let srcImg = null; // pipeline source: the poster image or the composed zine sheet (syncSource)
let srcInfo = null; // { name, w, h }
let posterImg = null; // image loaded in poster mode
let posterInfo = null;
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

// ── P5 ──────────────────────────────────────────

function setup() {
  const [w, h] = canvasSize();
  const cnv = createCanvas(w, h);
  pixelDensity(1);
  cnv.parent("canvas-wrapper");
  noLoop();

  addLayer();
  addLayer();
  rebuildRisoLayers();

  bindUI();
  syncUI();
  undoHistory.current = snapshot(); // baseline for undo

  // Redraw the empty state once web fonts are available
  if (document.fonts) document.fonts.ready.then(() => redraw());
}

function draw() {
  background(255);
  // Displayed width stays the base preview width whatever the canvas resolution
  fitCanvas();

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
  if (state.project === "zine") drawZineGuides();
}

// Display size: the base preview size shrunk (never enlarged) to fit the area,
// with explicit width and height so the aspect ratio always holds.
function fitCanvas() {
  const c = drawingContext.canvas;
  const box = c.parentElement.getBoundingClientRect();
  const bw = width / previewQuality;
  const bh = height / previewQuality;
  const k = Math.min(1, box.width / bw, box.height / bh);
  c.style.setProperty("width", Math.floor(bw * k) + "px", "important");
  c.style.setProperty("height", Math.floor(bh * k) + "px", "important");
}
window.addEventListener("resize", () => typeof redraw === "function" && redraw());

// Logo mark (pink and blue overprinted) + how to start
function drawEmptyState() {
  const q = previewQuality;
  const cx = width / 2;
  const cy = height / 2;
  const r = 34 * q;
  noStroke();
  fill("#FF48B0");
  circle(cx - 12 * q, cy - 56 * q, r * 2);
  blendMode(MULTIPLY);
  fill("#3255A4");
  circle(cx + 12 * q, cy - 56 * q, r * 2);
  blendMode(BLEND);

  textAlign(CENTER, CENTER);
  textFont("Space Grotesk");
  fill("#3255A4");
  textStyle(BOLD);
  textSize(Math.round(22 * q));
  const msg = {
    poster: ["Arrastra una imagen o un PDF", "o haz clic para elegir un archivo · JPG, PNG, WebP o PDF"],
    zine: ["Arrastra las imágenes del fanzine", "o haz clic para elegir varias · un PDF se reparte en páginas"],
    flip: flipVideo.el
      ? ["Elige el tramo y extrae los frames", "en 01 Imagen: marca inicio y fin, cuántos frames y Extraer"]
      : ["Arrastra un video", "o haz clic para elegir uno · MP4, WebM o MOV"],
  }[state.project];
  text(msg[0], cx, cy + 18 * q);
  textStyle(NORMAL);
  textSize(Math.round(13 * q));
  fill("#7088BF");
  text(msg[1], cx, cy + 46 * q);
}

// Preview-only guide: never part of an export
function drawPrintableGuide() {
  const r = printableRect(width, height);
  noFill();
  stroke(GUIDE_COLOR);
  strokeWeight(previewQuality);
  rect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, Math.round(r.h) - 1);
}

// ── GEOMETRY ────────────────────────────────────

// A zine is always printed on a landscape sheet
function pageOrientation() {
  return state.project === "zine" ? "landscape" : state.orientation;
}

function orient([a, b]) {
  return pageOrientation() === "portrait" ? [a, b] : [b, a];
}

// Pick the pipeline source for the current project
function syncSource() {
  if (state.project === "zine") {
    const sheet = ensureZineSheet();
    srcImg = sheet ? sheet.img : null;
    srcInfo = sheet ? { name: `fanzine · ${zineAssignedCount()} de ${ZINE_PAGES} páginas`, w: srcImg.width, h: srcImg.height } : null;
  } else if (state.project === "flip") {
    const sheet = ensureFlipSheet();
    srcImg = sheet ? sheet.img : null;
    srcInfo = sheet ? { name: `flipbook · hoja ${flipSheetIndex + 1} de ${flipSheetCount()}`, w: srcImg.width, h: srcImg.height } : null;
  } else {
    srcImg = posterImg;
    srcInfo = posterInfo;
  }
}

// "hoja A4 horizontal · páginas de 74 × 105 mm (A7)"
function zinePageMeta() {
  const [w, h] = orient(PAGE_MM[state.format]);
  const size = state.format === "A4" ? "A7" : "A6";
  return `hoja ${state.format} horizontal · 8 páginas de ${Math.round(w / 4)} × ${Math.round(h / 2)} mm (${size}) · corta la línea rosa y dobla por las azules`;
}

// Format tag for exported file names
function fileTag() {
  if (state.project === "zine") return `${state.format}_fanzine`;
  if (state.project === "flip") return `${state.format}_flipbook`;
  return state.format;
}

function pageMM() {
  return orient(PAGE_MM[state.format]);
}

function previewSize() {
  const [w, h] = pageMM();
  const k = PREVIEW_LONG / Math.max(w, h);
  return [Math.round(w * k), Math.round(h * k)];
}

// Actual canvas size: the preview size times the zoom quality multiplier
function canvasSize() {
  const [w, h] = previewSize();
  return [w * previewQuality, h * previewQuality];
}

// Re-render the preview at a higher resolution (zoom.js calls this once zoom settles)
window.setPreviewQuality = function (q) {
  if (q === previewQuality) return;
  previewQuality = q;
  if (srcImg) schedule(STAGE.REBUILD);
  else resizeCanvas(...canvasSize());
};

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

// Where the source goes inside area: rect = destination in whole pixels,
// crop = source region. contain shows the whole image; cover fills the area
// and crops the excess, centred.
function placeImage(area, iw, ih) {
  if (state.fit === "contain") {
    return { rect: containRect(area, iw, ih), crop: { x: 0, y: 0, w: iw, h: ih } };
  }
  const x = Math.round(area.x);
  const y = Math.round(area.y);
  const rect = { x, y, w: Math.round(area.x + area.w) - x, h: Math.round(area.y + area.h) - y };
  const s = Math.max(rect.w / iw, rect.h / ih);
  const cw = rect.w / s;
  const ch = rect.h / s;
  return { rect, crop: { x: (iw - cw) / 2, y: (ih - ch) / 2, w: cw, h: ch } };
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

// ── SEPARATION ──────────────────────────────────

// Draw the crop of the source on white (transparent pixels read as paper) at w x h.
// Returns a p5.Graphics: the caller must .remove() it.
function renderSource(w, h, crop, img = srcImg) {
  const g = createGraphics(w, h);
  g.drawingContext.imageSmoothingQuality = "high";
  g.background(255);
  g.image(img, 0, 0, w, h, crop.x, crop.y, crop.w, crop.h);
  return g;
}

function buildWorkImage() {
  const { rect, crop } = placeImage(printableRect(width, height), srcImg.width, srcImg.height);
  // Separation always runs at base preview resolution (cheap); only the
  // screens are drawn at the higher zoom resolution (ow x oh).
  const base = Math.max(rect.w, rect.h) / previewQuality;
  const s = Math.min(1, MAX_PREVIEW_IMG / base) / previewQuality;
  const ww = Math.max(1, Math.round(rect.w * s));
  const wh = Math.max(1, Math.round(rect.h * s));
  const so = Math.min(1, (MAX_PREVIEW_IMG * previewQuality) / Math.max(rect.w, rect.h));
  const ow = Math.max(1, Math.round(rect.w * so));
  const oh = Math.max(1, Math.round(rect.h * so));
  const g = renderSource(ww, wh, crop);
  const img = g.get();
  g.remove();
  work = {
    img,
    rect,
    pxScale: ww / (rect.w / previewQuality), // ink-map px per base-preview px
    ow,
    oh,
    outScale: ow / (rect.w / previewQuality), // screen px per base-preview px
  };
}

// Ink coverage per layer (Uint8ClampedArray, 255 = full ink), see separation.js.
// wanted(i) = false skips layers that won't be used (hidden layers on export).
// Reassign: main colours of the current source and the ink each goes to.
// The palette is kept per source so the preview and the 300 dpi export use
// the same one. A flipbook takes it from all of its frames (not just the sheet
// on screen), so a colour that only shows up later in the animation still
// gets its own ink and every sheet is separated the same way.
let remapState = { key: null, palette: [], plan: [], inks: [] };
function remapFor(px, n, inks) {
  const flip = state.project === "flip" && flipFrames.length;
  const key = flip ? flipFrames : srcImg;
  if (remapState.key !== key) {
    const maxColors = Math.min(8, state.layers.length + 3);
    const sample = flip ? flipFramesSample() : { px, n };
    remapState = { key, palette: RisoSep.extractPalette(sample.px, sample.n, maxColors), plan: [], inks: [] };
  }
  remapState.plan = RisoSep.planRemap(remapState.palette, inks);
  remapState.inks = inks;
  return remapState;
}

// Sidebar: detected colour → ink
function renderRemapList() {
  const list = $("remap-list");
  const show = state.mode === "auto" && state.remap && srcImg && remapState.palette.length;
  list.hidden = !show;
  if (!show) return;
  const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  list.innerHTML = remapState.palette
    .map((c, i) => {
      const p = remapState.plan[i];
      const L = p && state.layers[p.ink];
      if (!L) return "";
      const ink = inkBySlug(L.ink);
      const how = p.matched ? "se queda en" : "pasa a";
      return `<span class="remap-item" title="${hex(c.rgb)} ${how} ${ink.name} · ${Math.round(c.share * 100)} % de lo que lleva tinta">
        <span class="swatch swatch-square" style="background:${hex(c.rgb)}"></span>
        <span class="ms" aria-hidden="true">arrow_forward</span>
        <span class="swatch" style="background:${ink.hex}"></span></span>`;
    })
    .join("");
}

function computeInkMaps(img, wanted = () => true) {
  const n = img.width * img.height;
  img.loadPixels();
  const px = img.pixels;

  let maps;
  if (state.mode === "auto" && state.remap) {
    const inks = state.layers.map((L) => inkBySlug(L.ink).rgb);
    const { palette, plan } = remapFor(px, n, inks);
    maps = RisoSep.remapInkMaps(px, n, inks, palette, plan, wanted);
  } else if (state.mode === "auto") {
    const inks = state.layers.map((L) => inkBySlug(L.ink).rgb);
    maps = RisoSep.autoInkMaps(px, n, inks, wanted);
  } else {
    const useK = state.layers.some((L) => L.cmyk === 3);
    maps = state.layers.map((L, idx) => {
      if (!wanted(idx)) return null;
      if (state.mode === "cmyk") return RisoSep.cmykInkMap(px, n, L.cmyk, useK);
      // rgb: ink wherever the layer's channel is missing
      const ink = new Uint8ClampedArray(n);
      for (let i = 0, p = L.rgb; i < n; i++, p += 4) ink[i] = 255 - px[p];
      return ink;
    });
  }
  return applyColorRules(maps, px, n); // eyedropper replacements (recolor.js)
}

// ── SCREENING ───────────────────────────────────

// ink → greyscale (Uint8ClampedArray, 0 = full ink, 255 = paper).
// pxScale = working pixels per preview pixel (≈1 in preview, ~3.7–5.3 at export).
// Output is w x h; the ink map may be smaller (iw x ih) — halftone only.
function screenLayer(ink, w, h, cfg, angle, pxScale, iw = w, ih = h) {
  if (cfg.style === "halftone") {
    return renderHalftone(ink, iw, ih, w, h, cfg.shape, cfg.frequency, angle, pxScale);
  }
  if (cfg.style === "dither") {
    return renderDither(ink, iw, ih, w, h, cfg.ditherType, cfg.threshold, pxScale);
  }
  const src = resampleInk(ink, iw, ih, w, h);
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 255 - src[i];
  return out;
}

// Size of the screening buffer for an output of w x h: SCREEN_SUPERSAMPLE
// pixels per base-preview pixel (grain = output px per base-preview px)
function screenBufferSize(w, h, grain) {
  const k = SCREEN_SUPERSAMPLE / Math.max(0.001, grain);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

// Screen buffer (dw x dh, 0 = ink) → output w x h: area average when it is
// larger (preview on a low-dpi screen: smooth), nearest neighbour when smaller
// (exports: crisp, unscreened again by the riso)
function screenToOutput(buf, dw, dh, w, h) {
  if (dw === w && dh === h) return buf;
  return dw > w ? downsample(buf, dw, dh, w, h) : upsampleNearest(buf, dw, dh, w, h);
}

// Ink map iw x ih → tw x th (area average down, bilinear up)
function resampleInk(ink, iw, ih, tw, th) {
  if (tw === iw && th === ih) return ink;
  if (tw <= iw && th <= ih) return downsample(ink, iw, ih, tw, th);
  const out = new Uint8ClampedArray(tw * th);
  const sx = iw / tw;
  const sy = ih / th;
  for (let y = 0; y < th; y++) {
    const fy = Math.min(ih - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(ih - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < tw; x++) {
      const fx = Math.min(iw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(iw - 1, x0 + 1);
      const wx = fx - x0;
      const a = ink[y0 * iw + x0] + (ink[y0 * iw + x1] - ink[y0 * iw + x0]) * wx;
      const b = ink[y1 * iw + x0] + (ink[y1 * iw + x1] - ink[y1 * iw + x0]) * wx;
      out[y * tw + x] = a + (b - a) * wy;
    }
  }
  return out;
}

// Dither at preview-equivalent grain so exports keep the preview's look
function renderDither(ink, iw, ih, w, h, type, threshold, grain) {
  const [dw, dh] = screenBufferSize(w, h, grain);
  const small = resampleInk(ink, iw, ih, dw, dh);

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
  return screenToOutput(out, dw, dh, w, h);
}

// Halftone with p5.riso's halftoneImage(): one sample per cell, dot size
// proportional to darkness, then thresholded — the crunchy riso texture.
// It runs at preview grain (grain = output px per base-preview px) and is
// scaled up with nearest neighbour, like renderDither(), so exports keep
// exactly the preview's texture and the library's 2x-size buffers stay small.
// ink is iw x ih; the result is w x h (0 = full ink, 255 = paper).
function renderHalftone(ink, iw, ih, w, h, shape, cellPx, angleDeg, grain) {
  const [dw, dh] = screenBufferSize(w, h, grain);
  const small = resampleInk(ink, iw, ih, dw, dh);
  const src = grayToImage(small.map((v) => 255 - v), dw, dh);

  // The library samples pixels[(x + y·w)·4] on a grid of this step: it must be
  // a whole number of pixels or no dot is ever drawn. cellPx is in
  // base-preview pixels; the buffer has SCREEN_SUPERSAMPLE of them per pixel.
  const gridsize = Math.max(2, Math.round(cellPx * SCREEN_SUPERSAMPLE));
  // p5.riso rotates with the sketch's angleMode, which is radians here
  const angle = (angleDeg * Math.PI) / 180;
  const result = withTempGraphics(() =>
    halftoneImage(src, shape, gridsize, angle, HALFTONE_THRESHOLD),
  );

  result.loadPixels();
  const out = new Uint8ClampedArray(dw * dh);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = result.pixels[p];
  return screenToOutput(out, dw, dh, w, h);
}

// p5.riso's halftoneImage() creates two p5.Graphics (2x the image size) and
// never removes them: collect whatever fn creates and free it afterwards.
function withTempGraphics(fn) {
  const p = _getP5Instance();
  const own = Object.prototype.hasOwnProperty.call(p, "createGraphics");
  const original = p.createGraphics;
  const created = [];
  p.createGraphics = function (...args) {
    const g = original.apply(this, args);
    created.push(g);
    return g;
  };
  try {
    return fn();
  } finally {
    if (own) p.createGraphics = original;
    else delete p.createGraphics;
    created.forEach((g) => g.remove());
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
    syncSource();
    const [w, h] = canvasSize();
    if (w !== width || h !== height) resizeCanvas(w, h);
    rebuildRisoLayers();
    if (srcImg) {
      buildWorkImage();
      inkMaps = computeInkMaps(work.img);
      renderRemapList();
    }
  }

  if (srcImg && work) {
    if (stage >= STAGE.SCREEN) {
      const { img, pxScale, ow, oh, outScale } = work;
      const marksIdx = state.project === "flip" ? flipMarksLayer() : -1;
      screenedImgs = state.layers.map((L, i) => {
        const cfg = screenOf(L);
        let gray;
        let gw = img.width;
        let gh = img.height;
        if (cfg.style === "continuous") {
          gray = screenLayer(inkMaps[i], img.width, img.height, cfg, L.angle, pxScale);
        } else {
          // screens at canvas resolution (ow x oh) from the base-resolution ink map
          gray = screenLayer(inkMaps[i], ow, oh, cfg, L.angle, outScale, img.width, img.height);
          gw = ow;
          gh = oh;
        }
        if (i === marksIdx) overlayFlipMarks(gray, gw, gh, flipSheetIndex);
        return grayToImage(gray, gw, gh);
      });
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
  recordHistory();
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

// ── HISTORY (undo / redo) ───────────────────────

// Snapshots of the user's settings plus the loaded image (by reference, so
// they are cheap). schedule() records one after every change; changes closer
// than HISTORY_COALESCE_MS (a slider drag) become a single step. state.scope
// (which layer TRAMA is editing) is navigation, not an edit: it's left out.
const HISTORY_MAX = 100;
const HISTORY_COALESCE_MS = 400;
const undoHistory = { past: [], future: [], current: null, timer: null };

// The zine sheet is derived from state.zine (+ zineImages), so only the poster
// image needs to be kept by reference
function snapshot() {
  return { state: structuredClone(state), posterImg, posterInfo };
}

function snapshotKey(snap) {
  return JSON.stringify({ ...snap.state, scope: null });
}

function sameSnapshot(a, b) {
  return !!a && !!b && a.posterImg === b.posterImg && snapshotKey(a) === snapshotKey(b);
}

function recordHistory() {
  clearTimeout(undoHistory.timer);
  undoHistory.timer = setTimeout(commitHistory, HISTORY_COALESCE_MS);
}

function commitHistory() {
  clearTimeout(undoHistory.timer);
  undoHistory.timer = null;
  const snap = snapshot();
  if (sameSnapshot(snap, undoHistory.current)) return;
  if (undoHistory.current) undoHistory.past.push(undoHistory.current);
  if (undoHistory.past.length > HISTORY_MAX) undoHistory.past.shift();
  undoHistory.current = snap;
  undoHistory.future = [];
  syncHistoryUI();
}

function restoreSnapshot(snap) {
  const scope = state.scope;
  const s = structuredClone(snap.state);
  Object.keys(s).forEach((k) => (state[k] = s[k]));
  state.scope = scope; // syncScreenUI falls back to global if that layer is gone
  posterImg = snap.posterImg;
  posterInfo = snap.posterInfo;
  uidCounter = Math.max(uidCounter, ...state.layers.map((L) => L.uid));
  undoHistory.current = snap; // so the schedule() below doesn't record it again
  syncUI();
  schedule(STAGE.REBUILD);
  syncHistoryUI();
}

function undo() {
  if (busy) return;
  if (undoHistory.timer) commitHistory(); // a change still waiting to be recorded
  if (!undoHistory.past.length) return setStatus("nada que deshacer");
  undoHistory.future.push(undoHistory.current);
  restoreSnapshot(undoHistory.past.pop());
}

function redo() {
  if (busy) return;
  if (undoHistory.timer) commitHistory();
  if (!undoHistory.future.length) return setStatus("nada que rehacer");
  undoHistory.past.push(undoHistory.current);
  restoreSnapshot(undoHistory.future.pop());
}

function syncHistoryUI() {
  const u = $("btn-undo");
  const r = $("btn-redo");
  if (u) u.disabled = busy || !undoHistory.past.length;
  if (r) r.disabled = busy || !undoHistory.future.length;
}

// ── IMAGE LOADING ───────────────────────────────

// First pages of a PDF rasterised to PNG blobs (~300 dpi, long side capped)
async function pdfToBlobs(file, maxPages = 1) {
  if (!window.pdfjsLib) throw new Error("no se pudo cargar el lector de PDF");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = pdf.numPages;
  const blobs = [];
  for (let n = 1; n <= Math.min(pages, maxPages); n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / 72, 5000 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const cnv = document.createElement("canvas");
    cnv.width = Math.round(vp.width);
    cnv.height = Math.round(vp.height);
    const ctx = cnv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cnv.width, cnv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    blobs.push(await new Promise((res) => cnv.toBlob(res, "image/png")));
  }
  pdf.destroy();
  return { blobs, pages };
}

async function pdfToBlob(file) {
  const { blobs, pages } = await pdfToBlobs(file, 1);
  return { blob: blobs[0], pages };
}

async function loadFile(file) {
  if (!file || busy) return;
  if (state.project === "zine") return addZineFiles([file]);
  if (state.project === "flip") return loadFlipVideo(file);
  const isPDF = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPDF && !/^image\/(jpeg|png|webp)$/.test(file.type)) {
    setStatus("formato no soportado: usa JPG, PNG, WebP o PDF");
    return;
  }
  setStatus("cargando…");
  let blob = file;
  let note = "";
  if (isPDF) {
    try {
      setStatus("leyendo PDF…");
      const r = await pdfToBlob(file);
      blob = r.blob;
      if (r.pages > 1) note = ` (página 1 de ${r.pages})`;
    } catch (err) {
      console.error(err);
      setStatus("no se pudo leer el PDF");
      return;
    }
  }
  const url = URL.createObjectURL(blob);
  loadImage(
    url,
    (img) => {
      URL.revokeObjectURL(url);
      posterImg = img;
      posterInfo = { name: file.name + note, w: img.width, h: img.height };
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

// What gets exported: one source, or one per flipbook sheet (composed on demand)
function exportSheetCount() {
  return state.project === "flip" ? flipSheetCount() : 1;
}

function sheetLabel(s, total) {
  return total > 1 ? ` · hoja ${s + 1}/${total}` : "";
}

// After the ink in file names, so files sort by drum: …_1-azul_hoja01.png
function sheetFile(s, total) {
  return total > 1 ? `_hoja${String(s + 1).padStart(2, "0")}` : "";
}

// Separate + screen the visible layers of one sheet at 300 dpi
async function renderExportLayers(sheet = 0) {
  const total = exportSheetCount();
  const img = state.project === "flip" ? composeFlipSheet(sheet) : srcImg;
  const [PW, PH] = exportSize();
  const { rect, crop } = placeImage(printableRect(PW, PH), img.width, img.height);
  const pxScale = PW / previewSize()[0]; // scales halftone frequency / dither grain to match preview
  const visible = visibleLayers();

  setStatus(`procesando…${sheetLabel(sheet, total)} separando a 300 dpi`);
  await nextFrame();
  const src = renderSource(rect.w, rect.h, crop, img);
  const wantedIdx = new Set(visible.map((v) => v.i));
  const maps = computeInkMaps(src, (i) => wantedIdx.has(i));
  src.remove();

  const marksIdx = state.project === "flip" ? flipMarksLayer() : -1;
  const layers = [];
  for (let k = 0; k < visible.length; k++) {
    const { L, i } = visible[k];
    setStatus(`procesando…${sheetLabel(sheet, total)} trama capa ${k + 1}/${visible.length}`);
    await nextFrame();
    const gray = screenLayer(maps[i], rect.w, rect.h, screenOf(L), L.angle, pxScale);
    if (i === marksIdx) overlayFlipMarks(gray, rect.w, rect.h, sheet); // cut marks + numbers, solid ink
    layers.push({ ink: inkBySlug(L.ink), density: L.density, gray });
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
    orientation: pageOrientation() === "portrait" ? "p" : "l",
    unit: "mm",
    format: state.format.toLowerCase(),
    compress: true,
  });
}

// PNG (lossless) page image, full page size
function addPageImage(doc, url, first) {
  const [mw, mh] = pageMM();
  if (!first) doc.addPage(state.format.toLowerCase(), pageOrientation() === "portrait" ? "p" : "l");
  doc.addImage(url, "PNG", 0, 0, mw, mh, undefined, "FAST");
}

// Name every page: Acrobat shows page labels in the page-number box and the
// thumbnails ("1 · Azul"), and the same names go into the bookmarks for
// viewers that ignore labels (e.g. macOS Preview). Metadata only: nothing is
// printed on the masters. jsPDF has no API for /PageLabels, so it is written
// into the document catalog; strings are UTF-16BE so accents survive.
function labelPDFPages(doc, labels) {
  const pdfString = (str) =>
    "<FEFF" +
    Array.from({ length: str.length }, (_, i) => str.charCodeAt(i).toString(16).padStart(4, "0")).join("").toUpperCase() +
    ">";
  doc.internal.events.subscribe("putCatalog", () => {
    const nums = labels.map((label, i) => `${i} << /P ${pdfString(label)} >>`).join(" ");
    doc.internal.write(`/PageLabels << /Nums [${nums}] >>`);
  });
  if (doc.outline) labels.forEach((label, i) => doc.outline.add(null, label, { pageNumber: i + 1 }));
}

// color: layers in ink colour (else greyscale masters). composite: add the overprint page first.
// Several sheets (flipbook) are ordered by drum: every sheet of ink 1, then
// every sheet of ink 2… so each drum goes through the riso once.
async function exportPDF(color, composite = color) {
  const total = exportSheetCount();
  const [PW, PH] = exportSize();
  const page = createPage(PW, PH);
  const pages = []; // { group: -1 composite | layer k, sheet, label, url }
  let inks = [];
  try {
    for (let s = 0; s < total; s++) {
      const out = await renderExportLayers(s);
      inks = out.layers;
      if (composite) {
        setStatus(`procesando…${sheetLabel(s, total)} composición`);
        await nextFrame();
        fillCompositePage(page, out.rect, out.layers);
        pages.push({ group: -1, sheet: s, label: `Composición${sheetLabel(s, total)}`, url: page.g.elt.toDataURL("image/png") });
      }
      for (let k = 0; k < out.layers.length; k++) {
        setStatus(`procesando…${sheetLabel(s, total)} página capa ${k + 1}/${out.layers.length}`);
        await nextFrame();
        const layer = out.layers[k];
        fillLayerPage(page, out.rect, layer, color ? layer.ink.rgb : null);
        pages.push({
          group: k,
          sheet: s,
          label: `${k + 1} · ${layer.ink.name}${sheetLabel(s, total)}`, // same order as the file name suffix
          url: page.g.elt.toDataURL("image/png"),
        });
      }
    }
  } finally {
    page.g.remove();
  }
  pages.sort((a, b) => a.group - b.group || a.sheet - b.sheet);
  setStatus("procesando… armando PDF");
  await nextFrame();
  const doc = newPDF();
  pages.forEach((p, n) => addPageImage(doc, p.url, n === 0));
  labelPDFPages(doc, pages.map((p) => p.label));
  const name = `riso_${color ? (composite ? "color" : "capas_color") : "bn"}_${fileTag()}_${inkSuffix(inks)}.pdf`;
  doc.save(name);
  return name;
}

async function exportPNGLayers(color = false) {
  const total = exportSheetCount();
  const [PW, PH] = exportSize();
  const page = createPage(PW, PH);
  let files = 0;
  try {
    for (let s = 0; s < total; s++) {
      const out = await renderExportLayers(s);
      for (let k = 0; k < out.layers.length; k++) {
        setStatus(`procesando…${sheetLabel(s, total)} png capa ${k + 1}/${out.layers.length}`);
        await nextFrame();
        const layer = out.layers[k];
        fillLayerPage(page, out.rect, layer, color ? layer.ink.rgb : null);
        downloadBlob(
          await pagePNG(page),
          `riso_${color ? "color_" : ""}${fileTag()}_${k + 1}-${layer.ink.slug}${sheetFile(s, total)}.png`,
        );
        files++;
        await new Promise((res) => setTimeout(res, 350)); // let the browser start each download
      }
    }
  } finally {
    page.g.remove();
  }
  return `${files} png`;
}

// One 300 dpi PNG per sheet of the overprinted inks, as the riso would print them
async function exportPNGColor() {
  const total = exportSheetCount();
  const [PW, PH] = exportSize();
  const page = createPage(PW, PH);
  let name = "";
  try {
    for (let s = 0; s < total; s++) {
      const out = await renderExportLayers(s);
      setStatus(`procesando…${sheetLabel(s, total)} composición`);
      await nextFrame();
      fillCompositePage(page, out.rect, out.layers);
      name = `riso_color_${fileTag()}_${inkSuffix(out.layers)}${sheetFile(s, total)}.png`;
      downloadBlob(await pagePNG(page), name);
      if (total > 1) await new Promise((res) => setTimeout(res, 350));
    }
  } finally {
    page.g.remove();
  }
  return total > 1 ? `${total} png` : name;
}

// Page buffer → PNG tagged with its print resolution
async function pagePNG(page) {
  const blob = await new Promise((res) => page.g.elt.toBlob(res, "image/png"));
  return pngWithDPI(blob, EXPORT_DPI);
}

// Browsers write PNGs without a resolution chunk, so apps open them at 72 dpi
// (an A3 page would show up as ~1.2 m wide). Insert pHYs right after IHDR.
async function pngWithDPI(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254); // pixels per metre
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); // data length
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // 8-byte signature + IHDR chunk (4 length + 4 type + 13 data + 4 crc)
  return new Blob([src.subarray(0, at), chunk, src.subarray(at)], { type: "image/png" });
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
  const el = $("meta-status");
  el.textContent = msg;
  el.classList.toggle("working", /^(procesando|cargando|leyendo)/.test(msg));
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
  // Empty canvas: a click anywhere opens the file picker
  area.addEventListener("click", (e) => {
    if (srcImg || busy || e.target.closest(".zoom-controls, .history-controls, .sheet-nav, .help-btn")) return;
    if (state.project === "zine") openZinePicker();
    else if (state.project === "flip") $("flip-input").click();
    else $("file-input").click();
  });

  // Undo / redo: ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y elsewhere)
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const mod = mac ? "⌘" : "Ctrl+";
  $("btn-undo").title = `Deshacer (${mod}Z)`;
  $("btn-redo").title = `Rehacer (${mac ? "⇧⌘Z" : "Ctrl+Y"})`;
  $("btn-undo").addEventListener("click", undo);
  $("btn-redo").addEventListener("click", redo);
  window.addEventListener("keydown", (e) => {
    if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (k === "y" && !mac) {
      e.preventDefault();
      redo();
    }
  });
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
    if (state.project === "zine") addZineFiles(e.dataTransfer.files);
    else if (state.project === "flip") loadFlipVideo(e.dataTransfer.files[0]);
    else loadFile(e.dataTransfer.files[0]);
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
  onPick("toggle-remap", (v) => {
    const on = v === "remap";
    if (on === state.remap) return;
    state.remap = on;
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
      recordHistory();
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
    editScreen((s) => (s.frequency = parseFloat(e.target.value)), DEBOUNCE_MS),
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

  // Project: poster | 8-page zine
  onPick("toggle-project", (v) => {
    if (v === state.project) return;
    state.project = v;
    syncUI();
    schedule(STAGE.REBUILD);
  });
  bindZineUI();
  bindFlipUI();
  bindRecolorUI();

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
  onPick("toggle-fit", (v) => {
    if (v === state.fit) return;
    state.fit = v;
    syncUI();
    schedule(STAGE.REBUILD);
  });

  // Export
  $("btn-pdf-color").addEventListener("click", () => runExport(() => exportPDF(true)));
  $("btn-pdf-layers-color").addEventListener("click", () => runExport(() => exportPDF(true, false)));
  $("btn-pdf-bw").addEventListener("click", () => runExport(() => exportPDF(false)));
  $("btn-png-color").addEventListener("click", () => runExport(exportPNGColor));
  $("btn-png-layers").addEventListener("click", () => runExport(() => exportPNGLayers(false)));
  $("btn-png-layers-color").addEventListener("click", () => runExport(() => exportPNGLayers(true)));
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
  syncSource();
  const zine = state.project === "zine";
  const flip = state.project === "flip";
  setActive("toggle-project", state.project);
  $("panel-poster").hidden = zine || flip;
  $("panel-zine").hidden = !zine;
  $("panel-flip").hidden = !flip;
  $("flip-layout").hidden = !flip;
  $("row-fit").hidden = flip; // flipbook frames keep the video's proportion
  if (zine) renderZine();
  if (flip) syncFlipUI();
  else $("sheet-nav").hidden = true;
  $("toggle-orientation").classList.toggle("is-locked", zine);
  $("toggle-orientation").title = zine ? "el fanzine se imprime en una hoja horizontal" : "";
  $("meta-page").textContent = zine ? zinePageMeta() : "";

  setActive("toggle-workshop", state.workshop);
  setActive("group-mode", state.mode);
  setActive("toggle-remap", state.remap ? "remap" : "mix");
  $("row-remap").hidden = state.mode !== "auto";
  renderRemapList();
  setActive("toggle-format", state.format);
  setActive("toggle-orientation", pageOrientation());
  setActive("toggle-fit", state.fit);

  $("canvas-area").classList.toggle("empty", !srcImg);
  $("meta-image").textContent = srcInfo
    ? `${srcInfo.name} · ${srcInfo.w} × ${srcInfo.h} px`
    : "sin imagen · también puedes arrastrarla al lienzo";

  const modeMeta = {
    auto: "",
    cmyk: "cada capa imprime un canal c / m / y / k",
    rgb: "cada capa imprime donde falta su canal r / g / b",
  };
  $("meta-mode").textContent = modeMeta[state.mode];

  renderLayers();
  renderColorRules();
  $("btn-add-layer").disabled = state.layers.length >= MAX_LAYERS;
  $("meta-layers").textContent = `${state.layers.length} de ${MAX_LAYERS} · ${currentWorkshop().name}`;

  syncScreenUI();
  syncBusy();
}

// Material Symbols (loaded in index.html)
const ICON_EYE = '<span class="ms" aria-hidden="true">visibility</span>';
const ICON_EYE_OFF = '<span class="ms" aria-hidden="true">visibility_off</span>';
const ICON_REMOVE = '<span class="ms" aria-hidden="true">close</span>';

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
            <button class="icon-btn" type="button" data-act="visible" title="${L.visible ? "ocultar capa" : "mostrar capa"}" aria-pressed="${L.visible}">${L.visible ? ICON_EYE : ICON_EYE_OFF}</button>
            <button class="icon-btn" type="button" data-act="remove" title="quitar capa"${single ? " disabled" : ""}>${ICON_REMOVE}</button>
          </div>
          ${channelToggleHTML(L)}
          <div class="slider-row">
            <div class="slider-head">
              <span class="row-label">Densidad</span>
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
        `<button class="seg-btn${k === current ? " active" : ""}" type="button" data-act="channel" data-value="${k}">${c.toUpperCase()}</button>`,
    )
    .join("");
  return `<div class="layer-channel"><span class="row-label">Canal</span><div class="seg">${buttons}</div></div>`;
}

function syncScreenUI() {
  if (state.scope !== "global" && !scopeLayer()) state.scope = "global";
  const L = scopeLayer();
  const cfg = L ? screenOf(L) : state.screen;

  // Scope toggle: Global | ● 1 | ● 2* ...  (dot = the layer's ink, * = own screen)
  $("toggle-scope").innerHTML =
    `<button class="seg-btn" type="button" data-value="global">Global</button>` +
    state.layers
      .map((x, i) => {
        const ink = inkBySlug(x.ink);
        return `<button class="seg-btn" type="button" data-value="${x.uid}" title="capa ${i + 1} · ${ink.name}"><span class="seg-dot" style="background:${ink.hex}"></span>${i + 1}${x.screen ? "*" : ""}</button>`;
      })
      .join("");
  setActive("toggle-scope", state.scope);

  $("btn-follow").hidden = !L;
  if (L) {
    $("btn-follow").classList.toggle("on", !L.screen);
    const idx = state.layers.indexOf(L) + 1;
    const name = `capa ${idx} · ${inkBySlug(L.ink).name}`;
    $("meta-scope").textContent = L.screen
      ? `${name}: trama propia`
      : `${name}: sigue la trama global · al cambiar algo pasa a tener trama propia`;
  } else {
    $("meta-scope").textContent = "";
  }

  setActive("group-style", cfg.style);
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
  syncHistoryUI();
  document.querySelector(".sidebar").classList.toggle("busy", busy);
  document.querySelectorAll(".btn-export").forEach((b) => {
    b.disabled = busy || !srcImg;
  });
}
