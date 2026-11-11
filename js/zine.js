/*
  zine.js — 8-page fanzine from a single sheet.

  The 8 pages are imposed on one landscape sheet (4 columns × 2 rows, top row
  upside down, cut along the middle between columns 2 and 3) and composed into
  one image. That image becomes the pipeline source (srcImg), so separation,
  screens, undo and exports work exactly as for a poster: what you export is
  the sheet that goes through the riso.

  Page order lives in state.zine (ids, so undo/redo restores it); the images
  themselves live in zineImages and are never deleted while the page is open.
*/

const ZINE_PAGES = 8;
const ZINE_LABELS = ["Portada", "2", "3", "4", "5", "6", "7", "Contra"];

// Standard one-sheet mini zine, sheet seen from the printed side:
//   ┌───┬───┬───┬───┐
//   │ 5 │ 4 │ 3 │ 2 │  ← upside down
//   ├───┼───┼───┼───┤
//   │ 6 │ 7 │ 8 │ 1 │  ← 1 front cover, 8 back cover
//   └───┴───┴───┴───┘
const ZINE_IMPOSITION = [
  { page: 5, col: 0, row: 0, flip: true },
  { page: 4, col: 1, row: 0, flip: true },
  { page: 3, col: 2, row: 0, flip: true },
  { page: 2, col: 3, row: 0, flip: true },
  { page: 6, col: 0, row: 1, flip: false },
  { page: 7, col: 1, row: 1, flip: false },
  { page: 8, col: 2, row: 1, flip: false },
  { page: 1, col: 3, row: 1, flip: false },
];

const ZINE_MAX_PDF_PAGES = 16;
const THUMB_PX = 160;

const zineImages = new Map(); // id → { img: p5.Image, name, thumb: dataURL }
let zineSeq = 0;
let zineSheet = null; // { img, key } composed sheet for the current pages/format/fit
let zineSelection = null; // { kind: "slot", i } | { kind: "tray", id } (click-to-swap)
let zineTargetSlot = null; // slot that asked for a file (click on an empty page)

// ── SOURCE ──────────────────────────────────────

function zineAssignedCount() {
  return state.zine.pages.filter(Boolean).length;
}

// Compose the sheet if pages, format or fit changed. Cheap when nothing did.
function ensureZineSheet() {
  if (!zineAssignedCount()) {
    zineSheet = null;
    return null;
  }
  const key = JSON.stringify([state.zine.pages, state.format, state.fit]);
  if (zineSheet && zineSheet.key === key) return zineSheet;
  zineSheet = { img: composeZineSheet(), key };
  return zineSheet;
}

// The sheet at 300 dpi, the size of the printable area (exports never upscale it)
function composeZineSheet() {
  const [PW, PH] = exportSize();
  const r = printableRect(PW, PH);
  const W = Math.round(r.w);
  const H = Math.round(r.h);
  const g = createGraphics(W, H);
  g.pixelDensity(1);
  const ctx = g.drawingContext;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  ZINE_IMPOSITION.forEach(({ page, col, row, flip }) => {
    const entry = zineImages.get(state.zine.pages[page - 1]);
    if (!entry) return;
    const x0 = Math.round((col * W) / 4);
    const x1 = Math.round(((col + 1) * W) / 4);
    const y0 = Math.round((row * H) / 2);
    const y1 = Math.round(((row + 1) * H) / 2);
    const { rect, crop } = placeImage(
      { x: 0, y: 0, w: x1 - x0, h: y1 - y0 },
      entry.img.width,
      entry.img.height,
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    if (flip) {
      // rotate 180° about the panel centre
      ctx.translate(x0 + x1, y0 + y1);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(entry.img.canvas, crop.x, crop.y, crop.w, crop.h, x0 + rect.x, y0 + rect.y, rect.w, rect.h);
    ctx.restore();
  });

  const img = g.get();
  g.remove();
  return img;
}

// ── LOADING ─────────────────────────────────────

function loadP5Image(blob) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) =>
    loadImage(
      url,
      (img) => {
        URL.revokeObjectURL(url);
        resolve(img);
      },
      (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      },
    ),
  );
}

function makeThumb(img) {
  const s = THUMB_PX / Math.max(img.width, img.height);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img.canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}

function addZineImage(img, name) {
  const id = "z" + ++zineSeq;
  zineImages.set(id, { img, name, thumb: makeThumb(img) });
  return id;
}

// Several images and/or PDFs (one image per PDF page). They fill the empty
// pages in order, starting at the page that asked for them; the rest go to
// the tray.
async function addZineFiles(fileList) {
  if (busy) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const ids = [];
  let skipped = 0;
  for (const file of files) {
    const isPDF = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    try {
      if (isPDF) {
        setStatus(`leyendo PDF… ${file.name}`);
        const { blobs } = await pdfToBlobs(file, ZINE_MAX_PDF_PAGES);
        for (let k = 0; k < blobs.length; k++) {
          ids.push(addZineImage(await loadP5Image(blobs[k]), `${file.name} · p. ${k + 1}`));
        }
      } else if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
        setStatus(`cargando… ${file.name}`);
        ids.push(addZineImage(await loadP5Image(file), file.name));
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(err);
      skipped++;
    }
  }

  const pages = state.zine.pages;
  const explicit = zineTargetSlot != null && zineTargetSlot < ZINE_PAGES;
  let next = zineTargetSlot ?? 0; // ZINE_PAGES = straight to the tray
  zineTargetSlot = null;
  ids.forEach((id, n) => {
    // the first file goes to the page that asked for it, even if it had one
    if (n === 0 && explicit && pages[next]) state.zine.tray.unshift(pages[next]);
    else while (next < ZINE_PAGES && pages[next]) next++;
    if (next < ZINE_PAGES) pages[next++] = id;
    else state.zine.tray.push(id);
  });

  syncUI();
  schedule(STAGE.REBUILD);
  if (skipped) setTimeout(() => setStatus(`${skipped} archivo(s) no se pudieron leer · usa JPG, PNG, WebP o PDF`), 50);
}

function openZinePicker(slot = null) {
  zineTargetSlot = slot;
  $("zine-input").click();
}

// ── ORDERING ────────────────────────────────────

// Move src onto dst. slot↔slot swaps; tray→slot places it (the page's image
// goes back to the tray); slot→tray takes the image off the page.
function zineMove(src, dst) {
  const { pages, tray } = state.zine;
  if (src.kind === "slot" && dst.kind === "slot") {
    if (src.i === dst.i) return false;
    [pages[src.i], pages[dst.i]] = [pages[dst.i], pages[src.i]];
  } else if (src.kind === "tray" && dst.kind === "slot") {
    const at = tray.indexOf(src.id);
    if (at < 0) return false;
    const prev = pages[dst.i];
    pages[dst.i] = src.id;
    if (prev) tray.splice(at, 1, prev);
    else tray.splice(at, 1);
  } else if (src.kind === "slot" && dst.kind === "tray") {
    if (!pages[src.i]) return false;
    tray.push(pages[src.i]);
    pages[src.i] = null;
  } else {
    return false;
  }
  return true;
}

function zineChanged() {
  zineSelection = null;
  syncUI();
  schedule(STAGE.REBUILD);
}

// ── SIDEBAR ─────────────────────────────────────

function renderZine() {
  const { pages, tray } = state.zine;
  const sel = zineSelection;
  const isSel = (kind, v) => sel && sel.kind === kind && (kind === "slot" ? sel.i === v : sel.id === v);

  $("zine-pages").innerHTML = pages
    .map((id, i) => {
      const e = id && zineImages.get(id);
      const cls = `zine-slot${e ? "" : " empty"}${isSel("slot", i) ? " selected" : ""}`;
      const label = `<span class="slot-label">${ZINE_LABELS[i]}</span>`;
      if (!e) {
        return `<div class="${cls}" data-slot="${i}" title="Página ${ZINE_LABELS[i]} · clic para subir una imagen">
          <span class="ms" aria-hidden="true">add</span>${label}</div>`;
      }
      return `<div class="${cls} fit-${state.fit}" data-slot="${i}" draggable="true" title="${escapeHTML(e.name)}">
          <img src="${e.thumb}" alt="" draggable="false" />${label}
          <button class="slot-x" type="button" data-act="unassign" title="quitar de la página" aria-label="quitar de la página ${ZINE_LABELS[i]}">
            <span class="ms" aria-hidden="true">close</span></button></div>`;
    })
    .join("");

  $("zine-tray").innerHTML = tray.length
    ? tray
        .map((id) => {
          const e = zineImages.get(id);
          return `<div class="tray-item${isSel("tray", id) ? " selected" : ""}" data-id="${id}" draggable="true" title="${escapeHTML(e.name)}">
            <img src="${e.thumb}" alt="" draggable="false" />
            <button class="slot-x" type="button" data-act="discard" title="descartar" aria-label="descartar imagen">
              <span class="ms" aria-hidden="true">close</span></button></div>`;
        })
        .join("")
    : `<span class="tray-empty">las imágenes que quites o que sobren quedan aquí</span>`;

  const n = zineAssignedCount();
  $("meta-zine").textContent = sel
    ? "elige otra página o la bandeja para mover la imagen · esc cancela"
    : `${n} de ${ZINE_PAGES} páginas · arrastra para ordenar o haz clic en dos para intercambiarlas`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function zineTarget(el) {
  const slot = el.closest("[data-slot]");
  if (slot) return { kind: "slot", i: parseInt(slot.dataset.slot, 10), el: slot };
  const item = el.closest(".tray-item");
  if (item) return { kind: "tray", id: item.dataset.id, el: item };
  if (el.closest("#zine-tray")) return { kind: "tray", id: null, el: $("zine-tray") };
  return null;
}

function bindZineUI() {
  $("btn-zine-add").addEventListener("click", () => openZinePicker());
  $("zine-input").addEventListener("change", (e) => {
    addZineFiles(e.target.files);
    e.target.value = "";
  });

  const panel = $("panel-zine");

  // Click: remove buttons, click-to-swap, or upload into an empty page
  panel.addEventListener("click", (e) => {
    if (busy) return;
    const act = e.target.closest("[data-act]");
    if (act) {
      const t = zineTarget(act);
      if (act.dataset.act === "unassign" && t) zineMove({ kind: "slot", i: t.i }, { kind: "tray" });
      if (act.dataset.act === "discard" && t) {
        state.zine.tray = state.zine.tray.filter((id) => id !== t.id);
      }
      return zineChanged();
    }
    const t = zineTarget(e.target);
    if (!t) return;
    if (zineSelection) {
      const src = zineSelection;
      zineSelection = null;
      if (zineMove(src, t)) return zineChanged();
      return renderZine();
    }
    if (t.kind === "slot" && !state.zine.pages[t.i]) return openZinePicker(t.i);
    if (t.kind === "tray" && !t.id) return;
    zineSelection = t.kind === "slot" ? { kind: "slot", i: t.i } : { kind: "tray", id: t.id };
    renderZine();
  });

  // Drag & drop between pages and the tray (files dropped on a page load into it)
  let dragSrc = null;
  panel.addEventListener("dragstart", (e) => {
    const t = zineTarget(e.target);
    if (!t || (t.kind === "tray" && !t.id)) return;
    dragSrc = t.kind === "slot" ? { kind: "slot", i: t.i } : { kind: "tray", id: t.id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "zine");
    t.el.classList.add("dragging");
  });
  panel.addEventListener("dragend", () => {
    dragSrc = null;
    panel.querySelectorAll(".dragging, .over").forEach((el) => el.classList.remove("dragging", "over"));
  });
  panel.addEventListener("dragover", (e) => {
    const t = zineTarget(e.target);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    panel.querySelectorAll(".over").forEach((el) => el !== t.el && el.classList.remove("over"));
    t.el.classList.add("over");
  });
  panel.addEventListener("drop", (e) => {
    const t = zineTarget(e.target);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    panel.querySelectorAll(".over").forEach((el) => el.classList.remove("over"));
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      zineTargetSlot = t.kind === "slot" ? t.i : ZINE_PAGES; // tray → all to the tray
      return addZineFiles(e.dataTransfer.files);
    }
    if (dragSrc && zineMove(dragSrc, t)) zineChanged();
    dragSrc = null;
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && zineSelection) {
      zineSelection = null;
      renderZine();
    }
  });
}

// ── PREVIEW GUIDES (never exported) ─────────────

// Fold lines, the cut and each page number, over the printable area
function drawZineGuides() {
  const q = previewQuality;
  const r = printableRect(width, height);
  const pw = r.w / 4;
  const ph = r.h / 2;
  const ctx = drawingContext;

  ctx.save();
  ctx.lineWidth = q;
  ctx.setLineDash([4 * q, 4 * q]);
  ctx.strokeStyle = "rgba(50, 85, 164, 0.55)"; // folds: Medium Blue
  ctx.beginPath();
  for (let k = 1; k < 4; k++) {
    ctx.moveTo(r.x + k * pw, r.y);
    ctx.lineTo(r.x + k * pw, r.y + r.h);
  }
  ctx.moveTo(r.x, r.y + ph);
  ctx.lineTo(r.x + pw, r.y + ph);
  ctx.moveTo(r.x + 3 * pw, r.y + ph);
  ctx.lineTo(r.x + r.w, r.y + ph);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.lineWidth = 1.5 * q;
  ctx.strokeStyle = "#FF48B0"; // cut: Fluorescent Pink
  ctx.beginPath();
  ctx.moveTo(r.x + pw, r.y + ph);
  ctx.lineTo(r.x + 3 * pw, r.y + ph);
  ctx.stroke();

  // page badges, upside down on the top row like the pages themselves
  ctx.font = `700 ${10 * q}px "Space Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ZINE_IMPOSITION.forEach(({ page, col, row, flip }) => {
    const cx = r.x + col * pw + pw / 2;
    const cy = r.y + row * ph + (flip ? 12 * q : ph - 12 * q);
    ctx.save();
    ctx.translate(cx, cy);
    if (flip) ctx.rotate(Math.PI);
    const label = page === 1 ? "1 portada" : page === 8 ? "8 contra" : String(page);
    const tw = ctx.measureText(label).width + 10 * q;
    ctx.fillStyle = "rgba(251, 250, 246, 0.9)";
    ctx.fillRect(-tw / 2, -8 * q, tw, 16 * q);
    ctx.fillStyle = "#3255A4";
    ctx.fillText(label, 0, 0.5 * q);
    ctx.restore();
  });
  ctx.restore();
}
