// Canvas rendering
export class Renderer {
    constructor(canvas, config, visual) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.config = config;
        this.visual = visual;
    }

    drawStarPath(x, y, rOuter = 3, spikes = 5, inset = 0.5) {
        const rot = Math.PI / 2 * 3;
        let step = Math.PI / spikes;
        this.ctx.beginPath();
        this.ctx.moveTo(x, y - rOuter);
        let rotA = rot;
        for (let i = 0; i < spikes; i++) {
            this.ctx.lineTo(x + Math.cos(rotA) * rOuter, y + Math.sin(rotA) * rOuter);
            rotA += step;
            this.ctx.lineTo(x + Math.cos(rotA) * (rOuter * inset), y + Math.sin(rotA) * (rOuter * inset));
            rotA += step;
        }
        this.ctx.closePath();
    }

    draw(state, isWithinTolerance) {
        const ctx = this.ctx;
        ctx.save();
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        ctx.translate(state.transform.x, state.transform.y);
        ctx.scale(state.transform.k, state.transform.k);
        ctx.translate(state.center.x, state.center.y);
        ctx.rotate(state.transform.angle);
        if (state.flipX) ctx.scale(-1, 1);
        ctx.translate(-state.center.x, -state.center.y);

        // In District Mode with Uncolored, we need to track which blocks belong to districts
        let districtBlockIds = new Set();
        if (state.viewMode === 'district' && state.districtColoring === 'uncolored') {
            for (const [blockId, _] of state.districtBlockColors.entries()) {
                districtBlockIds.add(blockId);
            }
        }

        // ==========================================
        // BLOCKS: ALWAYS VISIBLE AS GLOBAL STATIC BACKGROUND
        // Independent of all modes and controls
        // ==========================================
        if (state.blocksPaths.length > 0) {
            ctx.fillStyle = this.config.colors.blockFill;
            ctx.strokeStyle = this.config.colors.blockStroke;
            ctx.lineWidth = this.visual.blockLineWidth / state.transform.k;

            // Draw ALL blocks as static background (global mode)
            for (const p of state.blocksPaths) {
                ctx.fill(p);
                ctx.stroke(p);
            }
        }

        // Districts visualization (if in district mode)
        if (state.viewMode === 'district' && state.districtBlockColors.size > 0) {
            if (state.districtColoring === 'colored') {
                // COLORED MODE: Show individual blocks with their district colors
                for (const [blockId, color] of state.districtBlockColors.entries()) {
                    const geom = state.blockIdToGeometry.get(blockId);
                    if (!geom) continue;

                    const blockDistrictId = state.blockIdToDistrictId.get(blockId);

                    // Determine if this block should be highlighted
                    const isDistrictHighlighted = state.highlightDistrictId === blockDistrictId;

                    // Apply semi-transparency if something else is highlighted
                    const isSomethingHighlighted = state.highlightDistrictId;
                    const opacity = (isSomethingHighlighted && !isDistrictHighlighted) ? 0.3 : 1.0;

                    // Adjust color and stroke for highlighting
                    let drawColor = color;
                    let strokeColor = "rgba(0, 0, 0, 0.3)";
                    let lineWidth = 1 / state.transform.k;

                    if (isDistrictHighlighted) {
                        drawColor = this.lightenColor(color, 20);
                        strokeColor = "#ffffff";
                        lineWidth = 3 / state.transform.k;
                    }

                    // Apply opacity
                    ctx.globalAlpha = opacity;

                    if (geom.type === "Polygon") {
                        this.drawGeometry(ctx, geom.coordinates, drawColor, strokeColor, lineWidth, state.detectedSwap);
                    } else if (geom.type === "MultiPolygon") {
                        for (const poly of geom.coordinates) {
                            this.drawGeometry(ctx, poly, drawColor, strokeColor, lineWidth, state.detectedSwap);
                        }
                    }

                    // Reset opacity
                    ctx.globalAlpha = 1.0;
                }
            } else {
                // UNCOLORED MODE: Draw district boundaries with high opacity
                // Use precomputed boundaries from state
                console.log("[RENDERER] Uncolored mode - boundaries size:", state.districtBoundaries?.size || 0);
                console.log("[RENDERER] Boundary colors size:", state.districtBoundaryColors?.size || 0);

                if (state.districtBoundaries && state.districtBoundaries.size > 0) {
                    console.log("[RENDERER] Drawing", state.districtBoundaries.size, "district boundaries");
                    for (const [districtId, boundaryPath] of state.districtBoundaries.entries()) {
                        const color = state.districtBoundaryColors.get(districtId);
                        console.log(`[RENDERER] District ${districtId}: color=${color}`);
                        if (!color) continue;

                        // Determine if this district is highlighted
                        const isHighlighted = state.highlightDistrictId === districtId;

                        // High opacity for visibility (0.85 instead of previous lower values)
                        ctx.globalAlpha = isHighlighted ? 1.0 : 0.85;

                        // Fill with district color
                        ctx.fillStyle = isHighlighted ? this.lightenColor(color, 20) : color;
                        ctx.fill(boundaryPath);

                        // Bold stroke for boundaries
                        ctx.strokeStyle = isHighlighted ? "#ffffff" : "rgba(0, 0, 0, 0.6)";
                        ctx.lineWidth = isHighlighted ? 4 / state.transform.k : 3 / state.transform.k;
                        ctx.stroke(boundaryPath);
                    }
                    ctx.globalAlpha = 1.0;
                } else {
                    console.log("[RENDERER] No district boundaries to draw!");
                }
            }
        }

        // Tree visualization (if in tree mode)
        // In tree mode, NO district blocks should be shown - only base map and tree
        if (state.viewMode === 'tree') {
            // Links
            if (state.links.length > 0) {
                const isSomethingHighlighted = state.highlightNodeId;
                ctx.globalAlpha = isSomethingHighlighted ? 0.3 : 1.0;

                ctx.strokeStyle = this.config.colors.linkStroke;
                ctx.lineWidth = this.visual.linkLineWidth / state.transform.k;
                ctx.beginPath();
                for (const e of state.links) {
                    const s = state.nodesById[e.source], t = state.nodesById[e.target];
                    if (!s || !t) continue;
                    ctx.moveTo(s.x, s.y);
                    ctx.lineTo(t.x, t.y);
                }
                ctx.stroke();

                ctx.globalAlpha = 1.0;
            }

            // Nodes
            if (state.nodes.length > 0) {
                const now = Date.now();
                const isHighlighting = state.highlightNodeId && now < state.highlightUntil;
                const flashPhase = isHighlighting ? Math.sin((now / 100) * Math.PI * 2) : 0;
                const isSomethingHighlighted = state.highlightNodeId;

                for (const n of state.nodes) {
                    const isRoot = n.id === state.rootId;
                    const isHighlighted = isHighlighting && n.id === state.highlightNodeId;

                    const opacity = (isSomethingHighlighted && !isHighlighted) ? 0.3 : 1.0;
                    ctx.globalAlpha = opacity;

                    let color = null;
                    if (state.nodeColorOverrides.has(n.id)) {
                        color = state.nodeColorOverrides.get(n.id);
                    } else if (isRoot) {
                        color = this.config.colors.rootFill;
                    } else {
                        color = isWithinTolerance(n) ? this.config.colors.greenFill : this.config.colors.redFill;
                    }

                    if (isRoot) {
                        const R = this.config.rootOuterPx / state.transform.k;
                        this.drawStarPath(n.x, n.y, R, 5, this.config.rootInset);
                        ctx.fillStyle = color;
                        ctx.fill();
                        ctx.strokeStyle = this.config.colors.rootStroke;
                        ctx.lineWidth = this.visual.rootLineWidth / state.transform.k;
                        ctx.stroke();
                    } else {
                        const r = this.config.nodeRadiusPx / state.transform.k;
                        ctx.beginPath();
                        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
                        ctx.fillStyle = color;
                        ctx.fill();

                        if (isHighlighted) {
                            ctx.strokeStyle = flashPhase > 0 ? `rgba(255, 255, 100, ${0.5 + flashPhase * 0.5})` : "transparent";
                            ctx.lineWidth = (2 + flashPhase * 2) / state.transform.k;
                            ctx.stroke();
                        } else if (!state.nodeColorOverrides.has(n.id) && isWithinTolerance(n)) {
                            ctx.strokeStyle = this.config.colors.greenStroke;
                            ctx.lineWidth = this.config.nodeStrokePx / state.transform.k;
                            ctx.stroke();
                        }
                    }

                    ctx.globalAlpha = 1.0;
                }
            }
        }

        ctx.restore();
    }
    drawGeometry(ctx, coords, color, strokeColor, lineWidth, detectedSwap) {
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
        ctx.fillStyle = color;
        ctx.fill(path);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth;
        ctx.stroke(path);
    }

    addToPath(path, coords, detectedSwap) {
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
    }

    lightenColor(color, percent) {
        // Simple HSL parsing and adjustment
        if (color.startsWith("hsl")) {
            const parts = color.match(/hsl\((\d+\.?\d*),\s*(\d+)%,\s*(\d+)%\)/);
            if (parts) {
                let h = parseFloat(parts[1]);
                let s = parseInt(parts[2]);
                let l = parseInt(parts[3]);
                l = Math.min(100, l + percent);
                return `hsl(${h}, ${s}%, ${l}%)`;
            }
        }
        return color; // Fallback
    }
}