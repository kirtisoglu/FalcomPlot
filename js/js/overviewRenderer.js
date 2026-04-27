// Overview grid renderer — renders a filmstrip of thumbnails, one per chain step.
// Each thumbnail shows the final state: district coloring on blocks,
// supergraph edges/nodes, facility center markers, and candidate stars.
//
// This reuses the same drawing logic as the detailed view's Renderer,
// but composites all layers (districts + supergraph + facilities) into
// a single frame per step.

export class OverviewRenderer {
    constructor(config, visual, dataLoader, logger) {
        this.config = config;
        this.visual = visual;
        this.dataLoader = dataLoader;
        this.logger = logger;

        // Thumbnail sizing
        this.thumbWidth = 220;
        this.thumbHeight = 220;

        // Cache: stepNum -> loaded overview data
        this.stepCache = new Map();

        // Currently selected thumbnail
        this.selectedStep = null;
    }

    /**
     * Create (or return existing) overview container.
     */
    createContainer() {
        let container = document.getElementById("overviewGrid");
        if (container) return container;

        container = document.createElement("div");
        container.id = "overviewGrid";
        Object.assign(container.style, {
            position: "absolute",
            top: "0",
            left: "0",
            right: "310px",
            bottom: "0",
            overflowY: "auto",
            background: "#111",
            zIndex: "50",
            padding: "16px",
            display: "none",
            scrollbarWidth: "thin",
            scrollbarColor: "#2196f3 transparent",
        });
        document.body.appendChild(container);
        return container;
    }

    show() {
        const container = this.createContainer();
        container.style.display = "block";
        const canvas = document.getElementById("graphCanvas");
        if (canvas) canvas.style.display = "none";
    }

    hide() {
        const container = document.getElementById("overviewGrid");
        if (container) container.style.display = "none";
        const canvas = document.getElementById("graphCanvas");
        if (canvas) canvas.style.display = "block";
    }

    /**
     * Load all steps and render the overview grid.
     */
    async renderAll(state, onThumbnailClick) {
        this.show();
        const container = document.getElementById("overviewGrid");
        container.innerHTML = "";

        const maxStep = state.maxIteration || 0;
        if (maxStep === 0) {
            container.innerHTML = '<div style="color:#90caf9; padding:16px;">No steps to display.</div>';
            return;
        }

        // Loading indicator
        const loadingEl = document.createElement("div");
        loadingEl.style.cssText = "color: #90caf9; font-size: 14px; padding: 16px;";
        loadingEl.textContent = `Loading overview (0/${maxStep})...`;
        container.appendChild(loadingEl);

        // Compute the world→thumbnail transform once (shared across all thumbnails)
        const thumbTransform = this._computeThumbTransform(state);

        // Load all steps
        for (let step = 1; step <= maxStep; step++) {
            if (!this.stepCache.has(step)) {
                const data = await this._loadStepOverview(step);
                if (data) this.stepCache.set(step, data);
            }
            loadingEl.textContent = `Loading overview (${step}/${maxStep})...`;
        }

        // Clear and build grid
        container.innerHTML = "";

        const header = document.createElement("div");
        header.style.cssText = "color: #fff; font-size: 16px; font-weight: 600; margin-bottom: 12px; border-bottom: 1px solid #2196f3; padding-bottom: 8px;";
        header.textContent = `Overview — ${maxStep} steps`;
        container.appendChild(header);

        const grid = document.createElement("div");
        grid.style.cssText = "display: flex; flex-wrap: wrap; gap: 12px;";
        container.appendChild(grid);

        for (let step = 1; step <= maxStep; step++) {
            const cached = this.stepCache.get(step);
            if (!cached) continue;

            const wrapper = this._createThumbnail(step, cached, thumbTransform, state, onThumbnailClick);
            grid.appendChild(wrapper);
        }

        this.logger.log(`Overview rendered: ${maxStep} thumbnails`, "success");
    }

    // ----------------------------------------------------------------
    // Data loading
    // ----------------------------------------------------------------

    async _loadStepOverview(step) {
        try {
            const stepData = await this.dataLoader.loadStep(step);
            if (!stepData) return null;

            const phaseData = await this.dataLoader.loadPhases(step);
            const phaseStep = Array.isArray(phaseData) ? phaseData[0] : phaseData;

            // Facility centers (merge upper + lower level)
            const upperCenters = phaseStep?.upper_level?.phase4?.centers || {};
            const lowerCenters = phaseStep?.lower_level?.phase4?.centers || {};
            const centers = { ...upperCenters, ...lowerCenters };

            // Supergraph data
            const selectData = phaseStep?.select || {};
            const sgEdges = selectData.supergraph_edges || [];
            const sgCoords = phaseStep?.upper_level?.supergraph_coords
                || selectData.supergraph_coords || {};
            const sgNodes = selectData.supergraph_nodes || {};

            // Accept/reject
            const ar = phaseStep?.accept_reject || {};

            return {
                assignment: stepData.assignment,
                districts: stepData.districts,
                energy: stepData.energy,
                accepted: stepData.accepted,
                centers,
                sgEdges,
                sgCoords,
                sgNodes,
                energyProposed: ar.energy_proposed,
                energyCurrent: ar.energy_current,
            };
        } catch (err) {
            this.logger.warn(`Overview step ${step}: ${err.message}`);
            return null;
        }
    }

    // ----------------------------------------------------------------
    // Transform
    // ----------------------------------------------------------------

    _computeThumbTransform(state) {
        const bounds = state.blocksBounds;
        if (!bounds || !(bounds.minx < bounds.maxx)) {
            return { k: 1, x: 0, y: 0 };
        }
        const pad = 10;
        const w = this.thumbWidth - 2 * pad;
        const h = this.thumbHeight - 2 * pad;
        const bw = bounds.maxx - bounds.minx;
        const bh = bounds.maxy - bounds.miny;
        const k = Math.min(w / bw, h / bh);
        const cx = (bounds.minx + bounds.maxx) / 2;
        const cy = (bounds.miny + bounds.maxy) / 2;
        return {
            k,
            x: this.thumbWidth / 2 - k * cx,
            y: this.thumbHeight / 2 - k * cy,
        };
    }

    // ----------------------------------------------------------------
    // Thumbnail creation
    // ----------------------------------------------------------------

    _createThumbnail(step, cached, transform, state, onThumbnailClick) {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = `
            display: flex; flex-direction: column; align-items: center;
            background: #1a1a1a; border: 1px solid #333; border-radius: 6px;
            padding: 6px; cursor: pointer; transition: border-color 0.2s;
        `;
        wrapper.addEventListener("mouseenter", () => { wrapper.style.borderColor = "#2196f3"; });
        wrapper.addEventListener("mouseleave", () => {
            wrapper.style.borderColor = this.selectedStep === step ? "#2196f3" : "#333";
        });

        const canvas = document.createElement("canvas");
        canvas.width = this.thumbWidth;
        canvas.height = this.thumbHeight;
        canvas.style.cssText = "border-radius: 4px; background: #000;";
        wrapper.appendChild(canvas);

        // Draw the final-frame content
        this._drawFinalFrame(canvas, cached, transform, state);

        // Label bar
        const label = document.createElement("div");
        const acceptColor = cached.accepted ? "#4caf50" : "#f44336";
        const acceptText = cached.accepted ? "ACC" : "REJ";
        label.innerHTML = `
            <span style="color:#fff; font-size:11px; font-weight:600;">Step ${step}</span>
            <span style="color:#90caf9; font-size:10px; margin-left:6px;">E=${cached.energy?.toFixed(0) ?? '?'}</span>
            <span style="color:${acceptColor}; font-size:10px; font-weight:bold; margin-left:4px;">${acceptText}</span>
        `;
        label.style.cssText = "margin-top: 4px; text-align: center;";
        wrapper.appendChild(label);

        wrapper.addEventListener("click", () => {
            this.selectedStep = step;
            if (onThumbnailClick) onThumbnailClick(step);
        });

        return wrapper;
    }

    // ----------------------------------------------------------------
    // Drawing — replicates Renderer.draw() layers for the "final frame"
    // ----------------------------------------------------------------

    _drawFinalFrame(canvas, cached, transform, state) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(transform.x, transform.y);
        ctx.scale(transform.k, transform.k);

        // Build per-step coloring maps
        const blockColors = new Map();   // blockId -> color
        const blockDistrict = new Map(); // blockId -> districtId
        const districtColors = new Map();

        if (cached.assignment) {
            for (const [nodeId, districtId] of Object.entries(cached.assignment)) {
                const did = String(districtId);
                if (!districtColors.has(did)) {
                    const ci = this._stableColorIndex(did);
                    districtColors.set(did, this.dataLoader.generateDistrictColor(ci));
                }
                blockColors.set(nodeId, districtColors.get(did));
                blockDistrict.set(nodeId, did);
            }
        }

        // ========== LAYER 0: Block background ==========
        if (state.blocksPaths.length > 0) {
            ctx.fillStyle = this.config.colors.blockFill;
            ctx.strokeStyle = this.config.colors.blockStroke;
            ctx.lineWidth = this.visual.blockLineWidth / transform.k;
            for (const p of state.blocksPaths) {
                ctx.fill(p);
                ctx.stroke(p);
            }
        }

        // ========== LAYER 1: District outlines (colored per district) ==========
        for (const [blockId, color] of blockColors) {
            const geom = state.blockIdToGeometry.get(blockId);
            if (!geom) continue;

            const lw = 0.5 / transform.k;
            if (geom.type === "Polygon") {
                this._strokePolygon(ctx, geom.coordinates, color, lw, state.detectedSwap);
            } else if (geom.type === "MultiPolygon") {
                for (const poly of geom.coordinates) {
                    this._strokePolygon(ctx, poly, color, lw, state.detectedSwap);
                }
            }
        }

        // ========== LAYER 2: Supergraph edges + nodes ==========
        if (cached.sgEdges?.length > 0) {
            const coords = state.manifest?.node_coordinates || {};

            // Compute district centroids from the step's assignment
            const sums = new Map();
            for (const [nid, did] of blockDistrict) {
                const c = coords[nid];
                if (!c) continue;
                if (!sums.has(did)) sums.set(did, { sx: 0, sy: 0, n: 0 });
                const s = sums.get(did);
                s.sx += c[0]; s.sy += c[1]; s.n++;
            }
            const centroids = new Map();
            for (const [did, s] of sums) {
                if (s.n > 0) centroids.set(did, [s.sx / s.n, s.sy / s.n]);
            }

            // Edges
            ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
            ctx.lineWidth = 2 / transform.k;
            ctx.beginPath();
            for (const [u, v] of cached.sgEdges) {
                const cu = centroids.get(u) || cached.sgCoords?.[u];
                const cv = centroids.get(v) || cached.sgCoords?.[v];
                if (cu && cv) {
                    ctx.moveTo(cu[0], cu[1]);
                    ctx.lineTo(cv[0], cv[1]);
                }
            }
            ctx.stroke();

            // Nodes at centroids
            for (const [did, centroid] of centroids) {
                ctx.beginPath();
                ctx.arc(centroid[0], centroid[1], 0.2, 0, Math.PI * 2);
                ctx.fillStyle = "#ffffff";
                ctx.fill();
                ctx.strokeStyle = "#333";
                ctx.lineWidth = 0.5 / transform.k;
                ctx.stroke();
            }
        }

        // ========== LAYER 3: Candidate stars ==========
        if (state.manifest?.node_candidates && state.manifest?.node_coordinates) {
            const candidates = state.manifest.node_candidates;
            const coords = state.manifest.node_coordinates;
            for (const [nodeId, isCand] of Object.entries(candidates)) {
                if (!isCand) continue;
                const c = coords[nodeId];
                if (!c) continue;
                this._drawStar(ctx, c[0], c[1], 0.12, 5, 0.5);
                ctx.fillStyle = "#FFD700";
                ctx.fill();
            }
        }

        // ========== LAYER 4: Facility centers (cyan cross) ==========
        if (cached.centers) {
            const coords = state.manifest?.node_coordinates || {};
            for (const [did, centerId] of Object.entries(cached.centers)) {
                if (!centerId) continue;
                const c = coords[centerId];
                if (!c) continue;
                const R = 0.25;
                ctx.strokeStyle = "#00ffff";
                ctx.lineWidth = 1.5 / transform.k;
                ctx.beginPath();
                ctx.moveTo(c[0] - R, c[1]); ctx.lineTo(c[0] + R, c[1]);
                ctx.moveTo(c[0], c[1] - R); ctx.lineTo(c[0], c[1] + R);
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    // ----------------------------------------------------------------
    // Drawing helpers
    // ----------------------------------------------------------------

    _strokePolygon(ctx, coords, color, lineWidth, detectedSwap) {
        const path = new Path2D();
        for (const ring of coords) {
            if (!ring?.length) continue;
            const first = detectedSwap ? [ring[0][1], ring[0][0]] : ring[0];
            path.moveTo(first[0], first[1]);
            for (let i = 1; i < ring.length; i++) {
                const pt = detectedSwap ? [ring[i][1], ring[i][0]] : ring[i];
                path.lineTo(pt[0], pt[1]);
            }
            path.closePath();
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.globalAlpha = 0.7;
        ctx.stroke(path);
        ctx.globalAlpha = 1.0;
    }

    _drawStar(ctx, x, y, rOuter, spikes, inset) {
        const rot = Math.PI / 2 * 3;
        const step = Math.PI / spikes;
        ctx.beginPath();
        ctx.moveTo(x, y - rOuter);
        let rotA = rot;
        for (let i = 0; i < spikes; i++) {
            ctx.lineTo(x + Math.cos(rotA) * rOuter, y + Math.sin(rotA) * rOuter);
            rotA += step;
            ctx.lineTo(x + Math.cos(rotA) * (rOuter * inset), y + Math.sin(rotA) * (rOuter * inset));
            rotA += step;
        }
        ctx.closePath();
    }

    _stableColorIndex(districtId) {
        const num = parseInt(districtId, 10);
        if (!isNaN(num) && num > 0) return num;
        let hash = 0;
        for (let i = 0; i < districtId.length; i++) {
            hash = ((hash << 5) - hash + districtId.charCodeAt(i)) | 0;
        }
        return Math.abs(hash % 20) + 1;
    }
}
