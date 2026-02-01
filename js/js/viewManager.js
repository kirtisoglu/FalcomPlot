// View management
export class ViewManager {
    constructor(canvas, config) {
        this.canvas = canvas;
        this.config = config;
    }

    autoCenterAndScale(state) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        // PRIORITY 1: Use blocks bounds (these should ALWAYS exist as global background)
        if (state.blocksBounds) {
            minX = state.blocksBounds.minx;
            minY = state.blocksBounds.miny;
            maxX = state.blocksBounds.maxx;
            maxY = state.blocksBounds.maxy;
            console.log(`Using blocks bounds: [${minX}, ${minY}, ${maxX}, ${maxY}]`);
        }

        // PRIORITY 2: Expand bounds to include nodes if they exist
        if (state.nodes && state.nodes.length) {
            for (const n of state.nodes) {
                if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
                    minX = Math.min(minX, n.x);
                    minY = Math.min(minY, n.y);
                    maxX = Math.max(maxX, n.x);
                    maxY = Math.max(maxY, n.y);
                }
            }
            console.log(`Expanded for nodes: [${minX}, ${minY}, ${maxX}, ${maxY}]`);
        }

        console.log(`AutoCenter: Final Bounds [${minX}, ${minY}, ${maxX}, ${maxY}]`);

        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
            console.warn("AutoCenter: Invalid bounds");
            return false;
        }

        if (!(minX < maxX && minY < maxY)) {
            console.warn("AutoCenter: Empty bounds range");
            return false;
        }

        const padding = this.config.framePadding;
        const width = Math.max(1e-9, maxX - minX);
        const height = Math.max(1e-9, maxY - minY);
        const scaleX = (this.canvas.width - 2 * padding) / width;
        const scaleY = (this.canvas.height - 2 * padding) / height;
        const scale = Math.min(scaleX, scaleY);

        state.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        state.transform.k = scale;
        state.transform.x = padding + (this.canvas.width - scale * (minX + maxX)) / 2;
        state.transform.y = padding + (this.canvas.height - scale * (minY + maxY)) / 2;
        state.transform.angle = 0;
        state.initialTransform = { ...state.transform };

        console.log(`AutoCenter: Transform k=${scale}, x=${state.transform.x}, y=${state.transform.y}`);
        return true;
    }

    getMousePos(evt, state) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = evt.clientX - rect.left;
        const canvasY = evt.clientY - rect.top;

        const x = (canvasX - state.transform.x) / state.transform.k;
        const y = (canvasY - state.transform.y) / state.transform.k;
        const dx = x - state.center.x, dy = y - state.center.y;
        const cos = Math.cos(-state.transform.angle), sin = Math.sin(-state.transform.angle);
        let rx = dx * cos - dy * sin + state.center.x;
        let ry = dx * sin + dy * cos + state.center.y;
        if (state.flipX) rx = 2 * state.center.x - rx;
        return { x: rx, y: ry };
    }
}