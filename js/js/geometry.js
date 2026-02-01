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
}

// Make it globally available as a workaround
if (typeof window !== 'undefined') {
    window.GeometryUtils = GeometryUtils;
}