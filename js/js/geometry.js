// Geometry utilities
export class GeometryUtils {
    static addPolygonPath(coords, swap, blocksPaths) {
        const path = new Path2D();
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
        blocksPaths.push(path);
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

    /**
     * Build an index of polygon-boundary segments shared by exactly two
     * blocks. Used to draw hierarchy boundaries (e.g. thick
     * super-district outlines) along the TRUE shared borders instead of
     * approximating with centroid lines or full block outlines.
     *
     * Requires the block polygons to share vertices along common
     * borders (exact on synthetic grids; needs topology-preserving
     * simplification, e.g. shapely's coverage_simplify, on real maps).
     *
     * @param blockIdToGeometry Map<blockId, GeoJSON geometry>
     * @param swap whether loadBlocks detected a lat/lon swap
     * @returns Array<{ax, ay, bx, by, blockA, blockB}>
     */
    static buildSharedSegmentIndex(blockIdToGeometry, swap = false) {
        const owners = new Map(); // segKey -> {coords, ids}
        const q = (v) => Math.round(v * 1e6);

        const addRing = (ring, id) => {
            if (!ring || ring.length < 2) return;
            for (let i = 0; i < ring.length - 1; i++) {
                const [ax, ay] = swap ? [ring[i][1], ring[i][0]] : ring[i];
                const [bx, by] = swap ? [ring[i + 1][1], ring[i + 1][0]] : ring[i + 1];
                const a = [q(ax), q(ay)], b = [q(bx), q(by)];
                // Order-normalize so both owners produce the same key.
                const flip = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
                const key = flip
                    ? `${b[0]},${b[1]}|${a[0]},${a[1]}`
                    : `${a[0]},${a[1]}|${b[0]},${b[1]}`;
                let entry = owners.get(key);
                if (!entry) {
                    entry = { ax, ay, bx, by, ids: [] };
                    owners.set(key, entry);
                }
                if (!entry.ids.includes(id)) entry.ids.push(id);
            }
        };

        for (const [id, geom] of blockIdToGeometry) {
            if (!geom) continue;
            if (geom.type === "Polygon") {
                for (const ring of geom.coordinates) addRing(ring, id);
            } else if (geom.type === "MultiPolygon") {
                for (const poly of geom.coordinates) {
                    for (const ring of poly) addRing(ring, id);
                }
            }
        }

        const shared = [];
        for (const e of owners.values()) {
            if (e.ids.length === 2) {
                shared.push({
                    ax: e.ax, ay: e.ay, bx: e.bx, by: e.by,
                    blockA: e.ids[0], blockB: e.ids[1],
                });
            }
        }
        return shared;
    }
}

// Make it globally available as a workaround
if (typeof window !== 'undefined') {
    window.GeometryUtils = GeometryUtils;
}