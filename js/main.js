// Import all modules
import { CONFIG, VISUAL } from './js/config.js';
import { Logger } from './js/logger.js';
import { DataLoader } from './js/dataLoader.js?v=4'; // Final button changes
import { Renderer } from './js/renderer.js';
import { ToleranceChecker } from './js/toleranceChecker.js';
import { ViewManager } from './js/viewManager.js';
import { InputHandler } from './js/inputHandler.js?v=2'; // Rotation support
import { AnimationController } from './js/animationController.js?v=4'; // Final button changes


// ============================================================
// STATE - Shared across all modules
// ============================================================
const state = {
    iteration: 0,
    isPlaying: false,
    isPaused: false,
    animationSpeed: 1.0,

    blocksPaths: [],
    blocksBounds: null,
    centroidMaps: {
        byGeoID20: new Map(),
        byGeoID: new Map(),
        byFeatId: new Map(),
    },
    blockIdToFeature: new Map(),  // blockId -> feature for district coloring

    nodes: [],
    links: [],
    nodesById: {},
    rootId: null,
    metadata: null,

    districts: new Map(),
    nodeColorOverrides: new Map(),
    districtBlockColors: new Map(),  // blockId -> color (fixed across iterations)
    blockIdToGeometry: new Map(),    // blockId -> geometry for rendering
    blockIdToBounds: new Map(),      // blockId -> [minx, miny, maxx, maxy] - NEEDED FOR HIT DETECTION
    blockIdToDistrictId: new Map(),  // blockId -> districtId (iteration number)
    districtMetadata: new Map(),     // districtId -> metadata object

    // District boundaries
    districtBoundaries: new Map(),      // districtId -> Path2D boundary
    districtBoundaryColors: new Map(),  // districtId -> color

    // Visualization mode toggles
    stateMode: 'initial',        // 'initial' or 'intermediate'
    viewMode: 'district',        // 'tree' or 'district'
    districtColoring: 'colored', // 'colored' or 'uncolored'

    // Data paths
    treePath: 'data/trees',      // Current tree data path
    districtPath: 'data/districts', // Current district data path

    transform: { x: 0, y: 0, k: 1, angle: 0 },
    initialTransform: null,
    center: { x: 0, y: 0 },
    flipX: false,

    highlightNodeId: null,
    highlightBlockId: null,          // blockId being hovered (for tree node hovers)
    highlightDistrictId: null,       // districtId being hovered (for district hovers)
    highlightUntil: 0,
};

// ============================================================
// DOM ELEMENTS
// ============================================================
const canvas = document.getElementById("graphCanvas");
const statusPanel = document.getElementById("statusPanel");
const tooltip = document.getElementById("tooltip");

// ============================================================
// INSTANTIATE ALL MODULES
// ============================================================
const logger = new Logger(statusPanel, CONFIG);
const dataLoader = new DataLoader(logger);
const renderer = new Renderer(canvas, CONFIG, VISUAL);
const toleranceChecker = new ToleranceChecker();
const viewManager = new ViewManager(canvas, CONFIG);
const inputHandler = new InputHandler(canvas, viewManager);
const animationController = new AnimationController(dataLoader, logger, CONFIG);

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Update Mode Indicator Display
function updateModeIndicator() {
    const stateModeText = state.stateMode === 'initial' ? 'INITIAL' : 'INTERMEDIATE';
    const viewModeText = state.viewMode === 'district' ? 'DISTRICT' : 'TREE';
    const coloringText = state.districtColoring === 'colored' ? 'Colored' : 'Uncolored';

    document.getElementById('currentStateMode').textContent = stateModeText;
    document.getElementById('currentViewMode').textContent = viewModeText;
    document.getElementById('currentColoringMode').textContent = coloringText;
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    console.log(`Canvas resized to: ${canvas.width}x${canvas.height}`);
    redraw();
}

window.addEventListener("resize", resize);

// CRITICAL: Call resize immediately to set canvas size
resize();

function updateTreeMetadata() {
    const treeMetadataPanel = document.getElementById("treeMetadata");
    if (!treeMetadataPanel) return;

    if (!state.metadata) {
        treeMetadataPanel.innerHTML = "<div style='color:#999;font-style:italic; font-size: 12px;'>No tree loaded</div>";
        return;
    }

    const fmtInt = new Intl.NumberFormat('en-US');
    const kv = (k, v) => `<div style="margin:4px 0;font-size:11px;"><b style="color:#666;">${k}:</b> ${String(v)}</div>`;
    treeMetadataPanel.innerHTML =
        kv("ideal_pop", fmtInt.format(state.metadata.ideal_pop || 0)) +
        kv("root", state.metadata.root) +
        kv("n_teams", state.metadata.n_teams) +
        kv("epsilon", state.metadata.epsilon) +
        kv("two_sided", state.metadata.two_sided) +
        kv("tot_candidates", state.metadata.tot_candidates) +
        kv("tot_pop", fmtInt.format(state.metadata.tot_pop || 0));
}

function updateDistrictMetadata() {
    // Placeholder for district metadata update logic
    // This function would typically populate the #districtMetadata div
    const districtMetadataPanel = document.getElementById("districtMetadata");
    if (!districtMetadataPanel) return;

    if (!state.districts || state.districts.size === 0) {
        districtMetadataPanel.innerHTML = "<div style='color:#999;font-style:italic; font-size: 12px;'>No districts loaded</div>";
        return;
    }

    let html = '<div style="font-size: 12px; line-height: 1.6;">';
    // Example: Displaying some info about the first district
    const firstDistrictId = state.districts.keys().next().value;
    if (firstDistrictId !== undefined) {
        const district = state.districts.get(firstDistrictId);
        html += `<div><b>First District ID:</b> ${firstDistrictId}</div>`;
        if (district && district.population) {
            html += `<div><b>Population:</b> ${new Intl.NumberFormat('en-US').format(district.population)}</div>`;
        }
        // Add more district-specific metadata as needed
    }
    html += '</div>';
    districtMetadataPanel.innerHTML = html;
}

function redraw() {
    updateTreeMetadata();
    updateDistrictMetadata();

    // Draw using the renderer
    renderer.draw(state, n => toleranceChecker.isWithinTolerance(n, state.metadata));
}

// ============================================================
// EVENT LISTENERS - UI CONTROLS
// ============================================================
document.getElementById("playBtn").addEventListener("click", () => {
    animationController.play(state, redraw, viewManager, updateTreeMetadata);
});

document.getElementById("pauseBtn").addEventListener("click", () => {
    animationController.pause(state);
});

document.getElementById("stopBtn").addEventListener("click", () => {
    animationController.stop(state, redraw);
});

document.getElementById("finalBtn").addEventListener("click", () => {
    if (state.maxIteration) {
        logger.log(`Jumping to final iteration ${state.maxIteration}...`, "info");
        animationController.jumpToIteration(state.maxIteration, state, redraw, viewManager, state.centroidMaps, updateTreeMetadata);
    }
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
    logger.log(`Speed: ${state.animationSpeed}x`);
});

document.getElementById("goBtn").addEventListener("click", async () => {
    const targetIter = parseInt(document.getElementById("iterationInput").value, 10);
    if (isNaN(targetIter) || targetIter < 0) {
        logger.warn("Invalid iteration number");
        return;
    }
    await animationController.jumpToIteration(targetIter, state, redraw, viewManager, state.centroidMaps, updateTreeMetadata);
});

document.getElementById("debugMode").addEventListener("change", e => {
    CONFIG.debug = e.target.checked;
    logger.log(`Debug mode: ${CONFIG.debug ? "ON" : "OFF"}`);
});

document.getElementById("toggleStateBtn").addEventListener("click", e => {
    if (state.stateMode === 'initial') {
        state.stateMode = 'intermediate';
        e.target.textContent = "Switch to Initial";
        state.treePath = 'data/int_trees';
        state.districtPath = 'data/int_districts';
        logger.log("Switched to Intermediate Mode");

        // Show coloring button only if in district mode
        if (state.viewMode === 'district') {
            document.getElementById("toggleColoringBtn").style.display = "inline-block";
        }
    } else {
        state.stateMode = 'initial';
        e.target.textContent = "Switch to Intermediate";
        state.treePath = 'data/trees';
        state.districtPath = 'data/districts';
        state.districtColoring = 'colored'; // Force colored in initial mode
        logger.log("Switched to Initial Mode");

        // Hide coloring button in initial mode
        document.getElementById("toggleColoringBtn").style.display = "none";
        document.getElementById("toggleColoringBtn").textContent = "Show Uncolored";
    }
    updateModeIndicator();  // Update mode display
    // Assuming loadIterationData is a new function to be called
    // If it's not defined, this will cause an error.
    // For now, I'll add it as requested, but it might need to be defined elsewhere.
    // loadIterationData(state.iteration); // This line was in the provided snippet but not in the original context.
    redraw();
});

document.getElementById("toggleModeBtn").addEventListener("click", e => {
    if (state.viewMode === 'district') {
        state.viewMode = 'tree';
        e.target.textContent = "Switch to District Mode";
        document.getElementById("toggleColoringBtn").style.display = "none";
        logger.log("Switched to Tree Mode");
    } else {
        state.viewMode = 'district';
        e.target.textContent = "Switch to Tree Mode";

        // Show coloring button only in intermediate mode
        if (state.stateMode === 'intermediate') {
            document.getElementById("toggleColoringBtn").style.display = "inline-block";
        }
        logger.log("Switched to District Mode");
    }
    updateModeIndicator();  // Update mode display
    redraw();
});

const toggleColoringBtn = document.getElementById("toggleColoringBtn");
if (toggleColoringBtn) { // Null check for the button
    toggleColoringBtn.addEventListener("click", e => {
        if (state.districtColoring === 'colored') {
            state.districtColoring = 'uncolored';
            e.target.textContent = "Show Colored";
            logger.log("Districts: Uncolored view");
        } else {
            state.districtColoring = 'colored';
            e.target.textContent = "Show Uncolored";
            logger.log("Districts: Colored view");
        }
        updateModeIndicator();  // Update mode display
        redraw();
    });
} // End of null check

// ============================================================
// MOUSE & INPUT LISTENERS
// ============================================================
inputHandler.attachMouseListeners(canvas, state, viewManager, redraw, state.nodes, toleranceChecker, state.metadata, tooltip);

addEventListener('resize', resize);

// ============================================================
// INITIALIZATION
// ============================================================
async function init() {
    try {
        logger.updateStatus("Initializing...", "info");
        logger.log("Starting initialization...");

        // CHANGE START
        logger.log("Loading blocks.json...");
        const { blocksBounds, detectedSwap } = await dataLoader.loadBlocks(state.blocksPaths, state.centroidMaps, state.blockIdToFeature, state.blockIdToGeometry, state.blockIdToBounds);
        logger.log(`Blocks loaded. blocksPaths length: ${state.blocksPaths.length}`);
        logger.log(`VERIFY: blocksPaths[0] type = ${state.blocksPaths[0]?.constructor?.name}`);
        logger.log(`VERIFY: blocksPaths is array? ${Array.isArray(state.blocksPaths)}`);

        state.blocksBounds = blocksBounds; // <--- Store bounds in state
        state.detectedSwap = detectedSwap; // <--- Store detectedSwap in state
        logger.log(`Blocks bounds set: ${JSON.stringify(blocksBounds)}`);
        // CHANGE END

        // CRITICAL: Resize canvas BEFORE setting view transform
        logger.log("Resizing canvas...");
        resize(); // This will also call redraw()

        // Set initial view transformation based on loaded blocks bounds
        logger.log("Setting initial view...");
        viewManager.autoCenterAndScale(state); // <--- Call ViewManager to calculate initial transform

        resize(); // resize calls redraw()
        redraw(); // The first draw should now use the correct transform
        logger.log("Initial render complete");

        // Detect max iterations
        let maxIter = 1; // Initialize a variable to track the max iteration

        for (let i = 1; i < 10000; i++) { // Increased limit for safety
            const response = await fetch(`data/trees/tree_${i}.json`, { method: "HEAD" });

            if (response.ok) {
                // File exists, update the max iteration
                maxIter = i;
            } else if (response.status === 404) {
                // File not found (404 is the expected break condition)
                break;
            } else {
                // Handle other errors (e.g., server error)
                logger.warn(`Error checking file tree_${i}.json: Status ${response.status}`);
                break;
            }
        }

        // Store the determined max iteration in the state
        state.maxIteration = maxIter;
        logger.log(`Ready! Max iterations: ${state.maxIteration}`, "success");

    } catch (err) {
        logger.error(`Init failed: ${err.message}`);
        logger.error(`Stack: ${err.stack}`);
        console.error("Initialization error:", err);
    }
}

init();
