// 📁 js/animation.js
import { drawStep } from "./graphRenderer.js";
import { renderInfoBox } from "./infoBox.js";

let currentStepIndex = 0;
let animationRunning = false;
let steps = [];
let recursiveCutInfo = null;

export function animateRecursiveCut(data) {
    if (!data || !data.recursion || data.recursion.length === 0) return;

    currentStepIndex = 0;
    steps = data.recursion;
    recursiveCutInfo = data.recursion_info;

    renderInfoBox(recursiveCutInfo, currentStepIndex, steps.length);
    const slider = document.getElementById("stepSlider");
    slider.max = steps.length - 1;
    slider.value = 0;

    slider.oninput = () => {
        currentStepIndex = parseInt(slider.value);
        drawStep(steps[currentStepIndex]);
        renderInfoBox(recursiveCutInfo, currentStepIndex, steps.length);
    };

    play();
}

export function play() {
    if (animationRunning || currentStepIndex >= steps.length) return;
    animationRunning = true;
    loop();
}

export function pause() {
    animationRunning = false;
}

export function stepOnce() {
    if (currentStepIndex < steps.length) {
        drawStep(steps[currentStepIndex]);
        renderInfoBox(recursiveCutInfo, currentStepIndex, steps.length);
        document.getElementById("stepSlider").value = currentStepIndex;
        currentStepIndex++;
    }
}

function loop() {
    if (!animationRunning || currentStepIndex >= steps.length) return;
    drawStep(steps[currentStepIndex]);
    renderInfoBox(recursiveCutInfo, currentStepIndex, steps.length);
    document.getElementById("stepSlider").value = currentStepIndex;
    currentStepIndex++;
    setTimeout(loop, 1000); // speed of animation
}
