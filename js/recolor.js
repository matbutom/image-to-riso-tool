/*
  recolor.js — eyedropper colour replacement.

  Pick a colour of the source image with the eyedropper and send it to one
  riso ink (or to the paper). Each rule acts on the ink coverage maps right
  after separation, in any mode: pixels close to the picked colour get 100 %
  of the chosen ink and 0 % of the others, so they print as a solid, single
  ink. The edge is soft (a ramp over the outer part of the tolerance) so
  replaced areas don't get jagged borders.

  Rules live in state.colorRules (undoable): { id, rgb, target, tol }
  target = layer uid, or "paper" for no ink.
*/

const RECOLOR_SOFT = 0.35; // outer fraction of the tolerance that fades in
let recolorPicking = false;

// "Redmean" colour distance: cheap and close enough to perception for
// matching flat areas; 0 … ~765
function colorDistance(r1, g1, b1, r2, g2, b2) {
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

// tolerance 0–100 → distance
function toleranceDistance(tol) {
  return (tol / 100) * 300;
}

// Apply the rules to the coverage maps (255 = full ink); px are the source pixels
function applyColorRules(maps, px, n) {
  const rules = state.colorRules
    .map((rule) => ({
      ...rule,
      layer: rule.target === "paper" ? -1 : state.layers.findIndex((L) => L.uid === rule.target),
      max: toleranceDistance(rule.tol),
    }))
    .filter((rule) => rule.target === "paper" || rule.layer >= 0);
  if (!rules.length) return maps;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = px[p];
    const g = px[p + 1];
    const b = px[p + 2];
    for (const rule of rules) {
      const d = colorDistance(r, g, b, rule.rgb[0], rule.rgb[1], rule.rgb[2]);
      if (d >= rule.max) continue;
      const inner = rule.max * (1 - RECOLOR_SOFT);
      const w = d <= inner ? 1 : (rule.max - d) / (rule.max - inner);
      for (let j = 0; j < maps.length; j++) {
        const m = maps[j];
        if (!m) continue;
        const target = j === rule.layer ? 255 : 0;
        m[i] = m[i] + (target - m[i]) * w;
      }
    }
  }
  return maps;
}

// ── PICKING ─────────────────────────────────────

// Source colour under a client point, averaged over 3×3 preview pixels; null outside the image
function sampleSourceAt(clientX, clientY) {
  if (!srcImg || !work) return null;
  const c = drawingContext.canvas;
  const b = c.getBoundingClientRect(); // includes the zoom transform
  const u = ((clientX - b.left) / b.width) * width;
  const v = ((clientY - b.top) / b.height) * height;
  const r = work.rect;
  if (u < r.x || v < r.y || u >= r.x + r.w || v >= r.y + r.h) return null;
  const img = work.img;
  img.loadPixels();
  const ix = Math.floor(((u - r.x) / r.w) * img.width);
  const iy = Math.floor(((v - r.y) / r.h) * img.height);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let k = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = Math.min(img.width - 1, Math.max(0, ix + dx));
      const y = Math.min(img.height - 1, Math.max(0, iy + dy));
      const p = (y * img.width + x) * 4;
      sr += img.pixels[p];
      sg += img.pixels[p + 1];
      sb += img.pixels[p + 2];
      k++;
    }
  }
  return [Math.round(sr / k), Math.round(sg / k), Math.round(sb / k)];
}

const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

function setPicking(on) {
  recolorPicking = on && !!srcImg;
  $("btn-eyedropper").classList.toggle("on", recolorPicking);
  $("canvas-area").classList.toggle("picking", recolorPicking);
  $("loupe").hidden = true;
  if (recolorPicking) setStatus("haz clic en un color de la imagen · esc cancela");
  else if (on && !srcImg) setStatus("primero carga una imagen");
}

// Default target: the layer whose ink is closest to the picked colour, or the
// paper for near-white picks
function nearestTarget(rgb) {
  if (colorDistance(...rgb, 255, 255, 255) < 60) return "paper";
  let best = "paper";
  let bestD = Infinity;
  state.layers.forEach((L) => {
    const d = colorDistance(...rgb, ...inkBySlug(L.ink).rgb);
    if (d < bestD) {
      bestD = d;
      best = L.uid;
    }
  });
  return best;
}

function addColorRule(rgb) {
  const id = Math.max(0, ...state.colorRules.map((r) => r.id)) + 1;
  state.colorRules.push({ id, rgb, target: nearestTarget(rgb), tol: 20 });
  renderColorRules();
  schedule(STAGE.REBUILD);
}

// ── SIDEBAR ─────────────────────────────────────

function renderColorRules() {
  const list = $("color-rules");
  if (!state.colorRules.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = state.colorRules
    .map((rule) => {
      const missing = rule.target !== "paper" && !state.layers.some((L) => L.uid === rule.target);
      const options =
        state.layers
          .map((L, i) => {
            const ink = inkBySlug(L.ink);
            return `<option value="${L.uid}"${L.uid === rule.target ? " selected" : ""}>${i + 1} · ${ink.name}</option>`;
          })
          .join("") +
        `<option value="paper"${rule.target === "paper" ? " selected" : ""}>Papel (sin tinta)</option>` +
        (missing ? `<option value="" selected>capa eliminada</option>` : "");
      const targetHex =
        rule.target === "paper" || missing
          ? "#FBFAF6"
          : inkBySlug(state.layers.find((L) => L.uid === rule.target).ink).hex;
      return `
        <div class="color-rule" data-rule="${rule.id}">
          <div class="rule-head">
            <span class="swatch swatch-square" style="background:${hex(rule.rgb)}" title="color elegido ${hex(rule.rgb)}"></span>
            <span class="ms rule-arrow" aria-hidden="true">arrow_forward</span>
            <span class="swatch" style="background:${targetHex}"></span>
            <select class="ink-select" data-act="rule-target" aria-label="tinta para ${hex(rule.rgb)}">${options}</select>
            <button class="icon-btn" type="button" data-act="rule-remove" title="quitar regla"><span class="ms" aria-hidden="true">close</span></button>
          </div>
          <div class="slider-row">
            <div class="slider-head">
              <span class="row-label">Tolerancia</span>
              <span class="slider-value">${rule.tol}</span>
            </div>
            <input type="range" min="1" max="100" step="1" value="${rule.tol}" data-act="rule-tol" aria-label="tolerancia" />
          </div>
        </div>`;
    })
    .join("");
}

function ruleFromEvent(e) {
  const el = e.target.closest("[data-rule]");
  return el ? state.colorRules.find((r) => String(r.id) === el.dataset.rule) : null;
}

function bindRecolorUI() {
  $("btn-eyedropper").addEventListener("click", () => setPicking(!recolorPicking));

  const list = $("color-rules");
  list.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-act="rule-remove"]');
    const rule = btn && ruleFromEvent(e);
    if (!rule) return;
    state.colorRules = state.colorRules.filter((r) => r !== rule);
    renderColorRules();
    schedule(STAGE.REBUILD);
  });
  list.addEventListener("change", (e) => {
    if (e.target.dataset.act !== "rule-target") return;
    const rule = ruleFromEvent(e);
    if (!rule || !e.target.value) return;
    rule.target = e.target.value === "paper" ? "paper" : parseInt(e.target.value, 10);
    renderColorRules();
    schedule(STAGE.REBUILD);
  });
  list.addEventListener("input", (e) => {
    if (e.target.dataset.act !== "rule-tol") return;
    const rule = ruleFromEvent(e);
    if (!rule) return;
    rule.tol = parseInt(e.target.value, 10);
    e.target.closest(".slider-row").querySelector(".slider-value").textContent = rule.tol;
    schedule(STAGE.REBUILD, DEBOUNCE_MS);
  });

  // Picking on the canvas: a loupe follows the cursor, a click adds the rule
  const area = $("canvas-area");
  const loupe = $("loupe");
  area.addEventListener("mousemove", (e) => {
    if (!recolorPicking) return;
    const rgb = sampleSourceAt(e.clientX, e.clientY);
    loupe.hidden = !rgb;
    if (!rgb) return;
    const box = area.getBoundingClientRect();
    loupe.style.left = e.clientX - box.left + 16 + "px";
    loupe.style.top = e.clientY - box.top + 16 + "px";
    loupe.querySelector(".loupe-swatch").style.background = hex(rgb);
    loupe.querySelector(".loupe-hex").textContent = hex(rgb);
  });
  area.addEventListener("mouseleave", () => (loupe.hidden = true));
  area.addEventListener(
    "click",
    (e) => {
      if (!recolorPicking) return;
      if (e.target.closest(".zoom-controls, .history-controls, .sheet-nav, .help-btn")) return;
      e.stopImmediatePropagation(); // not a "load a file" click
      const rgb = sampleSourceAt(e.clientX, e.clientY);
      if (!rgb) return setStatus("haz clic dentro de la imagen · esc cancela");
      setPicking(false);
      addColorRule(rgb);
    },
    true, // capture: runs before the canvas' own click handler
  );
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && recolorPicking) {
      setPicking(false);
      setStatus("listo");
    }
  });
}
