// Standalone host for the FalcomPlot viewer.
//
// All logic lives in js/mountFalcomPlot.js — the same per-instance
// mount API the SvelteKit dashboard embeds. This file only gathers
// the DOM refs from index.html and points the mount at the /data
// route that falcomplot's Python server (falcomplot.start_server /
// falcomplot.animate) serves.

import { mountFalcomPlot } from "./js/mountFalcomPlot.js";

mountFalcomPlot({
    canvas: document.getElementById("graphCanvas"),
    controlsEl: document.getElementById("controls"),
    sidebarEl: document.getElementById("sidebar"),
    statusEl: document.getElementById("statusPanel"),
    treeMetaEl: document.getElementById("treeMetadata"),
    tooltipEl: document.getElementById("tooltip"),
    sparklineEl: document.getElementById("sparkline"),
    dataPath: "data",
}).catch((err) => {
    console.error("FalcomPlot failed to start:", err);
    const el = document.getElementById("statusPanel");
    if (el) el.textContent = `Failed to start: ${err.message}`;
});
