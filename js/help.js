/*
  help.js — the "?" button: a short how-to in a modal dialog.
  Opens with the button or the "?" key; closes with ×, Esc or a click outside.
*/
(function () {
  const dialog = document.getElementById("help-dialog");
  const button = document.getElementById("btn-help");
  if (!dialog || !button) return;

  const open = () => {
    if (!dialog.open) dialog.showModal();
  };

  button.addEventListener("click", (e) => {
    e.stopPropagation(); // not a click on the empty canvas
    open();
  });
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") || e.target === dialog) dialog.close(); // × or the backdrop
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    open();
  });
})();
