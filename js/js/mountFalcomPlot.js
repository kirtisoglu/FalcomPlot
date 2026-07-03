// FalcomPlot mount API for SvelteKit / generic embedding.
//
// Replaces the old main.js global-DOM bootstrap with a per-instance
// mount(...) function. Each call:
//   - takes explicit DOM refs (canvas, controls panel, sidebar panel)
//   - takes a dataPath (URL prefix where blocks.json, manifest.json,
//     step_NNNN.json, ensemble.json live)
//   - encapsulates state per mount, so two FalcomPlots can coexist
//   - returns a cleanup() to detach listeners + cancel animation
//
// Usage from Svelte:
//   import { mountFalcomPlot } from '$lib/falcomplot/mountFalcomPlot.js';
//   const stop = await mountFalcomPlot({
//     canvas, controlsEl, sidebarEl, statusEl, treeMetaEl, tooltipEl,
//     dataPath: '/falcomplot/grids/grid-10x10',
//   });
//   onDestroy(stop);

import { CONFIG, VISUAL } from './config.js';
import { Logger } from './logger.js';
import { DataLoader } from './dataLoader.js';
import { Renderer } from './renderer.js';
import { ToleranceChecker } from './toleranceChecker.js';
import { ViewManager } from './viewManager.js';
import { InputHandler } from './inputHandler.js';
import { AnimationController } from './animationController.js';

// Default config gets shallow-cloned per mount so two visualisers don't
// fight over CONFIG.debug. Treat the imported CONFIG as a template.
function cloneConfig(overrides = {}) {
    return { ...CONFIG, ...overrides, colors: { ...CONFIG.colors } };
}

function makeInitialState() {
    return {
        iteration: 0,
        maxIteration: 0,
        isPlaying: false,
        isPaused: false,
        animationSpeed: 2.0,

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

        stepData: null,
        manifest: null,

        frames: null,
        frameIndex: -1,
        currentFrame: null,
        phaseLabel: '',
        detailLevel: 'detailed',

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

        viewMode: 'district',
        districtColoring: 'colored',

        transform: { x: 0, y: 0, k: 1, angle: 0 },
        initialTransform: null,
        center: { x: 0, y: 0 },
        flipX: false,

        highlightNodeId: null,
        highlightBlockId: null,
        highlightDistrictId: null,
        highlightUntil: 0,

        // Ensemble overlay (boundary heatmap, facility-frequency, etc.)
        // The chain trajectory always renders; ensemble overlays are
        // toggled via state.ensembleView ∈ {null, 'boundary', 'facility', 'capacity'}.
        ensemble: null,
        ensembleView: null,

        // --- delta-playback state (mirrors the falcomchain Flow design) ---
        // Live node→district map maintained incrementally as `changed_nodes`
        // deltas are applied. Reset only when the chain rewinds or jumps
        // backward; otherwise patched in O(|changed_nodes|) per step.
        currentAssignment: new Map(),
        currentAssignmentStep: -1,
        // Stable district→colour map. Districts that survive across
        // steps keep their colour, so the animation only repaints the
        // bits that actually changed. New districts get new colours
        // that don't collide with current neighbours.
        stableDistrictColors: new Map(),
    };
}

/**
 * Mount a FalcomPlot visualiser into the given DOM nodes.
 *
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas       - target canvas (sized by component CSS)
 * @param {HTMLElement} [opts.controlsEl]       - container with Play/Pause/Step buttons
 * @param {HTMLElement} [opts.sidebarEl]        - container for status panel
 * @param {HTMLElement} [opts.statusEl]         - element to receive log messages
 * @param {HTMLElement} [opts.treeMetaEl]       - element to receive per-step metadata
 * @param {HTMLElement} [opts.tooltipEl]        - tooltip element shown on node hover
 * @param {string} opts.dataPath                - URL prefix containing blocks.json, manifest.json, step_*.json
 * @param {Object} [opts.controlIds]            - map of logical name -> element id inside controlsEl
 * @returns {Promise<Function>} cleanup function
 */
export async function mountFalcomPlot(opts) {
    const {
        canvas,
        controlsEl = null,
        sidebarEl = null,
        statusEl = null,
        treeMetaEl = null,
        tooltipEl = null,
        dataPath,
        controlIds = {
            play: 'fp-playBtn',
            pause: 'fp-pauseBtn',
            stop: 'fp-stopBtn',
            next: 'fp-nextBtn',
            prev: 'fp-prevBtn',
            final: 'fp-finalBtn',
            speed: 'fp-speedSlider',
            speedLabel: 'fp-speedLabel',
            iter: 'fp-iterationInput',
            go: 'fp-goBtn',
            toggleDetail: 'fp-toggleDetailBtn',
            currentViewMode: 'fp-currentViewMode',
            currentColoringMode: 'fp-currentColoringMode',
            ensembleSelect: 'fp-ensembleSelect',
        },
    } = opts;

    if (!canvas) throw new Error('mountFalcomPlot: opts.canvas is required');
    if (!dataPath) throw new Error('mountFalcomPlot: opts.dataPath is required');

    const config = cloneConfig();
    const state = makeInitialState();

    // Modules ------------------------------------------------------------
    const logger = new Logger(statusEl, config);
    const dataLoader = new DataLoader(logger, dataPath);
    const renderer = new Renderer(canvas, config, VISUAL);
    const toleranceChecker = new ToleranceChecker();
    const viewManager = new ViewManager(canvas, config);
    const inputHandler = new InputHandler(canvas, viewManager);
    const animationController = new AnimationController(dataLoader, logger, config);

    // Helpers ------------------------------------------------------------
    function $(id) {
        const root = controlsEl || document;
        return root.querySelector(`#${id}`) || document.getElementById(id);
    }

    function updateModeIndicator() {
        const el1 = $(controlIds.currentViewMode);
        const el2 = $(controlIds.currentColoringMode);
        if (el1) el1.textContent = state.detailLevel.toUpperCase();
        if (el2) el2.textContent = '';
    }

    function resize() {
        // Use the canvas's CSS box, not window size. The renderer uses
        // canvas.width/height directly for centering math, so keep them
        // equal to CSS pixels (skip dpr) — slightly less crisp on retina,
        // but avoids a dpr-scale mismatch with viewManager's auto-centre.
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 600));
        const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 400));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        redraw();
    }

    function updateStepMetadata() {
        const panel = treeMetaEl || $('treeMetadata');
        if (!panel) {
            updateModeIndicator();
            return;
        }
        const kv = (k, v) =>
            `<div class="fp-kv"><b>${k}:</b> <span>${String(v)}</span></div>`;

        let html = '';
        if (state.phaseLabel) {
            html += `<div class="fp-phase-label">${state.phaseLabel}</div>`;
        }
        const sd = state.stepData;
        if (sd) {
            const numDistricts = sd.districts ? Object.keys(sd.districts).length : '?';
            html += kv('state', sd.step);
            html += kv('energy', sd.energy?.toFixed(1) ?? '?');
            html += kv('districts', numDistricts);
        }
        const cf = state.currentFrame;
        if (cf) {
            if (cf.type === 'select') {
                html += '<hr>';
                html += kv('supergraph nodes', Object.keys(cf.data.supergraph_nodes || {}).length);
                html += kv('merged superdistricts', (cf.data.selected_superdistricts || []).join(', '));
                html += kv('merged base nodes', (cf.data.merged_base_nodes || []).length);
            } else if (cf.type === 'facility') {
                html += '<hr>';
                html += kv('centers', Object.keys(cf.data.centers || {}).length);
            } else if (cf.type === 'accept_reject') {
                html += '<hr>';
                html += kv('E(proposed)', cf.data.energy_proposed?.toFixed(1));
                html += kv('E(current)', cf.data.energy_current?.toFixed(1));
                const delta = (cf.data.energy_proposed - cf.data.energy_current).toFixed(1);
                html += kv('ΔE', delta);
                html +=
                    `<div class="fp-accept ${cf.data.accepted ? 'fp-accepted' : 'fp-rejected'}">` +
                    `${cf.data.accepted ? 'ACCEPTED' : 'REJECTED'}</div>`;
            } else if (cf.type === 'tree_cut') {
                html += `<div class="fp-section-label">${cf.sectionLabel || ''}</div>`;
            }
        }
        if (state.metadata?.n_cuts != null) {
            html += '<hr>';
            html += kv('admissible cuts', state.metadata.n_cuts);
            html += kv(
                'ψ chosen/total',
                `${state.metadata.psi_chosen?.toFixed(2)} / ${state.metadata.psi_total?.toFixed(2)}`,
            );
            if (state.metadata.cut_side_size != null) {
                html += kv('cut side', `${state.metadata.cut_side_size} nodes`);
            }
        }
        if (state.manifest?.parameters) {
            const p = state.manifest.parameters;
            html += '<hr>';
            html += kv('ε', p.epsilon);
            html += kv('d̄', p.demand_target);
            html += kv('c_max', p.capacity_level);
        }
        // Ensemble summary (when overlay is active)
        if (state.ensembleView && state.ensemble) {
            html += '<hr>';
            const ens = state.ensemble;
            if (state.ensembleView === 'boundary') {
                html += kv('boundary edges', Object.keys(ens.boundary_frequencies || {}).length);
                html += kv('robust (≥0.9)', ens.boundary_robust_count ?? '—');
            } else if (state.ensembleView === 'facility') {
                html += kv('candidates', Object.keys(ens.facility_frequencies || {}).length);
                html += kv('essential (≥0.9)', ens.facility_essential_count ?? '—');
            } else if (state.ensembleView === 'capacity') {
                const cv = ens.capacity?.demand_cv;
                if (cv) html += kv('demand CV (mean)', cv.mean?.toFixed(3));
            }
            html += kv('samples', ens.n_samples ?? '—');
        }
        panel.innerHTML =
            html ||
            '<div class="fp-no-data">No data</div>';
        updateModeIndicator();
    }

    function redraw() {
        updateStepMetadata();
        renderer.draw(state, (n) => toleranceChecker.isWithinTolerance(n, state.metadata));
    }

    // Wire control listeners -------------------------------------------
    const cleanups = [];
    function on(el, ev, fn) {
        if (!el) return;
        el.addEventListener(ev, fn);
        cleanups.push(() => el.removeEventListener(ev, fn));
    }

    const playBtn = $(controlIds.play);
    const pauseBtn = $(controlIds.pause);
    const stopBtn = $(controlIds.stop);
    const finalBtn = $(controlIds.final);
    const nextBtn = $(controlIds.next);
    const prevBtn = $(controlIds.prev);
    const speedSlider = $(controlIds.speed);
    const speedLabel = $(controlIds.speedLabel);
    const iterInput = $(controlIds.iter);
    const goBtn = $(controlIds.go);
    const toggleDetailBtn = $(controlIds.toggleDetail);
    const ensembleSelect = $(controlIds.ensembleSelect);

    on(playBtn, 'click', () => {
        animationController.play(state, redraw, viewManager, updateStepMetadata);
    });
    on(pauseBtn, 'click', () => {
        animationController.pause(state);
    });
    on(stopBtn, 'click', () => {
        animationController.stop(state, redraw);
    });
    on(finalBtn, 'click', () => {
        if (state.maxIteration) {
            animationController.jumpToIteration(
                state.maxIteration,
                state,
                redraw,
                viewManager,
                state.centroidMaps,
                updateStepMetadata,
            );
        }
    });
    on(nextBtn, 'click', async () => {
        if (state.detailLevel === 'overview') {
            const next = state.iteration + 1;
            if (state.maxIteration && next > state.maxIteration) return;
            await animationController.jumpToIteration(
                next, state, redraw, viewManager, state.centroidMaps, updateStepMetadata,
            );
            return;
        }
        if (animationController.advanceOneFrame(state)) {
            redraw();
            updateStepMetadata();
            return;
        }
        const next = state.iteration + 1;
        if (state.maxIteration && next > state.maxIteration) return;
        await animationController.jumpToIteration(
            next, state, redraw, viewManager, state.centroidMaps, updateStepMetadata,
        );
    });
    on(prevBtn, 'click', async () => {
        if (state.detailLevel === 'overview') {
            const prev = state.iteration - 1;
            if (prev < 1) return;
            await animationController.jumpToIteration(
                prev, state, redraw, viewManager, state.centroidMaps, updateStepMetadata,
            );
            return;
        }
        if (animationController.retreatOneFrame(state)) {
            redraw();
            updateStepMetadata();
            return;
        }
        const prev = state.iteration - 1;
        if (prev < 1) return;
        await animationController.jumpToIteration(
            prev, state, redraw, viewManager, state.centroidMaps, updateStepMetadata,
        );
    });
    on(speedSlider, 'input', (e) => {
        state.animationSpeed = parseFloat(e.target.value);
        if (speedLabel) speedLabel.textContent = `${state.animationSpeed}x`;
    });
    // Sync state.animationSpeed with the slider's initial value so the
    // first Play uses the slider's default (e.g. 1.5x) instead of 1x.
    if (speedSlider) {
        const initial = parseFloat(speedSlider.value);
        if (Number.isFinite(initial) && initial > 0) {
            state.animationSpeed = initial;
            if (speedLabel) speedLabel.textContent = `${initial}x`;
        }
    }
    on(goBtn, 'click', async () => {
        const targetIter = parseInt(iterInput?.value ?? '0', 10);
        if (isNaN(targetIter) || targetIter < 0) return;
        await animationController.jumpToIteration(
            targetIter, state, redraw, viewManager, state.centroidMaps, updateStepMetadata,
        );
    });
    on(toggleDetailBtn, 'click', (e) => {
        if (state.detailLevel === 'detailed') {
            state.detailLevel = 'overview';
            e.target.textContent = 'Detailed view';
        } else {
            state.detailLevel = 'detailed';
            e.target.textContent = 'Overview';
        }
        updateModeIndicator();
        if (state.iteration > 0) {
            animationController.jumpToIteration(
                state.iteration, state, redraw, viewManager,
                state.centroidMaps, updateStepMetadata,
            );
        } else {
            redraw();
        }
    });
    on(ensembleSelect, 'change', async (e) => {
        const v = e.target.value;
        state.ensembleView = v === 'none' ? null : v;
        if (state.ensembleView && !state.ensemble) {
            state.ensemble = await dataLoader.loadEnsemble();
        }
        redraw();
    });

    // Mouse listeners on the canvas. attachMouseListeners now returns
    // a detach function — push it into cleanups so listeners are
    // properly removed when the FalcomPlot remounts (e.g. on dataset
    // switch). Without this, old listeners keep firing on the same
    // canvas with stale state and paint the previous dataset back
    // over the new one ("ghost plot" artefact).
    const detachMouseListeners = inputHandler.attachMouseListeners(
        canvas, state, viewManager, redraw, state.nodes, toleranceChecker, state.metadata, tooltipEl,
    );
    if (typeof detachMouseListeners === 'function') {
        cleanups.push(detachMouseListeners);
    }

    // Window resize via ResizeObserver on the canvas (more reliable for
    // embedded Svelte component than window-resize alone).
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => resize());
        ro.observe(canvas);
        cleanups.push(() => ro.disconnect());
    } else {
        on(window, 'resize', resize);
    }

    // Initial sizing — needs to happen after the canvas is in the DOM
    requestAnimationFrame(() => {
        resize();
    });

    // Init: load blocks, manifest, centre the view, jump to step 1 ------
    try {
        logger.updateStatus('Initialising…', 'info');

        const { blocksBounds, detectedSwap } = await dataLoader.loadBlocks(
            state.blocksPaths,
            state.centroidMaps,
            state.blockIdToFeature,
            state.blockIdToGeometry,
            state.blockIdToBounds,
        );
        state.blocksBounds = blocksBounds;
        state.detectedSwap = detectedSwap;

        resize();
        viewManager.autoCenterAndScale(state);
        redraw();

        // Load manifest + adjacency in parallel — adjacency is used by
        // the per-step district-coloring routine, so we want it ready
        // before the first step's assignment is applied.
        const [manifest] = await Promise.all([
            dataLoader.loadManifest(),
            dataLoader.loadAdjacency(),
        ]);
        if (manifest && manifest.total_steps) {
            state.manifest = manifest;
            state.maxIteration = manifest.total_steps;
            logger.log(
                `Chain: ${manifest.total_steps} steps, ${manifest.graph_nodes} nodes`,
                'success',
            );
        }

        if (state.maxIteration > 0) {
            // Start at step 1 (the first recorded chain state) so the
            // animation reads as a forward trajectory and the user can
            // press Play / Next from the very beginning.
            await animationController.jumpToIteration(
                1,
                state,
                redraw,
                viewManager,
                state.centroidMaps,
                updateStepMetadata,
            );
        }

        logger.log(`Ready — max steps: ${state.maxIteration}`, 'success');
    } catch (err) {
        logger.error?.(`Init failed: ${err.message}`);
        console.error('FalcomPlot init error:', err);
    }

    // Cleanup ------------------------------------------------------------
    return function cleanup() {
        try {
            // Stop animation loop and any pending data fetches we can.
            if (state.isPlaying) {
                animationController.stop(state, () => {});
                state.isPlaying = false;
            }
        } catch (_) {}
        for (const fn of cleanups) {
            try { fn(); } catch (_) {}
        }
        cleanups.length = 0;
    };
}
