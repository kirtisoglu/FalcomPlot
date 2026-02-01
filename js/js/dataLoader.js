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

    async loadBlocks(blocksPaths, centroidMaps, blockIdToFeature, blockIdToGeometry, blockIdToBounds) {
        try {
            this.logger.updateStatus("Loading blocks.geojson...", "info");
            const response = await fetch("data/blocks.json");

            if (!response.ok) {
                throw new Error(`Failed to fetch blocks.json: ${response.status} ${response.statusText} `);
            }

            const data = await response.json();
            const gj = data;

            if (!gj.features || !Array.isArray(gj.features)) {
                throw new Error("Invalid GeoJSON: missing features array");
            }

            // Detect coordinate swap
            const f0 = gj.features[0];
            let sample;
            if (f0?.geometry?.type === "Polygon") {
                sample = f0.geometry.coordinates?.[0]?.[0];
            } else if (f0?.geometry?.type === "MultiPolygon") {
                sample = f0.geometry.coordinates?.[0]?.[0]?.[0];
            }
            const detectedSwap = GeometryUtils.detectSwap(sample);
            this.logger.log(`Coordinate order: ${detectedSwap ? "LAT,LON (swapping)" : "LON,LAT"}`);
            this.logger.log(`Sample coord for swap detection: ${JSON.stringify(sample)}`);

            // DEBUG: Log feature count
            this.logger.log(`Processing ${gj.features.length} features...`);
            let polygonCount = 0, multiPolygonCount = 0, noGeomCount = 0;

            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;

            // DEBUG: Log first few coordinates as ACTUALLY TRANSFORMED
            let coordsLogged = 0;

            for (const f of gj.features) {
                const g = f.geometry;
                if (!g) {
                    noGeomCount++;
                    continue;
                }

                // Calculate bounds for this specific block
                let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;

                const updateBounds = (ring) => {
                    for (const pt of ring) {
                        const x = detectedSwap ? pt[1] : pt[0];
                        const y = detectedSwap ? pt[0] : pt[1];

                        // Log first few transformed coords
                        if (coordsLogged < 3) {
                            this.logger.log(`Coord ${coordsLogged}: raw=${JSON.stringify(pt)}, x=${x}, y=${y}`);
                            coordsLogged++;
                        }

                        if (x < minx) minx = x;
                        if (y < miny) miny = y;
                        if (x > maxx) maxx = x;
                        if (y > maxy) maxy = y;

                        // Block bounds
                        if (x < bMinX) bMinX = x;
                        if (y < bMinY) bMinY = y;
                        if (x > bMaxX) bMaxX = x;
                        if (y > bMaxY) bMaxY = y;
                    }
                };

                if (g.type === "Polygon") {
                    polygonCount++;
                    GeometryUtils.addPolygonPath(g.coordinates, detectedSwap, blocksPaths);
                    for (const ring of g.coordinates) updateBounds(ring);
                } else if (g.type === "MultiPolygon") {
                    multiPolygonCount++;
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

            // CALCULATED bounds from JavaScript loop
            const calculatedBounds = (minx < maxx && miny < maxy) ? { minx, miny, maxx, maxy } : null;

            // CORRECT bounds from Python file analysis  
            const correctBounds = {
                minx: -87.743510,
                miny: 41.730383,
                maxx: -87.528879,
                maxy: 41.921598
            };

            this.logger.log(`Geometry types: ${polygonCount} Polygon, ${multiPolygonCount} MultiPolygon, ${noGeomCount} no geometry`);
            this.logger.log(`addPolygonPath was called ${GeometryUtils.pathCallCount} times`);
            this.logger.log(`CALCULATED BOUNDS: minx=${minx}, miny=${miny}, maxx=${maxx}, maxy=${maxy}`);
            this.logger.log(`FORCING CORRECT BOUNDS from file analysis`, "warn");
            this.logger.log(`Blocks loaded: ${blocksPaths.length} polygons, ${centroidMaps.byFeatId.size} centroids`, "success");

            // Use correct bounds instead of calculated
            return { blocksBounds: correctBounds, detectedSwap };
        } catch (err) {
            this.logger.warn(`Failed to load blocks.geojson: ${err.message} `);
            throw err;
        }
    }

    async loadTree(iteration, centroidMaps, treePath = 'data/trees') {
        try {
            this.logger.log(`Loading tree_${iteration}.json from ${treePath}...`);
            const response = await fetch(`${treePath}/tree_${iteration}.json`);
            if (!response.ok) {
                if (response.status === 404) {
                    this.logger.log(`Tree iteration ${iteration} not found`, "info");
                    return null;
                }
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (!data.nodes || !Array.isArray(data.nodes) || !data.links || !Array.isArray(data.links)) {
                throw new Error("Invalid tree JSON structure");
            }

            const metadata = data.metadata || null;
            const rootId = metadata?.root != null ? String(metadata.root) : null;

            const nodes = [];
            const missing = [];
            for (const n of data.nodes) {
                const idStr = String(n.id);
                const gid20 = n.GEOID20 ? String(n.GEOID20) : null;
                const gid = n.GEOID ? String(n.GEOID) : null;

                let c = null;
                if (gid20) c = centroidMaps.byGeoID20.get(gid20);
                if (!c && gid) c = centroidMaps.byGeoID.get(gid);
                if (!c) c = centroidMaps.byFeatId.get(idStr);
                if (!c && n.x != null && n.y != null) c = [n.x, n.y];

                if (!c) {
                    missing.push(idStr);
                    continue;
                }

                nodes.push({
                    id: idStr,
                    x: +c[0], // Use the determined centroid value
                    y: +c[1],
                    has_facility: n.has_facility ?? false,
                    compl_facility: n.compl_facility ?? false,
                    population: n.population ?? null,
                    candidate: n.candidate ?? false,
                });
            }

            if (missing.length > 0) {
                this.logger.warn(`${missing.length} nodes missing centroids`);
            }

            const nodesById = Object.fromEntries(nodes.map(n => [n.id, n]));
            const links = [];
            let unresolvedLinks = 0;
            for (const e of data.links) {
                const src = String(e.source), tgt = String(e.target);
                if (nodesById[src] && nodesById[tgt]) {
                    links.push({ source: src, target: tgt });
                } else {
                    unresolvedLinks++;
                }
            }

            this.logger.log(`Tree: ${nodes.length} nodes, ${links.length} links`, "success");
            return { nodes, links, nodesById, metadata, rootId };
        } catch (err) {
            this.logger.warn(`Failed to load tree_${iteration}.json: ${err.message}`);
            return null;
        }
    }

    async loadDistrict(iteration, districtPath = 'data/districts') {
        try {
            this.logger.log(`Loading district_${iteration}.json from ${districtPath}...`);
            const response = await fetch(`${districtPath}/district_${iteration}.json`);
            if (!response.ok) {
                if (response.status === 404) {
                    this.logger.log(`District iteration ${iteration} not found`, "info");
                    return null;
                }
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (!data.district || !Array.isArray(data.district)) {
                throw new Error("Invalid district JSON structure");
            }

            const nodes = data.district.map(id => String(id));
            const metadata = data.metadata || {};
            const color = this.generateDistrictColor(iteration);

            this.logger.log(`District: ${nodes.length} nodes`, "success");
            return { nodes, metadata, color };
        } catch (err) {
            this.logger.warn(`Failed to load district_${iteration}.json: ${err.message}`);
            return null;
        }
    }

    /**
     * Compute district boundaries as Path2D objects using Turf.js union
     * Creates clean outer boundaries for each district
     */
    computeDistrictBoundaries(state) {
        this.logger.log("Computing district boundaries with Turf.js union...");

        const districtBoundaries = new Map();
        const districtBoundaryColors = new Map();

        // Group blocks by district
        const districtToBlocks = new Map();
        for (const [blockId, districtId] of state.blockIdToDistrictId.entries()) {
            if (!districtToBlocks.has(districtId)) {
                districtToBlocks.set(districtId, []);
            }
            districtToBlocks.get(districtId).push(blockId);
        }

        this.logger.log(`Processing ${districtToBlocks.size} districts for boundary union...`);

        // For each district, create a union of all block geometries
        for (const [districtId, blockIds] of districtToBlocks.entries()) {
            try {
                // Collect all block features as GeoJSON
                const features = [];
                for (const blockId of blockIds) {
                    const geom = state.blockIdToGeometry.get(blockId);
                    if (!geom) continue;

                    // Create GeoJSON feature (already in correct coordinate order)
                    features.push({
                        type: "Feature",
                        geometry: geom,
                        properties: {}
                    });
                }

                if (features.length === 0) continue;

                // Use Turf.js to union all features into one polygon
                let union = features[0];
                for (let i = 1; i < features.length; i++) {
                    try {
                        union = turf.union(union, features[i]);
                    } catch (err) {
                        console.warn(`Failed to union block in district ${districtId}:`, err);
                    }
                }

                // Convert the union result to Path2D
                if (union && union.geometry) {
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

                    // Get color from first block in district
                    const firstBlockId = blockIds[0];
                    const color = state.districtBlockColors.get(firstBlockId);
                    if (color) {
                        districtBoundaryColors.set(districtId, color);
                    }
                }
            } catch (err) {
                console.error(`Error processing district ${districtId}:`, err);
            }
        }

        this.logger.log(`Computed ${districtBoundaries.size} clean district boundaries via union`);
        return { districtBoundaries, districtBoundaryColors };
    }

    /**
     * Helper to add polygon coordinates to a Path2D
     */
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

    generateDistrictColor(iteration) {
        // Use golden angle approximation (137.508 degrees) to distribute hues evenly
        const hue = (iteration * 137.508) % 360;
        // Vary saturation and lightness slightly to add more distinction
        const saturation = 60 + (iteration % 5) * 10; // 60-100%
        const lightness = 45 + (iteration % 3) * 10;  // 45-65%
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }
}