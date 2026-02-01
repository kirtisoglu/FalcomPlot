// 📁 js/main.js

import { animateRecursiveCut, pause, play, stepOnce } from "./animation.js";
import { draw, setGraphData, setupCanvasInteractions } from "./graphRenderer.js";
import { renderInfoBox } from "./infoBox.js";

let recursive_cut = null;

// Load graph
fetch("graph.json")
    .then(res => res.json())
    .then(data => {
        setGraphData(data);
        draw();
        setupCanvasInteractions();
    });

// Load recursive cut
fetch("recursive_cut.json")
    .then(res => res.json())
    .then(data => {
        recursive_cut = data;
        renderInfoBox(data.recursion_info);
    });

// Attach animation trigger globally for now
window.animateRecursiveCut = () => {
    if (recursive_cut) animateRecursiveCut(recursive_cut);
};

// Buttons
window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("resetBtn").onclick = () => window.resetView();
    document.getElementById("rotateLeftBtn").onclick = () => window.rotateView(-Math.PI / 18);
    document.getElementById("rotateRightBtn").onclick = () => window.rotateView(Math.PI / 18);

    document.getElementById("playBtn").onclick = play;
    document.getElementById("pauseBtn").onclick = pause;
    document.getElementById("stepBtn").onclick = stepOnce;
});



