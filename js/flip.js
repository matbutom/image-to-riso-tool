/*
  flip.js — flipbooks from a video.

  1. A video is loaded into the sidebar player; the user marks a start and an
     end and how many frames to take, evenly spaced in that range.
  2. Frames are laid out on A4/A3 sheets: each card is a binding strip (left,
     blank, for staples or glue: margin X) plus the frame, with a blank band
     above and below it (margin Y), in a grid sized to fit as
     many cards as possible. Sheets are composed one at a time and fed to the
     normal pipeline (separation, screens, exports).
  3. Cut marks and frame numbers are not part of the image: they are drawn
     straight into one ink layer after screening (overlayFlipMarks), in solid
     ink, so they print once, in register, on a single drum.

  Layout lives in state.flip (undoable); the video and its frames don't.
*/

const FLIP_FRAME_MM = { s: 40, m: 60, l: 90 }; // frame width for chico / mediano / grande
const FLIP_INSET_MM = 5; // band inside the printable area for the outer cut marks
const FLIP_MARK_MM = 3.5; // cut mark length
const FLIP_MARK_GAP_MM = 1; // gap between a mark and the card edge
const FLIP_LINE_MM = 0.1; // hairline
const FLIP_NUMBER_MM = 2; // frame number cap height (~6 pt)
const FLIP_FRAME_PX = 900; // long side of stored frames for many frames (≈ 250–380 dpi on small cards)
const FLIP_AUTO_MIN_MM = 40; // auto size: frames never narrower than this (more sheets instead)

// Long side of stored frames: few frames get big cards in auto mode, so keep
// more pixels (memory stays bounded: few frames × bigger, or many × smaller)
function flipFramePx(count) {
  if (count <= 16) return 1800;
  if (count <= 48) return 1300;
  return FLIP_FRAME_PX;
}

// Grid for n cards that gives the widest frame inside gw x gh (mm)
function bestFlipGrid(n, gw, gh, binding, marginY) {
  let best = { cols: 1, rows: n, frameW: -Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const frameW = Math.min(gw / cols - binding, (gh / rows - 2 * marginY) * flipAspect);
    if (frameW > best.frameW + 1e-9) best = { cols, rows, frameW };
  }
  return best;
}
const FLIP_MAX_FRAMES = 240;

const flipVideo = { el: null, url: null, name: "", duration: 0, w: 0, h: 0, start: 0, end: 0, count: 24 };
let flipFrames = []; // canvases, in order
let flipAspect = 16 / 9; // aspect of the extracted frames
let flipSheetIndex = 0; // sheet shown in the preview
let flipSheet = null; // { img, key } composed sheet for the preview
let flipExtracting = false;

// ── LAYOUT ──────────────────────────────────────

function printableMM() {
  return orient(PRINTABLE_MM[state.format]);
}

// Card grid in mm, relative to the printable area's top-left corner
function flipLayout() {
  const [aw, ah] = printableMM();
  const gw = aw - 2 * FLIP_INSET_MM;
  const gh = ah - 2 * FLIP_INSET_MM;
  const binding = state.flip.binding; // margin X: left strip
  const marginY = state.flip.marginY; // margin Y: above and below the frame
  const largest = Math.max(1, Math.min(gw - binding, (gh - 2 * marginY) * flipAspect)); // one card per sheet
  let frameW;
  let cols;
  let rows;
  let perSheet;
  if (state.flip.size === "auto") {
    // Auto: as few sheets as the minimum frame size allows, frames shared
    // evenly between them, then the grid that makes them as big as possible
    const n = Math.max(1, flipFrames.length);
    const minW = Math.min(FLIP_AUTO_MIN_MM, largest);
    const capacity =
      Math.max(1, Math.floor(gw / (binding + minW))) *
      Math.max(1, Math.floor(gh / (minW / flipAspect + 2 * marginY)));
    const sheets = Math.ceil(n / capacity);
    perSheet = Math.ceil(n / sheets);
    const grid = bestFlipGrid(perSheet, gw, gh, binding, marginY);
    frameW = Math.max(1, Math.min(grid.frameW, largest));
    cols = grid.cols;
    rows = grid.rows;
  } else {
    frameW = Math.max(1, Math.min(FLIP_FRAME_MM[state.flip.size], largest)); // a single card always fits
    cols = Math.max(1, Math.floor(gw / (binding + frameW)));
    rows = Math.max(1, Math.floor(gh / (frameW / flipAspect + 2 * marginY)));
    perSheet = cols * rows;
  }
  const frameH = frameW / flipAspect;
  // Auto: the space the frames can't use (they keep the video's proportion)
  // goes inside the cards — right of the frame (the thumb edge) and above and
  // below it — so the cards cover the whole sheet and still share cut lines
  let padR = 0;
  let padY = marginY;
  if (state.flip.size === "auto") {
    padR = Math.max(0, gw / cols - binding - frameW);
    padY = Math.max(marginY, (gh / rows - frameH) / 2);
  }
  const cardW = binding + frameW + padR;
  const cardH = padY + frameH + padY;
  return {
    cols,
    rows,
    perSheet,
    binding,
    marginY: padY, // margin above / below the frame inside the card
    padR,
    frameW,
    frameH,
    cardW,
    cardH,
    ox: FLIP_INSET_MM + (gw - cols * cardW) / 2,
    oy: FLIP_INSET_MM + (gh - rows * cardH) / 2,
    aw,
    ah,
  };
}

function flipSheetCount() {
  return flipFrames.length ? Math.ceil(flipFrames.length / flipLayout().perSheet) : 0;
}

// Cards of one sheet: { n (global frame index), x, y } in mm
function flipCards(sheet, L = flipLayout()) {
  const cards = [];
  for (let k = 0; k < L.perSheet; k++) {
    const n = sheet * L.perSheet + k;
    if (n >= flipFrames.length) break;
    const col = k % L.cols;
    const row = Math.floor(k / L.cols);
    cards.push({ n, x: L.ox + col * L.cardW, y: L.oy + row * L.cardH });
  }
  return cards;
}

// ── SHEETS ──────────────────────────────────────

function flipKey(sheet) {
  return JSON.stringify([sheet, state.format, state.orientation, state.flip.size, state.flip.binding, state.flip.marginY, flipFrames.length, flipAspect]);
}

// The sheet shown in the preview, composed when needed
function ensureFlipSheet() {
  const total = flipSheetCount();
  if (!total) {
    flipSheet = null;
    return null;
  }
  flipSheetIndex = Math.min(flipSheetIndex, total - 1);
  const key = flipKey(flipSheetIndex);
  if (!flipSheet || flipSheet.key !== key) flipSheet = { img: composeFlipSheet(flipSheetIndex), key };
  return flipSheet;
}

// One sheet at 300 dpi, the size of the printable area: frames only (marks
// and numbers go into an ink layer later)
function composeFlipSheet(sheet) {
  const [PW, PH] = exportSize();
  const r = printableRect(PW, PH);
  const W = Math.round(r.w);
  const H = Math.round(r.h);
  const L = flipLayout();
  const k = W / L.aw; // px per mm
  const g = createGraphics(W, H);
  g.pixelDensity(1);
  const ctx = g.drawingContext;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  flipCards(sheet, L).forEach(({ n, x, y }) => {
    const x0 = Math.round((x + L.binding) * k);
    const y0 = Math.round((y + L.marginY) * k);
    const x1 = Math.round((x + L.binding + L.frameW) * k);
    const y1 = Math.round((y + L.marginY + L.frameH) * k);
    ctx.drawImage(flipFrames[n], x0, y0, x1 - x0, y1 - y0);
  });
  const img = g.get();
  g.remove();
  return img;
}

// ── MARKS + NUMBERS (printed in one ink layer) ──

// Layer index that carries marks and numbers: the chosen one, or the darkest ink
function flipMarksLayer(candidates = state.layers.map((_, i) => i)) {
  if (state.flip.marks !== "auto") {
    const i = state.layers.findIndex((L) => String(L.uid) === String(state.flip.marks));
    if (i >= 0) return i;
  }
  let best = -1;
  let bestLum = Infinity;
  candidates.forEach((i) => {
    const [r, g, b] = inkBySlug(state.layers[i].ink).rgb;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < bestLum) {
      bestLum = lum;
      best = i;
    }
  });
  return best;
}

// Outer cut marks at every card edge (in the inset band, so a guillotine can
// cut the whole stack) and each frame's number in the binding strip corner
function drawFlipMarks(ctx, pxmm, sheet) {
  const L = flipLayout();
  const cards = flipCards(sheet, L);
  if (!cards.length) return;
  const usedCols = Math.min(L.cols, cards.length);
  const usedRows = Math.ceil(cards.length / L.cols);
  const lw = Math.max(1, FLIP_LINE_MM * pxmm);
  const snap = (v) => Math.round(v * pxmm) + (Math.round(lw) % 2 ? 0.5 : 0);
  const x0 = L.ox;
  const y0 = L.oy;
  const x1 = L.ox + usedCols * L.cardW;
  const y1 = L.oy + usedRows * L.cardH;

  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = Math.round(lw);
  ctx.beginPath();
  for (let c = 0; c <= usedCols; c++) {
    const x = snap(L.ox + c * L.cardW);
    ctx.moveTo(x, (y0 - FLIP_MARK_GAP_MM - FLIP_MARK_MM) * pxmm);
    ctx.lineTo(x, (y0 - FLIP_MARK_GAP_MM) * pxmm);
    ctx.moveTo(x, (y1 + FLIP_MARK_GAP_MM) * pxmm);
    ctx.lineTo(x, (y1 + FLIP_MARK_GAP_MM + FLIP_MARK_MM) * pxmm);
  }
  for (let r = 0; r <= usedRows; r++) {
    const y = snap(L.oy + r * L.cardH);
    ctx.moveTo((x0 - FLIP_MARK_GAP_MM - FLIP_MARK_MM) * pxmm, y);
    ctx.lineTo((x0 - FLIP_MARK_GAP_MM) * pxmm, y);
    ctx.moveTo((x1 + FLIP_MARK_GAP_MM) * pxmm, y);
    ctx.lineTo((x1 + FLIP_MARK_GAP_MM + FLIP_MARK_MM) * pxmm, y);
  }
  ctx.stroke();

  // frame numbers: bottom-left corner of the binding strip (or of the frame)
  const size = Math.max(5, FLIP_NUMBER_MM * 1.4 * pxmm);
  ctx.fillStyle = "#000";
  ctx.font = `700 ${size}px "Space Mono", monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  cards.forEach(({ n, x, y }) => {
    ctx.fillText(String(n + 1), (x + 1.2) * pxmm, (y + L.cardH - 1.2) * pxmm);
  });
  ctx.restore();
}

// Burn the marks into a screened layer (0 = ink), solid and unscreened
function overlayFlipMarks(gray, w, h, sheet) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  drawFlipMarks(ctx, w / printableMM()[0], sheet);
  const a = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0, p = 3; i < gray.length; i++, p += 4) if (a[p] > 96) gray[i] = 0;
  return gray;
}

// ── VIDEO ───────────────────────────────────────

function fmtTime(s) {
  return `${s.toFixed(2)} s`;
}

async function loadFlipVideo(file) {
  if (!file || busy || flipExtracting) return;
  if (!/^video\//.test(file.type) && !/\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)) {
    setStatus("formato no soportado: usa un video MP4, WebM o MOV");
    return;
  }
  const v = $("flip-video");
  if (flipVideo.url) URL.revokeObjectURL(flipVideo.url);
  flipVideo.url = URL.createObjectURL(file);
  flipVideo.name = file.name;
  setStatus("cargando video…");
  v.src = flipVideo.url;
  try {
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error("no se pudo leer el video"));
    });
  } catch (err) {
    setStatus("no se pudo leer el video (prueba con MP4 H.264 o WebM)");
    return;
  }
  flipVideo.el = v;
  flipVideo.duration = v.duration;
  flipVideo.w = v.videoWidth;
  flipVideo.h = v.videoHeight;
  flipVideo.start = 0;
  flipVideo.end = Math.min(v.duration, 3);
  flipVideo.count = Math.max(2, Math.min(FLIP_MAX_FRAMES, Math.round((flipVideo.end - flipVideo.start) * 8)));
  syncFlipVideoUI();
  setStatus("elige el tramo y cuántos frames, luego Extraer");
  syncUI();
}

// Seek and wait for the frame. Some files (e.g. WebM without a cue index)
// can stall a seek: give up after SEEK_TIMEOUT_MS and take what is decoded.
const SEEK_TIMEOUT_MS = 3000;
function seek(v, t) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener("seeked", done);
      resolve();
    };
    v.addEventListener("seeked", done);
    timer = setTimeout(done, SEEK_TIMEOUT_MS);
    v.currentTime = t;
  });
}

// Evenly spaced frames between start and end (both included)
async function extractFlipFrames() {
  const v = flipVideo.el;
  if (!v || busy || flipExtracting) return;
  flipExtracting = true;
  syncFlipVideoUI();
  v.pause();
  const { start, end, count } = flipVideo;
  const s = Math.min(1, flipFramePx(count) / Math.max(flipVideo.w, flipVideo.h));
  const fw = Math.max(1, Math.round(flipVideo.w * s));
  const fh = Math.max(1, Math.round(flipVideo.h * s));
  const frames = [];
  try {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? start : start + ((end - start) * i) / (count - 1);
      setStatus(`extrayendo frame ${i + 1}/${count}…`);
      await seek(v, Math.min(t, Math.max(0, flipVideo.duration - 0.001)));
      const c = document.createElement("canvas");
      c.width = fw;
      c.height = fh;
      c.getContext("2d").drawImage(v, 0, 0, fw, fh);
      frames.push(c);
    }
  } catch (err) {
    console.error(err);
    setStatus("error al extraer los frames");
    flipExtracting = false;
    syncFlipVideoUI();
    return;
  }
  flipFrames = frames;
  flipAspect = fw / fh;
  flipSheetIndex = 0;
  flipSheet = null;
  flipExtracting = false;
  syncFlipVideoUI();
  syncUI();
  schedule(STAGE.REBUILD);
}

// ── SIDEBAR + SHEET NAVIGATION ──────────────────

function syncFlipVideoUI() {
  const has = !!flipVideo.el;
  $("flip-video").hidden = !has;
  $("flip-range").hidden = !has;
  $("meta-video").textContent = has
    ? `${flipVideo.name} · ${flipVideo.w} × ${flipVideo.h} px · ${fmtTime(flipVideo.duration)}`
    : "sin video · también puedes arrastrarlo al lienzo";
  if (!has) return;
  const d = flipVideo.duration;
  for (const [id, key] of [
    ["slider-flip-start", "start"],
    ["slider-flip-end", "end"],
  ]) {
    const el = $(id);
    el.max = d.toFixed(3);
    el.value = flipVideo[key];
  }
  $("val-flip-start").textContent = fmtTime(flipVideo.start);
  $("val-flip-end").textContent = fmtTime(flipVideo.end);
  $("slider-flip-count").value = flipVideo.count;
  const span = Math.max(0.001, flipVideo.end - flipVideo.start);
  $("val-flip-count").textContent = `${flipVideo.count} · ≈ ${(flipVideo.count / span).toFixed(1)} fps`;
  const btn = $("btn-flip-extract");
  btn.disabled = flipExtracting || busy;
  btn.lastChild.textContent = flipExtracting ? "Extrayendo…" : "Extraer frames";
}

function flipLayoutMeta() {
  const L = flipLayout();
  const mm = (v) => Math.round(v * 10) / 10;
  return `tamaño de cada tarjeta: ${mm(L.cardW)} × ${mm(L.cardH)} mm`;
}

// Layer picker for marks: Auto | ● 1 | ● 2 ...
function renderFlipMarksToggle() {
  $("toggle-flip-marks").innerHTML =
    `<button class="seg-btn" type="button" data-value="auto" title="la tinta más oscura">Auto</button>` +
    state.layers
      .map((L, i) => {
        const ink = inkBySlug(L.ink);
        return `<button class="seg-btn" type="button" data-value="${L.uid}" title="capa ${i + 1} · ${ink.name}"><span class="seg-dot" style="background:${ink.hex}"></span>${i + 1}</button>`;
      })
      .join("");
  setActive("toggle-flip-marks", String(state.flip.marks));
}

function syncFlipUI() {
  setActive("toggle-flip-size", state.flip.size);
  $("slider-flip-binding").value = state.flip.binding;
  $("val-flip-binding").textContent = `${state.flip.binding} mm`;
  $("slider-flip-margin-y").value = state.flip.marginY;
  $("val-flip-margin-y").textContent = `${state.flip.marginY} mm`;
  $("meta-flip-layout").textContent = flipLayoutMeta();
  renderFlipMarksToggle();
  const total = flipSheetCount();
  const nav = $("sheet-nav");
  nav.hidden = total < 2;
  $("sheet-label").textContent = `hoja ${Math.min(flipSheetIndex + 1, total)} / ${total}`;
  $("sheet-prev").disabled = flipSheetIndex <= 0;
  $("sheet-next").disabled = flipSheetIndex >= total - 1;
}

function bindFlipUI() {
  $("btn-flip-video").addEventListener("click", () => $("flip-input").click());
  $("flip-input").addEventListener("change", (e) => {
    loadFlipVideo(e.target.files[0]);
    e.target.value = "";
  });

  const range = (key) => (e) => {
    const v = parseFloat(e.target.value);
    if (key === "start") flipVideo.start = Math.min(v, flipVideo.end);
    else flipVideo.end = Math.max(v, flipVideo.start);
    if (flipVideo.el) flipVideo.el.currentTime = flipVideo[key]; // show that frame
    syncFlipVideoUI();
  };
  $("slider-flip-start").addEventListener("input", range("start"));
  $("slider-flip-end").addEventListener("input", range("end"));
  $("btn-flip-mark-start").addEventListener("click", () => {
    flipVideo.start = Math.min(flipVideo.el.currentTime, flipVideo.end);
    syncFlipVideoUI();
  });
  $("btn-flip-mark-end").addEventListener("click", () => {
    flipVideo.end = Math.max(flipVideo.el.currentTime, flipVideo.start);
    syncFlipVideoUI();
  });
  $("slider-flip-count").max = FLIP_MAX_FRAMES;
  $("slider-flip-count").addEventListener("input", (e) => {
    flipVideo.count = parseInt(e.target.value, 10);
    syncFlipVideoUI();
  });
  $("btn-flip-extract").addEventListener("click", extractFlipFrames);

  onPick("toggle-flip-size", (v) => {
    if (v === state.flip.size) return;
    state.flip.size = v;
    syncUI();
    schedule(STAGE.REBUILD);
  });
  $("slider-flip-margin-y").addEventListener("input", (e) => {
    state.flip.marginY = parseFloat(e.target.value);
    syncFlipUI();
    schedule(STAGE.REBUILD, DEBOUNCE_MS);
  });
  $("slider-flip-binding").addEventListener("input", (e) => {
    state.flip.binding = parseInt(e.target.value, 10);
    syncFlipUI();
    schedule(STAGE.REBUILD, DEBOUNCE_MS);
  });
  onPick("toggle-flip-marks", (v) => {
    state.flip.marks = v === "auto" ? "auto" : parseInt(v, 10);
    syncFlipUI();
    schedule(STAGE.SCREEN);
  });

  const go = (d) => {
    const total = flipSheetCount();
    const next = Math.max(0, Math.min(total - 1, flipSheetIndex + d));
    if (next === flipSheetIndex) return;
    flipSheetIndex = next;
    syncFlipUI();
    schedule(STAGE.REBUILD);
  };
  $("sheet-prev").addEventListener("click", () => go(-1));
  $("sheet-next").addEventListener("click", () => go(1));
  window.addEventListener("keydown", (e) => {
    if (state.project !== "flip" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  });
}
