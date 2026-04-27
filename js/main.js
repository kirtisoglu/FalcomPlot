// Import all modules
import { CONFIG, VISUAL } from './js/config.js';
import { Logger } from './js/logger.js';
import { DataLoader } from './js/dataLoader.js';
import { Renderer } from './js/renderer.js';
import { ToleranceChecker } from './js/toleranceChecker.js';
import { ViewManager } from './js/viewManager.js';
import { InputHandler } from './js/inputHandler.js';
import { AnimationController } from './js/animationController.js';


// ============================================================
// STATE
// ============================================================
const state = {
    iteration: 0,
    maxIteration: 0,  // set by manifest or probe during init
    isPlaying: false,
    isPaused: false,
    animationSpeed: 1.0,

    blocksPaths: [],
    blocksBounds: null,
    detectedSwap: false,
    centroidMaps: {
        byGeoID20: new Map(),
        byGeoID: new Map(),
        byFeatId: new Map(),
    },
    blockIdToFeature: new Map(),
    blockIdToGeometry: new Map(),
    blockIdToBounds: new Map(),

    nodes: [],
    links: [],
    nodesById: {},
    rootId: null,
    cutNodeId: null,
    cutSideNodes: new Set(),
    metadata: null,

    // Chain step data
    stepData: null,
    manifest: null,

    // Frame animation (flattened from nested phases)
    frames: null,
    frameIndex: -1,
    currentFrame: null,
    phaseLabel: "",
    detailLevel: "detailed",  // "overview" or "detailed"

    // Phase-specific rendering data (set by _applyFrame)
    mergedSuperdistricts: new Set(),
    mergedBaseNodes: new Set(),
    supergraphEdges: [],
    supergraphNodes: {},
    extractedNodes: new Set(),
    proposedCenters: {},
    energyProposed: 0,
    energyCurrent: 0,
    stepAccepted: false,

    districts: new Map(),
    nodeColorOverrides: new Map(),
    districtBlockColors: new Map(),
    blockIdToDistrictId: new Map(),
    districtMetadata: new Map(),

    districtBoundaries: new Map(),
    districtBoundaryColors: new Map(),

    viewMode: 'district',            // 'tree' or 'district'
    districtColoring: 'colored',     // 'colored' or 'uncolored'

    transform: { x: 0, y: 0, k: 1, angle: 0 },
    initialTransform: null,
    center: { x: 0, y: 0 },
    flipX: false,

    highlightNodeId: null,
    highlightBlockId: null,
    highlightDistrictId: null,
    highlightUntil: 0,
};

// ============================================================
// DOM ELEMENTS
// ============================================================
const canvas = document.getElementById("graphCanvas");
const statusPanel = document.getElementById("statusPanel");
const tooltip = document.getElementById("tooltip");

// ============================================================
// INSTANTIATE MODULES
// ============================================================
const logger = new Logger(statusPanel, CONFIG);
const dataLoader = new DataLoader(logger);
const renderer = new Renderer(canvas, CONFIG, VISUAL);
const toleranceChecker = new ToleranceChecker();
const viewManager = new ViewManager(canvas, CONFIG);
const inputHandler = new InputHandler(canvas, viewManager);
const animationController = new AnimationController(dataLoader, logger, CONFIG);

// ============================================================
// HELPERS
// ============================================================
function updateModeIndicator() {
    const el1 = document.getElementById('currentViewMode');
    const el2 = document.getElementById('currentColoringMode');
    if (el1) el1.textContent = state.detailLevel.toUpperCase();
    if (el2) {
        // Don't echo the phase label here — it's already shown in the canvas overlay
        // and in the metadata panel. Just show empty.
        el2.textContent = "";
    }
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    redraw();
}

window.addEventListener("resize", resize);
resize();

function updateStepMetadata() {
    const panel = document.getElementById("treeMetadata");
    if (!panel) return;

    const kv = (k, v) => `<div style="margin:3px 0;font-size:11px;word-break:break-word;"><b style="color:#90caf9;">${k}:</b> <span style="color:#fff;">${String(v)}</span></div>`;

    let html = "";

    // Phase label
    if (state.phaseLabel) {
        html += `<div style="font-size:13px;font-weight:bold;color:#1976d2;margin-bottom:6px;">${state.phaseLabel}</div>`;
    }

    // Step data
    const sd = state.stepData;
    if (sd) {
        const numDistricts = sd.districts ? Object.keys(sd.districts).length : '?';
        html += kv("state", sd.step);
        html += kv("energy", sd.energy?.toFixed(1) ?? '?');
        html += kv("districts", numDistricts);
    }

    // Frame-specific info
    const cf = state.currentFrame;
    if (cf) {
        if (cf.type === "select") {
            html += '<hr style="border:none;border-top:1px solid #ddd;margin:6px 0;">';
            html += kv("supergraph nodes", Object.keys(cf.data.supergraph_nodes || {}).length);
            html += kv("merged superdistricts", (cf.data.selected_superdistricts || []).join(", "));
            html += kv("merged base nodes", (cf.data.merged_base_nodes || []).length);
        } else if (cf.type === "facility") {
            html += '<hr style="border:none;border-top:1px solid #ddd;margin:6px 0;">';
            html += kv("centers", Object.keys(cf.data.centers || {}).length);
        } else if (cf.type === "accept_reject") {
            html += '<hr style="border:none;border-top:1px solid #ddd;margin:6px 0;">';
            html += kv("E(proposed)", cf.data.energy_proposed?.toFixed(1));
            html += kv("E(current)", cf.data.energy_current?.toFixed(1));
            const delta = (cf.data.energy_proposed - cf.data.energy_current).toFixed(1);
            html += kv("\u0394E", delta);
            const acceptColor = cf.data.accepted ? "#2e7d32" : "#c62828";
            html += `<div style="margin:6px 0;font-size:13px;font-weight:bold;color:${acceptColor};">${cf.data.accepted ? "ACCEPTED" : "REJECTED"}</div>`;
        } else if (cf.type === "tree_cut") {
            html += `<div style="font-size:10px;color:#888;margin-top:4px;">${cf.sectionLabel}</div>`;
        }
    }

    // Tree cut info (shown during phase 2+3)
    if (state.metadata?.n_cuts != null) {
        html += '<hr style="border:none;border-top:1px solid #ddd;margin:6px 0;">';
        html += kv("admissible cuts", state.metadata.n_cuts);
        html += kv("\u03C8 chosen/total", `${state.metadata.psi_chosen?.toFixed(2)} / ${state.metadata.psi_total?.toFixed(2)}`);
        if (state.metadata.cut_side_size != null) {
            html += kv("cut side", `${state.metadata.cut_side_size} nodes`);
        }
    }

    // Params
    if (state.manifest?.parameters) {
        const p = state.manifest.parameters;
        html += '<hr style="border:none;border-top:1px solid #ddd;margin:6px 0;">';
        html += kv("\u03B5", p.epsilon);
        html += kv("d\u0304", p.demand_target);
        html += kv("c_max", p.capacity_level);
    }

    panel.innerHTML = html || "<div style='color:#999;font-style:italic;font-size:12px;'>No data</div>";
    updateModeIndicator();
}

function redraw() {
    updateStepMetadata();
    renderer.draw(state, n => toleranceChecker.isWithinTolerance(n, state.metadata));
}

// ============================================================
// EVENT LISTENERS
// ============================================================
document.getElementById("playBtn").addEventListener("click", () => {
    animationController.play(state, redraw, viewManager, updateStepMetadata);
});

document.getElementById("pauseBtn").addEventListener("click", () => {
    animationController.pause(state);
});

document.getElementById("stopBtn").addEventListener("click", () => {
    animationController.stop(state, redraw);
});

document.getElementById("finalBtn").addEventListener("click", () => {
    if (state.maxIteration) {
        logger.log(`Jumping to final state ${state.maxIteration}...`, "info");
        animationController.jumpToIteration(state.maxIteration, state, redraw, viewManager, state.centroidMaps, updateStepMetadata);
    }
});

document.getElementById("nextBtn").addEventListener("click", async () => {
    if (state.detailLevel === "overview") {
        // In overview, next = next step
        const next = state.iteration + 1;
        if (state.maxIteration && next > state.maxIteration) return;
        await animationController.jumpToIteration(next, state, redraw, viewManager, state.centroidMaps, updateStepMetadata);
        return;
    }
    // Try advancing within current step's frames
    if (animationController.advanceOneFrame(state)) {
        redraw();
        updateStepMetadata();
        return;
    }
    // All frames exhausted — go to next step, show first frame
    const next = state.iteration + 1;
    if (state.maxIteration && next > state.maxIteration) return;
    await animationController.jumpToIteration(next, state, redraw, viewManager, state.centroidMaps, updateStepMetadata);
});

document.getElementById("prevBtn").addEventListener("click", async () => {
    if (state.detailLevel === "overview") {
        // In overview, prev = previous step
        const prev = state.iteration - 1;
        if (prev < 1) return;
        await animationController.jumpToIteration(prev, state, redraw, viewManager, state.centroidMaps, updateStepMetadata);
        return;
    }
    // Try retreating within current step's frames
    if (animationController.retreatOneFrame(state)) {
        redraw();
        updateStepMetadata();
        return;
    }
    // At first frame — go to previous step, show first frame
    const prev = state.iteration - 1;
    if (prev < 1) return;
    await animationController.jumpToIteration(prev, state, redraw, viewManager, state.centroidMaps, updateStepMetadata);
});

const resetViewBtn = document.getElementById("resetViewBtn");
if (resetViewBtn) {
    resetViewBtn.addEventListener("click", () => {
        viewManager.resetView(state);
        redraw();
    });
}

document.getElementById("speedSlider").addEventListener("input", e => {
    state.animationSpeed = parseFloat(e.target.value);
    document.getElementById("speedLabel").textContent = `${state.animationSpeed}x`;
});

document.getElementById("goBtn").addEventListener("click", async () => {
    const targetIter = parseInt(document.getElementById("iterationInput").value, 10);
    if (isNaN(targetIter) || targetIter < 0) {
        logger.warn("Invalid step number");
        return;
    }
    await animationController.jumpToIteration(targetIter, state, redraw, viewManager, state.centroidMaps, updateStepMetadata);
});

const debugEl = document.getElementById("debugMode");
if (debugEl) {
    debugEl.addEventListener("change", e => {
        CONFIG.debug = e.target.checked;
    });
}

// Detail level toggle
const toggleDetailBtn = document.getElementById("toggleDetailBtn");
if (toggleDetailBtn) {
    toggleDetailBtn.addEventListener("click", (e) => {
        if (state.detailLevel === "detailed") {
            state.detailLevel = "overview";
            e.target.textContent = "Detailed Mode";
        } else {
            state.detailLevel = "detailed";
            e.target.textContent = "Overview Mode";
        }
        logger.log(`Detail level: ${state.detailLevel}`);
        updateModeIndicator();
        // Re-apply current step in the new mode
        if (state.iteration > 0) {
            animationController.jumpToIteration(
                state.iteration, state, redraw, viewManager,
                state.centroidMaps, updateStepMetadata
            );
        } else {
            redraw();
        }
    });
}

// ============================================================
// MOUSE LISTENERS
// ============================================================
inputHandler.attachMouseListeners(canvas, state, viewManager, redraw, state.nodes, toleranceChecker, state.metadata, tooltip);

addEventListener('resize', resize);

// ============================================================
// INITIALIZATION
// ============================================================
async function init() {
    try {
        logger.updateStatus("Initializing...", "info");

        // 1. Load blocks
        const { blocksBounds, detectedSwap } = await dataLoader.loadBlocks(
            state.blocksPaths, state.centroidMaps, state.blockIdToFeature,
            state.blockIdToGeometry, state.blockIdToBounds
        );
        state.blocksBounds = blocksBounds;
        state.detectedSwap = detectedSwap;
        logger.log(`Blocks: ${state.blocksPaths.length} polygons`);

        resize();
        viewManager.autoCenterAndScale(state);
        redraw();

        // 2. Load manifest (new format)
        const manifest = await dataLoader.loadManifest();
        if (manifest && manifest.total_steps) {
            state.manifest = manifest;
            state.maxIteration = manifest.total_steps;
            logger.log(`Chain: ${manifest.total_steps} steps, ${manifest.graph_nodes} nodes`, "success");
        } else {
            // Fallback: probe for old-format tree files
            logger.log("No manifest — probing for tree files...", "info");
            let maxIter = 0;
            for (let i = 1; i < 10000; i++) {
                const response = await fetch(`data/trees/tree_${i}.json`, { method: "HEAD" });
                if (response.ok) {
                    maxIter = i;
                } else {
                    break;
                }
            }
            state.maxIteration = maxIter;
        }

        logger.log(`Ready! Max steps: ${state.maxIteration}`, "success");

    } catch (err) {
        logger.error(`Init failed: ${err.message}`);
        console.error("Initialization error:", err);
    }
}

init();
