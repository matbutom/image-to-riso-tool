/*
  zoom.js — preview zoom & pan. Purely visual (CSS transform on the p5 canvas):
  it never touches the pipeline or the exports.
  Wheel / trackpad pinch / two-finger pinch = zoom at cursor · drag = pan ·
  double click = fit · +/-/0 keys.
*/
(function () {
  const MIN = 1;
  const MAX = 16;
  const area = document.getElementById("canvas-area");
  const wrapper = document.getElementById("canvas-wrapper");
  const label = document.getElementById("zoom-level");
  let z = 1;
  const BASE = window.BASE_PREVIEW_QUALITY || 1; // 2 on retina screens (sketch.js)
  let quality = BASE; // preview resolution multiplier currently rendered
  let qualityTimer = null;
  let tx = 0;
  let ty = 0;

  const canvas = () => wrapper.querySelector("canvas");

  function apply() {
    const c = canvas();
    if (!c) return;
    if (z === 1) tx = ty = 0;
    c.style.transformOrigin = "50% 50%";
    c.style.transform = z === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${z})`;
    area.classList.toggle("zoomed", z > 1);
    if (label) label.textContent = `${Math.round(z * 100)}%`;
  }

  // Once zoom settles, re-render the preview with more pixels so the screens
  // are sharp instead of an enlarged low-res bitmap (1x, 2x or 3x ≈ export size)
  function scheduleQuality() {
    clearTimeout(qualityTimer);
    qualityTimer = setTimeout(() => {
      const q = Math.max(BASE, Math.min(3, Math.ceil(z - 0.01)));
      if (q === quality || !window.setPreviewQuality) return;
      quality = q;
      window.setPreviewQuality(q);
      apply();
    }, 350);
  }

  // Keep the canvas from being panned completely out of view
  function clampPan() {
    const c = canvas();
    if (!c) return;
    const r = wrapper.getBoundingClientRect();
    const w = c.offsetWidth;
    const h = c.offsetHeight;
    const mx = Math.max(0, (w * z - r.width) / 2 + 80);
    const my = Math.max(0, (h * z - r.height) / 2 + 80);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  }

  // Zoom keeping the point (cx, cy), in client coordinates, fixed on screen
  function zoomTo(next, cx, cy) {
    next = Math.min(MAX, Math.max(MIN, next));
    const r = wrapper.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2);
    const py = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2);
    const k = next / z;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    z = next;
    clampPan();
    apply();
    scheduleQuality();
  }

  area.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel with small deltas
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomTo(z * f, e.clientX, e.clientY);
    },
    { passive: false },
  );

  // One pointer pans (when zoomed); two touch points pinch-zoom around their centre
  let drag = null;
  let pinch = null;
  const touches = new Map(); // pointerId → { x, y }
  const onControls = (e) => e.target.closest(".zoom-controls, .history-controls, .sheet-nav, .help-btn");

  function pinchState() {
    const [a, b] = [...touches.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  area.addEventListener("pointerdown", (e) => {
    if (onControls(e)) return;
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        drag = null;
        pinch = { ...pinchState(), z0: z };
        area.classList.remove("panning");
        return;
      }
    }
    if (z <= 1 || e.button !== 0 || pinch) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    area.setPointerCapture(e.pointerId);
    area.classList.add("panning");
  });
  area.addEventListener("pointermove", (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const p = pinchState();
      zoomTo(pinch.z0 * (p.d / pinch.d), p.cx, p.cy);
      return;
    }
    if (!drag) return;
    tx = drag.tx + e.clientX - drag.x;
    ty = drag.ty + e.clientY - drag.y;
    clampPan();
    apply();
  });
  const endDrag = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    drag = null;
    area.classList.remove("panning");
  };
  area.addEventListener("pointerup", endDrag);
  area.addEventListener("pointercancel", endDrag);
  area.addEventListener("dblclick", (e) => {
    if (e.target.closest(".zoom-controls, .history-controls, .sheet-nav, .help-btn")) return;
    z === 1 ? zoomTo(4, e.clientX, e.clientY) : zoomTo(1);
  });

  document.getElementById("zoom-in").addEventListener("click", () => zoomTo(z * 1.5));
  document.getElementById("zoom-out").addEventListener("click", () => zoomTo(z / 1.5));
  document.getElementById("zoom-fit").addEventListener("click", () => zoomTo(1));

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "+" || e.key === "=") zoomTo(z * 1.5);
    else if (e.key === "-") zoomTo(z / 1.5);
    else if (e.key === "0") zoomTo(1);
  });

  // The canvas element can be resized (page format change): keep pan in range
  window.addEventListener("resize", () => {
    clampPan();
    apply();
  });
  new MutationObserver(apply).observe(wrapper, { childList: true });
  apply();
})();
