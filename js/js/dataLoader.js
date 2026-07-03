// Data loading

class GeometryUtils {
    static pathCallCount = 0;

    static addPolygonPath(coords, swap, blocksPaths) {
        GeometryUtils.pathCallCount++;
        const path = new Path2D();
        let ringsProcessed = 0;
        for (const ring of coords) {
            if (!ring?.length) {
                continue;
            }
            ringsProcessed++;
            const first = swap ? [ring[0][1], ring[0][0]] : ring[0];
            path.moveTo(first[0], first[1]);
            for (let i = 1; i < ring.length; i++) {
                const pt = swap ? [ring[i][1], ring[i][0]] : ring[i];
                path.lineTo(pt[0], pt[1]);
            }
            path.closePath();
        }
        if (ringsProcessed > 0) {
            blocksPaths.push(path);
        }
    }

    static calculateCentroid(ring, swap) {
        let a = 0, cx = 0, cy = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            const p0 = swap ? [ring[i][1], ring[i][0]] : ring[i];
            const p1 = swap ? [ring[i + 1][1], ring[i + 1][0]] : ring[i + 1];
            const cross = p0[0] * p1[1] - p1[0] * p0[1];
            a += cross;
            cx += (p0[0] + p1[0]) * cross;
            cy += (p0[1] + p1[1]) * cross;
        }

        if (Math.abs(a) < 1e-12) {
            let sx = 0, sy = 0;
            for (const pt of ring) {
                const x = swap ? pt[1] : pt[0];
                const y = swap ? pt[0] : pt[1];
                sx += x;
                sy += y;
            }
            return [sx / ring.length, sy / ring.length];
        }
        a *= 0.5;
        return [cx / (6 * a), cy / (6 * a)];
    }

    static detectSwap(sample) {
        if (!Array.isArray(sample) || sample.length < 2) return false;
        const a = sample[0], b = sample[1];
        return a > 40 && a < 43 && b < -80 && b > -90;
    }
}

export class DataLoader {
    constructor(logger, dataPath = "data") {
        this.logger = logger;
        // dataPath is the URL prefix where blocks.json, manifest.json,
        // step_NNNN.json, ensemble.json, adjacency.json, etc. live.
        // No trailing slash.
        this.dataPath = dataPath.replace(/\/$/, "");
        // Cache of already-loaded steps + phases so scrubbing is fast.
        this._stepCache = new Map();
        this._phaseCache = new Map();
        this._ensembleCache = null;
        // Real graph adjacency (loaded once from adjacency.json when
        // present, used for per-step district-adjacency in O(|E|)).
        // Map<node_id_str, Set<node_id_str>>
        this._nodeAdjacency = null;
    }

    _url(rel) {
        return `${this.dataPath}/${rel}`;
    }

    // ----------------------------------------------------------------
    // Blocks (unchanged — works with both old and new format)
    // ----------------------------------------------------------------
    async loadBlocks(blocksPaths, centroidMaps, blockIdToFeature, blockIdToGeometry, blockIdToBounds) {
        try {
            this.logger.updateStatus("Loading blocks.json...", "info");
            const response = await fetch(this._url("blocks.json"));

            if (!response.ok) {
                throw new Error(`Failed to fetch blocks.json: ${response.status} ${response.statusText}`);
            }

            const gj = await response.json();

            if (!gj.features || !Array.isArray(gj.features)) {
                throw new Error("Invalid GeoJSON: missing features array");
            }

            const f0 = gj.features[0];
            let sample;
            if (f0?.geometry?.type === "Polygon") {
                sample = f0.geometry.coordinates?.[0]?.[0];
            } else if (f0?.geometry?.type === "MultiPolygon") {
                sample = f0.geometry.coordinates?.[0]?.[0]?.[0];
            }
            const detectedSwap = GeometryUtils.detectSwap(sample);
            this.logger.log(`Coordinate order: ${detectedSwap ? "LAT,LON (swapping)" : "LON,LAT"}`);

            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;

            for (const f of gj.features) {
                const g = f.geometry;
                if (!g) continue;

                let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;

                const updateBounds = (ring) => {
                    for (const pt of ring) {
                        const x = detectedSwap ? pt[1] : pt[0];
                        const y = detectedSwap ? pt[0] : pt[1];
                        if (x < minx) minx = x;
                        if (y < miny) miny = y;
                        if (x > maxx) maxx = x;
                        if (y > maxy) maxy = y;
                        if (x < bMinX) bMinX = x;
                        if (y < bMinY) bMinY = y;
                        if (x > bMaxX) bMaxX = x;
                        if (y > bMaxY) bMaxY = y;
                    }
                };

                if (g.type === "Polygon") {
                    GeometryUtils.addPolygonPath(g.coordinates, detectedSwap, blocksPaths);
                    for (const ring of g.coordinates) updateBounds(ring);
                } else if (g.type === "MultiPolygon") {
                    for (const poly of g.coordinates) {
                        GeometryUtils.addPolygonPath(poly, detectedSwap, blocksPaths);
                        for (const ring of poly) updateBounds(ring);
                    }
                }

                const outer = g.type === "Polygon" ? g.coordinates[0]
                    : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;

                let fid = f.id != null ? String(f.id) : undefined;
                if (!fid && f.properties && f.properties.id != null) {
                    fid = String(f.properties.id);
                }

                if (outer && outer.length > 0) {
                    const centroid = GeometryUtils.calculateCentroid(outer, detectedSwap);
                    if (fid) {
                        centroidMaps.byFeatId.set(fid, centroid);
                        if (f.properties?.GEOID20) centroidMaps.byGeoID20.set(String(f.properties.GEOID20), centroid);
                        if (f.properties?.GEOID) centroidMaps.byGeoID.set(String(f.properties.GEOID), centroid);
                        if (blockIdToFeature) blockIdToFeature.set(fid, f);
                        if (blockIdToGeometry) blockIdToGeometry.set(fid, g);
                        if (blockIdToBounds) blockIdToBounds.set(fid, [bMinX, bMinY, bMaxX, bMaxY]);
                    }
                }
            }

            const blocksBounds = (minx < maxx && miny < maxy)
                ? { minx, miny, maxx, maxy }
                : { minx: 0, miny: 0, maxx: 1, maxy: 1 };

            this.logger.log(`Blocks loaded: ${blocksPaths.length} polygons, ${centroidMaps.byFeatId.size} centroids`, "success");
            return { blocksBounds, detectedSwap };
        } catch (err) {
            this.logger.warn(`Failed to load blocks.json: ${err.message}`);
            throw err;
        }
    }

    // ----------------------------------------------------------------
    // Manifest (new — reads chain metadata)
    // ----------------------------------------------------------------
    async loadManifest() {
        try {
            const response = await fetch(this._url("manifest.json"));
            if (!response.ok) {
                this.logger.warn("No manifest.json found, falling back to probe mode");
                return null;
            }
            const manifest = await response.json();
            this.logger.log(`Manifest loaded: ${manifest.total_steps} steps, ${manifest.graph_nodes} nodes`, "success");
            return manifest;
        } catch (err) {
            this.logger.warn(`Failed to load manifest.json: ${err.message}`);
            return null;
        }
    }

    // ----------------------------------------------------------------
    // Step (new — reads step_NNNN.json from Recorder output)
    // ----------------------------------------------------------------
    async loadStep(stepNum) {
        if (this._stepCache.has(stepNum)) {
            return this._stepCache.get(stepNum);
        }
        const padded = String(stepNum).padStart(4, "0");
        try {
            const response = await fetch(this._url(`step_${padded}.json`));
            if (!response.ok) {
                if (response.status === 404) {
                    this.logger.log(`Step ${stepNum} not found`, "info");
                    return null;
                }
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            this._stepCache.set(stepNum, data);
            this.logger.log(`Step ${stepNum}: energy=${data.energy?.toFixed(1)}, accepted=${data.accepted}`, "info");
            return data;
        } catch (err) {
            this.logger.warn(`Failed to load step_${padded}.json: ${err.message}`);
            return null;
        }
    }

    // ----------------------------------------------------------------
    // Apply a step's assignment to the state.
    //
    // The chain emits two paths:
    //   - `assignment`     — the full {node: district} mapping (large)
    //   - `changed_nodes`  — the delta vs the previous step (small)
    //
    // We always carry a live `state.currentAssignment` Map. When the
    // dashboard scrubs forward by exactly one step we patch the map
    // in O(|changed_nodes|) and recolour ONLY the affected districts;
    // when it jumps to an arbitrary step we rebuild from `assignment`.
    // District→colour mapping (`state.stableDistrictColors`) survives
    // across steps so unaffected districts keep their colour.
    // ----------------------------------------------------------------
    applyStepToState(stepData, state) {
        // Decide between delta and full rebuild based on whether the
        // step is one ahead of what's already in state.
        const stepNum = typeof stepData.step === "number" ? stepData.step : null;
        const isDelta = (
            stepNum !== null
            && state.currentAssignmentStep >= 0
            && stepNum === state.currentAssignmentStep + 1
            && stepData.changed_nodes
            && state.currentAssignment.size > 0
        );

        if (isDelta) {
            this._applyDelta(stepData, state);
        } else {
            this._applyFull(stepData, state);
        }
        state.currentAssignmentStep = stepNum !== null
            ? stepNum
            : state.currentAssignmentStep;
        state.stepData = stepData;
        return state.stableDistrictColors.size;
    }

    /** Rebuild from a full assignment dict (used for jumps + step 1). */
    _applyFull(stepData, state) {
        state.currentAssignment = new Map();
        state.districtBlockColors.clear();
        state.blockIdToDistrictId.clear();
        state.nodeColorOverrides.clear();

        for (const [nodeId, districtId] of Object.entries(stepData.assignment)) {
            const did = String(districtId);
            state.currentAssignment.set(nodeId, did);
            state.blockIdToDistrictId.set(nodeId, did);
        }

        const neighbours = this._buildDistrictAdjacency(state.currentAssignment, state);
        const colours = this._graphColorDistricts(
            neighbours, state.stableDistrictColors,
        );
        state.stableDistrictColors = colours;

        for (const [nodeId, did] of state.currentAssignment) {
            const c = colours.get(did);
            state.districtBlockColors.set(nodeId, c);
            state.nodeColorOverrides.set(nodeId, c);
        }
    }

    /** Patch the live assignment with `changed_nodes` and recolour only
     *  the districts whose membership actually moved. */
    _applyDelta(stepData, state) {
        const changed = stepData.changed_nodes || {};
        const dirty = new Set();           // districts whose colour may need refresh
        for (const [nodeId, districtId] of Object.entries(changed)) {
            const newDid = String(districtId);
            const oldDid = state.currentAssignment.get(nodeId);
            if (oldDid !== undefined && oldDid !== newDid) dirty.add(oldDid);
            dirty.add(newDid);
            state.currentAssignment.set(nodeId, newDid);
            state.blockIdToDistrictId.set(nodeId, newDid);
        }

        // Drop districts that no longer have any nodes.
        const liveDistricts = new Set(state.currentAssignment.values());
        for (const did of [...state.stableDistrictColors.keys()]) {
            if (!liveDistricts.has(did)) state.stableDistrictColors.delete(did);
        }

        // Allocate colours for any new district id, then refresh blocks
        // belonging to dirty districts only.
        const neighbours = this._buildDistrictAdjacency(state.currentAssignment, state);
        const colours = this._graphColorDistricts(
            neighbours, state.stableDistrictColors,
        );
        state.stableDistrictColors = colours;

        // Recolour every node whose district is dirty. Cheap because
        // each dirty district owns ~50 LSOAs at LAS scale.
        for (const [nodeId, did] of state.currentAssignment) {
            if (!dirty.has(did)) continue;
            const c = colours.get(did);
            state.districtBlockColors.set(nodeId, c);
            state.nodeColorOverrides.set(nodeId, c);
        }
    }

    /**
     * Build a district adjacency map: district -> Set of neighboring district IDs.
     * Two districts are adjacent iff any of their nodes are graph-neighbors.
     *
     * Priority order:
     *   1. Real graph adjacency from `adjacency.json` (cached) — O(|E|).
     *   2. Integer-grid heuristic from `manifest.node_coordinates`. Only
     *      kicks in when coords look like an integer lattice; bails out
     *      on float coords (e.g. lat/lon).
     *   3. Bounding-box-touch heuristic from `blockIdToBounds`.
     */
    _buildDistrictAdjacency(nodeToDist, state) {
        const neighbors = new Map();
        for (const did of new Set(nodeToDist.values())) {
            neighbors.set(did, new Set());
        }

        const adj = this._nodeAdjacency;
        if (adj && adj.size > 0) {
            // Iterate adjacency edges once. Each edge crossing a
            // district boundary marks both districts as neighbours.
            for (const [u, vs] of adj) {
                const dU = nodeToDist.get(u);
                if (dU === undefined) continue;
                for (const v of vs) {
                    if (u >= v) continue;     // each undirected edge once
                    const dV = nodeToDist.get(v);
                    if (dV === undefined || dV === dU) continue;
                    neighbors.get(dU).add(dV);
                    neighbors.get(dV).add(dU);
                }
            }
            return neighbors;
        }

        const coords = state.manifest?.node_coordinates;
        const looksLikeGrid = coords && (() => {
            // Sample a few coords; if all look like integers we treat
            // it as a unit-grid lattice.
            let n = 0;
            for (const c of Object.values(coords)) {
                if (n++ >= 8) break;
                if (!Number.isInteger(c[0]) || !Number.isInteger(c[1])) return false;
            }
            return true;
        })();

        if (looksLikeGrid) {
            const coordToNode = new Map();
            for (const [nid, c] of Object.entries(coords)) {
                coordToNode.set(`${c[0]},${c[1]}`, nid);
            }
            for (const [nid, did] of nodeToDist) {
                const c = coords[nid];
                if (!c) continue;
                const [x, y] = c;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nb = coordToNode.get(`${x + dx},${y + dy}`);
                    if (!nb) continue;
                    const dN = nodeToDist.get(nb);
                    if (dN && dN !== did) {
                        neighbors.get(did).add(dN);
                        neighbors.get(dN).add(did);
                    }
                }
            }
            return neighbors;
        }

        // Last resort: bounding-box overlap. O(|V|²) — slow on real data.
        for (const [nid1, did1] of nodeToDist) {
            const b1 = state.blockIdToBounds?.get(nid1);
            if (!b1) continue;
            for (const [nid2, did2] of nodeToDist) {
                if (did1 === did2 || nid1 >= nid2) continue;
                const b2 = state.blockIdToBounds?.get(nid2);
                if (!b2) continue;
                const touches = !(b1[2] < b2[0] || b2[2] < b1[0] || b1[3] < b2[1] || b2[3] < b1[1]);
                if (touches) {
                    neighbors.get(did1).add(did2);
                    neighbors.get(did2).add(did1);
                }
            }
        }
        return neighbors;
    }

    /**
     * Assign distinct colors to districts so adjacent districts always
     * differ, and every district gets a stable colour. Uses a 20-colour
     * palette first; when exhausted, falls back to a golden-angle HSL
     * cycle that still respects the neighbour constraint.
     *
     * If ``previous`` is supplied (a Map<districtId, colourString> from
     * the prior step), every district that already has a colour AND
     * whose neighbours don't conflict keeps its colour. Only districts
     * that are new this step or whose previous colour now collides with
     * a neighbour get a fresh palette/HSL pick.
     */
    _graphColorDistricts(districtNeighbors, previous = null) {
        const palette = [
            "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
            "#42d4f4", "#f032e6", "#bfef45", "#469990", "#ffe119",
            "#9A6324", "#dcbeff", "#800000", "#aaffc3", "#000075",
            "#808000", "#ffd8b1", "#fabed4", "#a9a9a9", "#e6beff",
        ];

        // Stage 1: every district that already has a colour and whose
        // neighbours don't collide with it — keep that colour.
        const final = new Map();              // district -> colour string
        const usedColours = new Set();        // colours globally used
        const stillAvailable = new Set();     // districts needing a fresh pick

        if (previous && previous.size > 0) {
            for (const did of districtNeighbors.keys()) {
                const prevColour = previous.get(did);
                if (!prevColour) {
                    stillAvailable.add(did);
                    continue;
                }
                let collides = false;
                for (const nb of districtNeighbors.get(did)) {
                    const nbColour = previous.get(nb);
                    if (nbColour === prevColour) { collides = true; break; }
                }
                if (!collides) {
                    final.set(did, prevColour);
                    usedColours.add(prevColour);
                } else {
                    stillAvailable.add(did);
                }
            }
        } else {
            for (const did of districtNeighbors.keys()) stillAvailable.add(did);
        }

        // Stage 2: greedy first-fit on the remaining districts.
        // Sort by number of neighbors (most constrained first).
        const districts = [...stillAvailable].sort(
            (a, b) => districtNeighbors.get(b).size - districtNeighbors.get(a).size
        );

        const colorAssignment = new Map(); // district -> palette index
        const usedIndices = new Set();
        // Pre-mark palette colours that survivors are already holding,
        // so the remaining picks know what's globally taken.
        for (const c of usedColours) {
            const idx = palette.indexOf(c);
            if (idx >= 0) usedIndices.add(idx);
        }

        for (const did of districts) {
            // Find colors used by neighbors (in survivors + assignments).
            const neighborColors = new Set();
            for (const neighbor of districtNeighbors.get(did)) {
                if (final.has(neighbor)) {
                    const idx = palette.indexOf(final.get(neighbor));
                    if (idx >= 0) neighborColors.add(idx);
                }
                if (colorAssignment.has(neighbor)) {
                    neighborColors.add(colorAssignment.get(neighbor));
                }
            }

            // Pick the first palette index that is:
            //   1) not used by any neighbor (hard constraint)
            //   2) not used by any district at all (unique color)
            let chosen = -1;
            for (let i = 0; i < palette.length; i++) {
                if (!neighborColors.has(i) && !usedIndices.has(i)) {
                    chosen = i;
                    break;
                }
            }
            colorAssignment.set(did, chosen);
            if (chosen >= 0) usedIndices.add(chosen);
        }

        // Materialise palette colours into the running `final` map;
        // for any district that didn't get a palette slot (palette of
        // 20 exhausted under neighbour pressure), generate a unique
        // HSL via golden-angle that still avoids neighbour collisions.
        for (const [did, idx] of colorAssignment) {
            if (idx >= 0) final.set(did, palette[idx]);
        }
        let hueStep = 0;
        for (const [did, idx] of colorAssignment) {
            if (idx >= 0) continue;
            // Hues already used by neighbours.
            const neighbourColours = new Set();
            for (const nb of districtNeighbors.get(did)) {
                if (final.has(nb)) neighbourColours.add(final.get(nb));
            }
            let attempts = 0, colour = null;
            while (attempts < 360) {
                const hue = (hueStep++ * 137.508) % 360;
                colour = `hsl(${hue.toFixed(1)}, 70%, 50%)`;
                if (!neighbourColours.has(colour)) break;
                attempts++;
            }
            final.set(did, colour);
        }
        return final;
    }

    // ----------------------------------------------------------------
    // Phases (four-phase animation data)
    // ----------------------------------------------------------------
    async loadPhases(stepNum) {
        if (this._phaseCache.has(stepNum)) {
            return this._phaseCache.get(stepNum);
        }
        const padded = String(stepNum).padStart(4, "0");
        try {
            const response = await fetch(this._url(`phases/phases_${padded}.json`));
            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            this._phaseCache.set(stepNum, data);
            this.logger.log(`Phases for step ${stepNum}: ${data.length} phases`, "info");
            return data;
        } catch (err) {
            this.logger.warn(`Failed to load phases for step ${stepNum}: ${err.message}`);
            return null;
        }
    }

    // Real graph adjacency (e.g. LSOA-to-LSOA edges). Optional; if
    // absent the dashboard falls back to grid-coordinate heuristics.
    async loadAdjacency() {
        if (this._nodeAdjacency !== null) return this._nodeAdjacency;
        try {
            const r = await fetch(this._url("adjacency.json"));
            if (!r.ok) {
                this._nodeAdjacency = new Map();
                return this._nodeAdjacency;
            }
            const edges = await r.json();
            const adj = new Map();
            for (const [u, v] of edges) {
                const a = String(u), b = String(v);
                if (!adj.has(a)) adj.set(a, new Set());
                if (!adj.has(b)) adj.set(b, new Set());
                adj.get(a).add(b);
                adj.get(b).add(a);
            }
            this._nodeAdjacency = adj;
            this.logger.log(`Adjacency loaded: ${edges.length} edges, ${adj.size} nodes`, "success");
            return adj;
        } catch (err) {
            this.logger.warn(`Failed to load adjacency.json: ${err.message}`);
            this._nodeAdjacency = new Map();
            return this._nodeAdjacency;
        }
    }

    // Ensemble analysis JSON (boundary frequencies, facility freq, capacity stats)
    async loadEnsemble() {
        if (this._ensembleCache !== null) return this._ensembleCache;
        try {
            const response = await fetch(this._url("ensemble.json"));
            if (!response.ok) {
                this._ensembleCache = null;
                return null;
            }
            const data = await response.json();
            this._ensembleCache = data;
            this.logger.log(`Ensemble loaded: ${Object.keys(data.boundary_frequencies || {}).length} boundary edges`, "success");
            return data;
        } catch (err) {
            this.logger.warn(`Failed to load ensemble.json: ${err.message}`);
            this._ensembleCache = null;
            return null;
        }
    }

    async loadSubsteps(stepNum) {
        // Legacy alias — redirects to loadPhases
        return this.loadPhases(stepNum);
    }

    /**
     * Build nodes and links arrays from substep data for tree rendering.
     * Resolves node IDs to coordinates from manifest or centroidMaps.
     * Computes has_facility and compl_facility by traversing from the cut node.
     */
    buildTreeFromSubstep(substep, state) {
        const baseCoords = state.manifest?.node_coordinates || {};
        const candidates = state.manifest?.node_candidates || {};
        const centroidMaps = state.centroidMaps;

        // For supergraph-level tree cuts, use supergraph centroid coordinates
        const sgCoords = state.currentFrame?.data?.supergraph_coords
            || state.supergraphCoords || {};
        // Merge: supergraph coords take priority for district ID keys
        const coords = { ...baseCoords, ...sgCoords };

        const nodes = new Map();
        const links = [];
        const nodeFeas = substep.node_feasibility || {};

        // Build adjacency for BFS traversal
        const adj = new Map();

        for (const [uId, vId] of substep.edges) {
            // Resolve coordinates
            for (const nId of [uId, vId]) {
                if (!nodes.has(nId)) {
                    const c = coords[nId] || centroidMaps?.byFeatId?.get(nId);
                    const feas = nodeFeas[nId] || {};
                    if (c) {
                        nodes.set(nId, {
                            id: nId,
                            x: c[0],
                            y: c[1],
                            is_candidate: !!candidates[nId],
                            has_facility: feas.has_facility ?? false,
                            compl_facility: feas.compl_facility ?? false,
                            demand_ok: feas.demand_ok ?? false,
                            compl_demand_ok: feas.compl_demand_ok ?? false,
                            demand: feas.demand ?? null,
                        });
                    }
                }
            }
            if (nodes.has(uId) && nodes.has(vId)) {
                links.push({ source: uId, target: vId });
                if (!adj.has(uId)) adj.set(uId, []);
                if (!adj.has(vId)) adj.set(vId, []);
                adj.get(uId).push(vId);
                adj.get(vId).push(uId);
            }
        }

        const rootId = String(substep.root);
        const cutNodeId = String(substep.cut_node);

        // BFS from cut node to find the "cut side" subtree
        // (all nodes reachable from cutNode without crossing the cut edge to parent)
        const cutSide = new Set();
        if (nodes.has(cutNodeId) && cutNodeId !== rootId) {
            // Find cut node's parent in the rooted tree via BFS from root
            const parent = new Map();
            const visited = new Set([rootId]);
            const queue = [rootId];
            while (queue.length > 0) {
                const curr = queue.shift();
                for (const neighbor of (adj.get(curr) || [])) {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        parent.set(neighbor, curr);
                        queue.push(neighbor);
                    }
                }
            }

            // BFS from cutNode, excluding the edge to its parent
            const cutParent = parent.get(cutNodeId);
            const cutQueue = [cutNodeId];
            cutSide.add(cutNodeId);
            while (cutQueue.length > 0) {
                const curr = cutQueue.shift();
                for (const neighbor of (adj.get(curr) || [])) {
                    if (!cutSide.has(neighbor) && !(curr === cutNodeId && neighbor === cutParent)) {
                        cutSide.add(neighbor);
                        cutQueue.push(neighbor);
                    }
                }
            }
        } else if (cutNodeId === rootId) {
            // Root cut = take everything
            for (const nId of nodes.keys()) cutSide.add(nId);
        }

        const complementSide = new Set();
        for (const nId of nodes.keys()) {
            if (!cutSide.has(nId)) complementSide.add(nId);
        }

        // Compute has_facility / compl_facility
        const cutHasFacility = [...cutSide].some(nId => candidates[nId]);
        const complHasFacility = [...complementSide].some(nId => candidates[nId]);

        for (const [nId, node] of nodes) {
            if (cutSide.has(nId)) {
                node.has_facility = cutHasFacility;
                node.compl_facility = complHasFacility;
                node.side = "cut";
            } else {
                node.has_facility = complHasFacility;
                node.compl_facility = cutHasFacility;
                node.side = "complement";
            }
        }

        return {
            nodes: Array.from(nodes.values()),
            links,
            nodesById: Object.fromEntries(nodes),
            rootId,
            cutNodeId,
            cutSideNodes: cutSide,
            metadata: {
                psi_chosen: substep.psi_chosen,
                psi_total: substep.psi_total,
                n_cuts: substep.n_cuts,
                cut_side_size: cutSide.size,
                complement_size: complementSide.size,
                cut_has_facility: cutHasFacility,
                compl_has_facility: complHasFacility,
            },
        };
    }

    // ----------------------------------------------------------------
    // Legacy methods (kept for backward compatibility with old format)
    // ----------------------------------------------------------------
    async loadTree(iteration, centroidMaps, treePath = null) {
        const url = treePath
            ? `${treePath}/tree_${iteration}.json`
            : this._url(`trees/tree_${iteration}.json`);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (!data.nodes || !data.links) throw new Error("Invalid tree JSON");

            const metadata = data.metadata || null;
            const rootId = metadata?.root != null ? String(metadata.root) : null;

            const nodes = [];
            for (const n of data.nodes) {
                const idStr = String(n.id);
                let c = centroidMaps.byFeatId.get(idStr);
                if (!c && n.x != null && n.y != null) c = [n.x, n.y];
                if (!c) continue;
                nodes.push({ id: idStr, x: +c[0], y: +c[1], ...n });
            }

            const nodesById = Object.fromEntries(nodes.map(n => [n.id, n]));
            const links = data.links
                .map(e => ({ source: String(e.source), target: String(e.target) }))
                .filter(e => nodesById[e.source] && nodesById[e.target]);

            return { nodes, links, nodesById, metadata, rootId };
        } catch (err) {
            return null;
        }
    }

    async loadDistrict(iteration, districtPath = null) {
        const url = districtPath
            ? `${districtPath}/district_${iteration}.json`
            : this._url(`districts/district_${iteration}.json`);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            if (!data.district) throw new Error("Invalid district JSON");
            const nodes = data.district.map(id => String(id));
            const metadata = data.metadata || {};
            const color = this.generateDistrictColor(iteration);
            return { nodes, metadata, color };
        } catch (err) {
            return null;
        }
    }

    // ----------------------------------------------------------------
    // Utilities
    // ----------------------------------------------------------------
    _stableColorIndex(districtId) {
        // Parse district ID to integer if possible, otherwise hash the string
        const num = parseInt(districtId, 10);
        if (!isNaN(num) && num > 0) {
            return num;
        }
        // Simple string hash for non-numeric IDs
        let hash = 0;
        for (let i = 0; i < districtId.length; i++) {
            hash = ((hash << 5) - hash + districtId.charCodeAt(i)) | 0;
        }
        return Math.abs(hash % 20) + 1;
    }

    generateDistrictColor(index) {
        // Fixed palette of maximally distinct colors for up to 20 districts.
        // Falls back to golden-angle HSL for more.
        // Ordered so that consecutive indices have maximum visual distance
        const palette = [
            "#e6194b", "#3cb44b", "#f58231", "#4363d8", "#f032e6",
            "#42d4f4", "#911eb4", "#bfef45", "#9A6324", "#fabed4",
            "#469990", "#ffe119", "#800000", "#aaffc3", "#dcbeff",
            "#808000", "#000075", "#ffd8b1", "#a9a9a9", "#e6beff",
        ];
        if (index > 0 && index <= palette.length) {
            return palette[index - 1];
        }
        const hue = (index * 137.508) % 360;
        const saturation = 70;
        const lightness = 50;
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }

    computeDistrictBoundaries(state) {
        this.logger.log("Computing district boundaries...");
        const districtBoundaries = new Map();
        const districtBoundaryColors = new Map();

        const districtToBlocks = new Map();
        for (const [blockId, districtId] of state.blockIdToDistrictId.entries()) {
            if (!districtToBlocks.has(districtId)) {
                districtToBlocks.set(districtId, []);
            }
            districtToBlocks.get(districtId).push(blockId);
        }

        for (const [districtId, blockIds] of districtToBlocks.entries()) {
            try {
                const features = [];
                for (const blockId of blockIds) {
                    const geom = state.blockIdToGeometry.get(blockId);
                    if (!geom) continue;
                    features.push({ type: "Feature", geometry: geom, properties: {} });
                }
                if (features.length === 0) continue;

                let union = features[0];
                for (let i = 1; i < features.length; i++) {
                    try { union = turf.union(union, features[i]); } catch (e) { /* skip */ }
                }

                if (union?.geometry) {
                    const boundaryPath = new Path2D();
                    const coords = union.geometry.coordinates;
                    if (union.geometry.type === "Polygon") {
                        this.addToPath(boundaryPath, coords, state.detectedSwap);
                    } else if (union.geometry.type === "MultiPolygon") {
                        for (const poly of coords) {
                            this.addToPath(boundaryPath, poly, state.detectedSwap);
                        }
                    }
                    districtBoundaries.set(districtId, boundaryPath);
                    const firstColor = state.districtBlockColors.get(blockIds[0]);
                    if (firstColor) districtBoundaryColors.set(districtId, firstColor);
                }
            } catch (err) { /* skip district */ }
        }

        this.logger.log(`Computed ${districtBoundaries.size} district boundaries`);
        return { districtBoundaries, districtBoundaryColors };
    }

    addToPath(path, coords, swap) {
        for (const ring of coords) {
            if (!ring?.length) continue;
            const first = swap ? [ring[0][1], ring[0][0]] : ring[0];
            path.moveTo(first[0], first[1]);
            for (let i = 1; i < ring.length; i++) {
                const pt = swap ? [ring[i][1], ring[i][0]] : ring[i];
                path.lineTo(pt[0], pt[1]);
            }
            path.closePath();
        }
    }
}
