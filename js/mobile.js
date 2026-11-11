/*
  mobile.js — phone layout helpers.

  On phones (≤ 700 px, see css/style.css) the sidebar shows one step at a time,
  picked from a bottom tab bar; the status line is mirrored into the compact
  header so "procesando…" stays visible whatever step is open. On any device
  the preview is redrawn when its area changes size (tab switches, rotation,
  the mobile browser bar showing or hiding).
*/
(function () {
  const phone = window.matchMedia("(max-width: 700px)");
  const tabs = document.getElementById("step-tabs");
  const body = document.querySelector(".sidebar-body");
  const foot = document.querySelector(".sidebar-foot");

  function setStep(n) {
    document.body.dataset.step = String(n);
    tabs.querySelectorAll("[data-step]").forEach((b) => {
      const on = Number(b.dataset.step) === n;
      b.classList.toggle("active", on);
      b.setAttribute("aria-current", on ? "step" : "false");
    });
    if (phone.matches) {
      // a collapsed step would show an empty panel
      const step = document.querySelector(`details.step[data-step="${n}"]`);
      if (step) step.open = true;
      (n === 5 ? foot : body).scrollTop = 0;
    }
  }

  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (b) setStep(Number(b.dataset.step));
  });

  // Status mirror for the phone header
  const status = document.getElementById("meta-status");
  const mini = document.getElementById("status-mini");
  const mirror = () => {
    mini.textContent = status.textContent;
    mini.classList.toggle("working", status.classList.contains("working"));
  };
  new MutationObserver(mirror).observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  mirror();

  // Keep the canvas fitted when its area resizes
  const wrapper = document.getElementById("canvas-wrapper");
  if (window.ResizeObserver) {
    new ResizeObserver(() => typeof redraw === "function" && redraw()).observe(wrapper);
  }

  setStep(1);
})();
