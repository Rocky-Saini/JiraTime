"use strict";
/* "How to use" page: table of contents and "Open …" buttons. */
(function helpInit() {
  const view = $("#view-help"); if (!view) return;
  view.addEventListener("click", (e) => {
    const sec = e.target.closest("[data-sec]");
    if (sec) { document.getElementById(sec.dataset.sec)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const go = e.target.closest("[data-go]");
    if (go) document.querySelector(`.nav[data-view="${go.dataset.go}"]`)?.click();
  });
})();
