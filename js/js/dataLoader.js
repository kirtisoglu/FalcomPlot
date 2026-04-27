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
    constructor(logger) {
        this.logger = logger;
    }

    // ----------------------------------------------------------------
    // Blocks (unchanged — works with both old and new format)
    // ----------------------------------------------------------------
    async loadBlocks(blocksPaths, centroidMaps, blockIdToFeature, blockIdToGeometry, blockIdToBounds) {
        try {
            this.logger.updateStatus("Loading blocks.json...", "info");
            const response = await fetch("data/blocks.json");

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
            const response = await fetch("data/manifest.json");
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
        const padded = String(stepNum).padStart(4, "0");
        try {
            const response = await fetch(`data/step_${padded}.json`);
            if (!response.ok) {
                if (response.status === 404) {
                    this.logger.log(`Step ${stepNum} not found`, "info");
                    return null;
                }
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            this.logger.log(`Step ${stepNum}: energy=${data.energy?.toFixed(1)}, accepted=${data.accepted}`, "info");
            return data;
        } catch (err) {
            this.logger.warn(`Failed to load step_${padded}.json: ${err.message}`);
            return null;
        }
    }

    // ----------------------------------------------------------------
    // Apply a step's assignment to the state
    // ----------------------------------------------------------------
    applyStepToState(stepData, state) {
        // Clear previous coloring
        state.districtBlockColors.clear();
        state.blockIdToDistrictId.clear();
        state.nodeColorOverrides.clear();

        // Build node -> district mapping
        const nodeToDist = new Map();
        for (const [nodeId, districtId] of Object.entries(stepData.assignment)) {
            nodeToDist.set(nodeId, String(districtId));
        }

        // Build district adjacency graph
        const districtNeighbors = this._buildDistrictAdjacency(nodeToDist, state);

        // Graph-color districts so adjacent ones get maximally different colors
        const districtColors = this._graphColorDistricts(districtNeighbors);

        // Apply colors
        for (const [nodeId, districtId] of Object.entries(stepData.assignment)) {
            const did = String(districtId);
            const color = districtColors.get(did);
            state.districtBlockColors.set(nodeId, color);
            state.blockIdToDistrictId.set(nodeId, did);
            state.nodeColorOverrides.set(nodeId, color);
        }

        // Store step metadata
        state.stepData = stepData;

        return districtColors.size;
    }

    /**
     * Build a district adjacency map: district -> Set of neighboring district IDs.
     * Two districts are adjacent if any of their nodes are graph-neighbors.
     */
    _buildDistrictAdjacency(nodeToDist, state) {
        const neighbors = new Map();
        for (const did of new Set(nodeToDist.values())) {
            neighbors.set(did, new Set());
        }

        // Try to use manifest node_coordinates to infer grid adjacency
        const coords = state.manifest?.node_coordinates;
        if (coords) {
            // Build a lookup from coordinate string to node ID
            const coordToNode = new Map();
            for (const [nid, c] of Object.entries(coords)) {
                coordToNode.set(`${c[0]},${c[1]}`, nid);
            }

            // For each node, check 4-connected grid neighbors
            for (const [nid, did] of nodeToDist) {
                const c = coords[nid];
                if (!c) continue;
                const [x, y] = c;
                const deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                for (const [dx, dy] of deltas) {
                    const neighborKey = `${x + dx},${y + dy}`;
                    const neighborNode = coordToNode.get(neighborKey);
                    if (neighborNode) {
                        const neighborDist = nodeToDist.get(neighborNode);
                        if (neighborDist && neighborDist !== did) {
                            neighbors.get(did).add(neighborDist);
                            neighbors.get(neighborDist).add(did);
                        }
                    }
                }
            }
        } else {
            // Fallback: use block geometry bounding boxes to estimate adjacency
            for (const [nid1, did1] of nodeToDist) {
                const b1 = state.blockIdToBounds?.get(nid1);
                if (!b1) continue;
                for (const [nid2, did2] of nodeToDist) {
                    if (did1 === did2 || nid1 >= nid2) continue;
                    const b2 = state.blockIdToBounds?.get(nid2);
                    if (!b2) continue;
                    // Check if bounding boxes touch (share an edge)
                    const touches = !(b1[2] < b2[0] || b2[2] < b1[0] || b1[3] < b2[1] || b2[3] < b1[1]);
                    if (touches) {
                        neighbors.get(did1).add(did2);
                        neighbors.get(did2).add(did1);
                    }
                }
            }
        }

        return neighbors;
    }

    /**
     * Assign unique, maximally-spaced colors to districts.
     * Adjacent districts are guaranteed to get different colors,
     * and every district gets its own unique color.
     */
    _graphColorDistricts(districtNeighbors) {
        const palette = [
            "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
            "#42d4f4", "#f032e6", "#bfef45", "#469990", "#ffe119",
            "#9A6324", "#dcbeff", "#800000", "#aaffc3", "#000075",
            "#808000", "#ffd8b1", "#fabed4", "#a9a9a9", "#e6beff",
        ];

        // Sort districts by number of neighbors (most constrained first)
        const districts = [...districtNeighbors.keys()].sort(
            (a, b) => districtNeighbors.get(b).size - districtNeighbors.get(a).size
        );

        const colorAssignment = new Map(); // district -> palette index
        const usedIndices = new Set();      // globally used palette indices

        for (const did of districts) {
            // Find colors used by neighbors
            const neighborColors = new Set();
            for (const neighbor of districtNeighbors.get(did)) {
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
            // Fallback: if palette exhausted, at least avoid neighbors
            if (chosen === -1) {
                for (let i = 0; i < palette.length; i++) {
                    if (!neighborColors.has(i)) {
                        chosen = i;
                        break;
                    }
                }
            }
            if (chosen === -1) chosen = 0;

            colorAssignment.set(did, chosen);
            usedIndices.add(chosen);
        }

        // Convert to color strings
        const result = new Map();
        for (const [did, idx] of colorAssignment) {
            result.set(did, palette[idx % palette.length]);
        }
        return result;
    }

    // ----------------------------------------------------------------
    // Phases (four-phase animation data)
    // ----------------------------------------------------------------
    async loadPhases(stepNum) {
        const padded = String(stepNum).padStart(4, "0");
        try {
            const response = await fetch(`data/phases/phases_${padded}.json`);
            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            this.logger.log(`Phases for step ${stepNum}: ${data.length} phases`, "info");
            return data;
        } catch (err) {
            this.logger.warn(`Failed to load phases for step ${stepNum}: ${err.message}`);
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
    async loadTree(iteration, centroidMaps, treePath = 'data/trees') {
        try {
            const response = await fetch(`${treePath}/tree_${iteration}.json`);
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

    async loadDistrict(iteration, districtPath = 'data/districts') {
        try {
            const response = await fetch(`${districtPath}/district_${iteration}.json`);
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
