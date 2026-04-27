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

        const frameType = state.currentFrame?.type || null;
        const isOverview = state.detailLevel === "overview";
        const isTreePhase = frameType === "tree_cut" && !isOverview;

        // ==========================================
        // LAYER 0: Block background (always)
        // ==========================================
        if (state.blocksPaths.length > 0) {
            ctx.fillStyle = this.config.colors.blockFill;
            ctx.strokeStyle = this.config.colors.blockStroke;
            ctx.lineWidth = this.visual.blockLineWidth / state.transform.k;
            for (const p of state.blocksPaths) {
                ctx.fill(p);
                ctx.stroke(p);
            }
        }

        // ==========================================
        // LAYER 1: District coloring
        // ==========================================
        if (state.blockIdToDistrictId.size > 0) {
            if (isOverview) {
                // Overview mode: fill entire cells with district color
                for (const [blockId, color] of state.districtBlockColors.entries()) {
                    const geom = state.blockIdToGeometry.get(blockId);
                    if (!geom) continue;

                    if (geom.type === "Polygon") {
                        this.drawGeometry(ctx, geom.coordinates, color, "rgba(0,0,0,0.4)", 0.3 / state.transform.k, state.detectedSwap);
                    } else if (geom.type === "MultiPolygon") {
                        for (const poly of geom.coordinates) {
                            this.drawGeometry(ctx, poly, color, "rgba(0,0,0,0.4)", 0.3 / state.transform.k, state.detectedSwap);
                        }
                    }
                }
            } else {
                // Detailed mode: outline only
                const cutSideNodes = state.cutSideNodes || new Set();
                const mergedBaseNodes = state.mergedBaseNodes || new Set();
                const extractedNodes = state.extractedNodes || new Set();

                for (const [blockId, color] of state.districtBlockColors.entries()) {
                    const geom = state.blockIdToGeometry.get(blockId);
                    if (!geom) continue;

                    let outlineColor = color;
                    let lw = 0.5 / state.transform.k;

                    // Phase 1: highlight merged superdistrict blocks
                    if (frameType === "select" && mergedBaseNodes.has(blockId)) {
                        outlineColor = "#ffff00";
                        lw = 1.5 / state.transform.k;
                    }
                    // Phase 2+3: highlight cut side and extracted district
                    if (isTreePhase) {
                        if (extractedNodes.has(blockId)) {
                            outlineColor = "#00ff88";
                            lw = 1.5 / state.transform.k;
                        } else if (cutSideNodes.has(blockId)) {
                            outlineColor = "rgba(255, 255, 100, 0.8)";
                            lw = 1.0 / state.transform.k;
                        }
                    }

                    if (geom.type === "Polygon") {
                        this.drawOutlineOnly(ctx, geom.coordinates, outlineColor, lw, state.detectedSwap);
                    } else if (geom.type === "MultiPolygon") {
                        for (const poly of geom.coordinates) {
                            this.drawOutlineOnly(ctx, poly, outlineColor, lw, state.detectedSwap);
                        }
                    }
                }
            }
        }

        // ==========================================
        // LAYER 2: Supergraph edges (Phase 1, or always in overview)
        // ==========================================
        if (frameType === "select" && !isOverview && state.supergraphEdges?.length > 0) {
            const coords = state.manifest?.node_coordinates || {};
            const sgNodes = state.supergraphNodes || {};
            // Compute district centroids from base-graph assignment
            const districtCentroids = new Map();
            for (const [did, dinfo] of Object.entries(sgNodes)) {
                // Average coordinates of nodes in this district
                let sx = 0, sy = 0, cnt = 0;
                for (const [nid, nDist] of state.blockIdToDistrictId.entries()) {
                    if (nDist === did) {
                        const c = coords[nid];
                        if (c) { sx += c[0]; sy += c[1]; cnt++; }
                    }
                }
                if (cnt > 0) districtCentroids.set(did, [sx / cnt, sy / cnt]);
            }

            // Draw supergraph edges as thick lines between district centroids
            ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
            ctx.lineWidth = 3 / state.transform.k;
            ctx.beginPath();
            for (const [u, v] of state.supergraphEdges) {
                const cu = districtCentroids.get(u), cv = districtCentroids.get(v);
                if (cu && cv) {
                    ctx.moveTo(cu[0], cu[1]);
                    ctx.lineTo(cv[0], cv[1]);
                }
            }
            ctx.stroke();

            // Draw supergraph nodes as circles at district centroids
            for (const [did, centroid] of districtCentroids) {
                const isMerged = state.mergedSuperdistricts?.has(did);
                const R = (isMerged ? 0.4 : 0.25);
                ctx.beginPath();
                ctx.arc(centroid[0], centroid[1], R, 0, Math.PI * 2);
                ctx.fillStyle = isMerged ? "#ffff00" : "#ffffff";
                ctx.fill();
                ctx.strokeStyle = "#333";
                ctx.lineWidth = 1 / state.transform.k;
                ctx.stroke();
                // Label
                ctx.save();
                ctx.fillStyle = "#000";
                ctx.font = `0.3px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(did, centroid[0], centroid[1]);
                ctx.restore();
            }
        }

        // ==========================================
        // LAYER 3: Tree edges + nodes (Phase 2+3 detailed)
        // ==========================================
        if (isTreePhase && state.links.length > 0) {
            // Tree edges
            ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
            ctx.lineWidth = 2 / state.transform.k;
            ctx.beginPath();
            for (const e of state.links) {
                const s = state.nodesById[e.source], t = state.nodesById[e.target];
                if (!s || !t) continue;
                ctx.moveTo(s.x, s.y);
                ctx.lineTo(t.x, t.y);
            }
            ctx.stroke();

            // Tree nodes
            const nodeR = (this.config.nodeRadiusPx * 2) / state.transform.k;
            for (const n of state.nodes) {
                const isRoot = n.id === state.rootId;
                const isCut = n.id === state.cutNodeId;

                if (isRoot) {
                    const R = this.config.rootOuterPx * 1.2 / state.transform.k;
                    this.drawStarPath(n.x, n.y, R, 5, this.config.rootInset);
                    ctx.fillStyle = "#ffd54f";
                    ctx.fill();
                    ctx.strokeStyle = "#333";
                    ctx.lineWidth = 2 / state.transform.k;
                    ctx.stroke();
                } else if (isCut) {
                    const R = nodeR * 1.3;
                    ctx.save();
                    ctx.translate(n.x, n.y);
                    ctx.rotate(Math.PI / 4);
                    ctx.fillStyle = "#ff5252";
                    ctx.fillRect(-R, -R, R * 2, R * 2);
                    ctx.strokeStyle = "#fff";
                    ctx.lineWidth = 2 / state.transform.k;
                    ctx.strokeRect(-R, -R, R * 2, R * 2);
                    ctx.restore();
                } else {
                    const feasible = n.demand_ok && n.has_facility;
                    ctx.beginPath();
                    ctx.arc(n.x, n.y, nodeR, 0, Math.PI * 2);
                    ctx.fillStyle = feasible ? "#00ff00" : "#cc3333";
                    ctx.fill();
                    ctx.strokeStyle = "#ffffff";
                    ctx.lineWidth = 1 / state.transform.k;
                    ctx.stroke();
                }

                if (n.is_candidate && n.id !== state.rootId) {
                    const sr = nodeR * 0.5;
                    this.drawStarPath(n.x, n.y, sr, 4, 0.5);
                    ctx.fillStyle = "#FFD700";
                    ctx.fill();
                }
            }
        }

        // ==========================================
        // LAYER 4: Candidate stars (non-tree phases)
        // ==========================================
        if (!isTreePhase && state.manifest?.node_candidates) {
            const candidates = state.manifest.node_candidates;
            const coords = state.manifest.node_coordinates;
            if (candidates && coords) {
                for (const [nodeId, isCandidate] of Object.entries(candidates)) {
                    if (!isCandidate) continue;
                    const c = coords[nodeId];
                    if (!c) continue;
                    this.drawStarPath(c[0], c[1], 0.15, 5, 0.5);
                    ctx.fillStyle = "#FFD700";
                    ctx.fill();
                    ctx.strokeStyle = "#333";
                    ctx.lineWidth = 0.3 / state.transform.k;
                    ctx.stroke();
                }
            }
        }

        // ==========================================
        // LAYER 5: Facility centers (Phase 4, or always in overview)
        // ==========================================
        if ((frameType === "facility" || isOverview) && state.proposedCenters) {
            const coords = state.manifest?.node_coordinates || {};
            for (const [did, centerId] of Object.entries(state.proposedCenters)) {
                if (!centerId) continue;
                const c = coords[centerId];
                if (!c) continue;
                // Draw a cross/plus at facility center
                const R = 0.3;
                ctx.strokeStyle = "#00ffff";
                ctx.lineWidth = 2 / state.transform.k;
                ctx.beginPath();
                ctx.moveTo(c[0] - R, c[1]); ctx.lineTo(c[0] + R, c[1]);
                ctx.moveTo(c[0], c[1] - R); ctx.lineTo(c[0], c[1] + R);
                ctx.stroke();
            }
        }

        // ==========================================
        // LAYER 6: Phase label overlay (screen space)
        // ==========================================
        if (state.phaseLabel) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);

            // Build the overlay text as separate lines
            const lines = [];
            const labelParts = String(state.phaseLabel).split("\n");
            // Frame progress
            const fi = (state.frameIndex ?? 0) + 1;
            const ft = state.frames?.length ?? 0;

            lines.push({
                text: `State ${state.iteration}   Frame ${fi}/${ft}`,
                font: "bold 13px sans-serif",
                color: "#ffffff",
            });
            for (const part of labelParts) {
                if (part.trim()) {
                    lines.push({
                        text: part,
                        font: "11px sans-serif",
                        color: "#90caf9",
                    });
                }
            }

            // Accept/reject info
            if (frameType === "accept_reject") {
                const accepted = state.stepAccepted;
                const text = accepted ? "ACCEPTED" : "REJECTED";
                lines.push({
                    text,
                    font: "bold 18px sans-serif",
                    color: accepted ? "#00ff00" : "#ff5252",
                });
                const deltaE = (state.energyProposed - state.energyCurrent).toFixed(1);
                lines.push({
                    text: `\u0394E = ${deltaE}`,
                    font: "12px monospace",
                    color: "#ccc",
                });
            }

            const padX = 12;
            const padY = 10;
            const lineHeight = 20;
            // Hard cap at 320px — fits comfortably in the top-left corner
            const maxBoxWidth = 320;
            const maxTextWidth = maxBoxWidth - padX * 2;

            // Word-wrap long lines
            const wrappedLines = [];
            for (const ln of lines) {
                ctx.font = ln.font;
                const words = ln.text.split(" ");
                let curr = "";
                for (const w of words) {
                    const test = curr ? curr + " " + w : w;
                    if (ctx.measureText(test).width > maxTextWidth && curr) {
                        wrappedLines.push({ ...ln, text: curr });
                        curr = w;
                    } else {
                        curr = test;
                    }
                }
                if (curr) wrappedLines.push({ ...ln, text: curr });
            }

            // Measure widest wrapped line
            let maxWidth = 0;
            for (const ln of wrappedLines) {
                ctx.font = ln.font;
                const w = ctx.measureText(ln.text).width;
                if (w > maxWidth) maxWidth = w;
            }

            const boxW = Math.min(maxWidth + padX * 2, maxBoxWidth);
            const boxH = lineHeight * wrappedLines.length + padY * 2 - 6;

            // Background
            ctx.fillStyle = "rgba(0,0,0,0.75)";
            ctx.fillRect(10, 10, boxW, boxH);
            ctx.fillStyle = "#2196f3";
            ctx.fillRect(10, 10, 3, boxH);

            // Lines
            let y = 10 + padY + 14;
            for (const ln of wrappedLines) {
                ctx.font = ln.font;
                ctx.fillStyle = ln.color;
                ctx.fillText(ln.text, 10 + padX, y);
                y += lineHeight;
            }

            ctx.restore();
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

    drawOutlineOnly(ctx, coords, color, lineWidth, detectedSwap) {
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
        ctx.globalAlpha = 0.6;
        ctx.stroke(path);
        ctx.globalAlpha = 1.0;
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