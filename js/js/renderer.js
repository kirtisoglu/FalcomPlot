// Canvas rendering
import { GeometryUtils } from "./geometry.js";

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
        // Neutral mode (state.districtColorsOff): drop the district
        // color fills to a flat dark tone so overlay layers — ensemble
        // heat, candidate stars, facility crosses — read clearly. The
        // partition stays legible through district strokes and the
        // super-boundary layer.
        const colorsOff = !!state.districtColorsOff;
        const NEUTRAL_FILL = "#20242e";
        const NEUTRAL_STROKE = "rgba(255,255,255,0.13)";
        if (state.blockIdToDistrictId.size > 0) {
            if (isOverview) {
                // Overview mode: fill entire cells with district color
                for (const [blockId, color] of state.districtBlockColors.entries()) {
                    const geom = state.blockIdToGeometry.get(blockId);
                    if (!geom) continue;

                    const fill = colorsOff ? NEUTRAL_FILL : color;
                    const stroke = colorsOff ? NEUTRAL_STROKE : "rgba(0,0,0,0.4)";
                    if (geom.type === "Polygon") {
                        this.drawGeometry(ctx, geom.coordinates, fill, stroke, 0.3 / state.transform.k, state.detectedSwap);
                    } else if (geom.type === "MultiPolygon") {
                        for (const poly of geom.coordinates) {
                            this.drawGeometry(ctx, poly, fill, stroke, 0.3 / state.transform.k, state.detectedSwap);
                        }
                    }
                }
            } else {
                // Detailed mode: fill each LSOA with its district colour
                // (so the partition is legible at a glance) and overlay
                // a phase-specific stroke when relevant.
                const cutSideNodes = state.cutSideNodes || new Set();
                const mergedBaseNodes = state.mergedBaseNodes || new Set();
                const extractedNodes = state.extractedNodes || new Set();

                for (const [blockId, color] of state.districtBlockColors.entries()) {
                    const geom = state.blockIdToGeometry.get(blockId);
                    if (!geom) continue;

                    let strokeColor = colorsOff ? NEUTRAL_STROKE : "rgba(0,0,0,0.35)";
                    let lw = 0.3 / state.transform.k;

                    // Phase 1: highlight merged superdistrict blocks
                    if (frameType === "select" && mergedBaseNodes.has(blockId)) {
                        strokeColor = "#ffff00";
                        lw = 1.5 / state.transform.k;
                    }
                    // Phase 2+3: highlight cut side and extracted district
                    if (isTreePhase) {
                        if (extractedNodes.has(blockId)) {
                            strokeColor = "#00ff88";
                            lw = 1.5 / state.transform.k;
                        } else if (cutSideNodes.has(blockId)) {
                            strokeColor = "rgba(255, 255, 100, 0.8)";
                            lw = 1.0 / state.transform.k;
                        }
                    }

                    const fill = colorsOff ? NEUTRAL_FILL : color;
                    if (geom.type === "Polygon") {
                        this.drawGeometry(ctx, geom.coordinates, fill, strokeColor, lw, state.detectedSwap);
                    } else if (geom.type === "MultiPolygon") {
                        for (const poly of geom.coordinates) {
                            this.drawGeometry(ctx, poly, fill, strokeColor, lw, state.detectedSwap);
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

        // Marker sizes are in WORLD units, so they must scale with the
        // dataset's extent: 0.15 is a good star radius on a 20-unit
        // synthetic grid but covers a quarter of a lon/lat city map.
        // Derive sizes from the world span (with the grid-era defaults
        // as fallback when bounds are unknown).
        const _wb = state.blocksBounds;
        const _worldSpan = _wb
            ? Math.max(_wb.maxx - _wb.minx, _wb.maxy - _wb.miny)
            : 20;
        const starRadius = _worldSpan / 130;
        const centerRadius = _worldSpan / 65;

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
                    this.drawStarPath(c[0], c[1], starRadius, 5, 0.5);
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
                const R = centerRadius;
                ctx.strokeStyle = "#00ffff";
                ctx.lineWidth = 2 / state.transform.k;
                ctx.beginPath();
                ctx.moveTo(c[0] - R, c[1]); ctx.lineTo(c[0] + R, c[1]);
                ctx.moveTo(c[0], c[1] - R); ctx.lineTo(c[0], c[1] + R);
                ctx.stroke();
            }
        }

        // ==========================================
        // LAYER 5.25: Super-district boundaries (world space)
        // ==========================================
        // Drawn along the TRUE shared borders between blocks whose
        // districts belong to different super-districts. Requires the
        // step to carry a `supers` map ({district: super}) and block
        // polygons that share vertices along common borders.
        if (state.currentSupers && state.currentAssignment?.size
            && state.blockIdToGeometry?.size) {
            if (!state._sharedSegments) {
                state._sharedSegments = GeometryUtils.buildSharedSegmentIndex(
                    state.blockIdToGeometry, state.detectedSwap,
                );
            }
            const superOf = (blockId) => {
                const d = state.currentAssignment.get(String(blockId));
                return d == null ? undefined : state.currentSupers.get(String(d));
            };
            ctx.save();
            ctx.strokeStyle = "rgba(10, 10, 14, 0.95)";
            ctx.lineWidth = 3.2 / state.transform.k;
            ctx.lineCap = "round";
            ctx.beginPath();
            for (const s of state._sharedSegments) {
                const sa = superOf(s.blockA);
                const sb = superOf(s.blockB);
                if (sa !== undefined && sb !== undefined && sa !== sb) {
                    ctx.moveTo(s.ax, s.ay);
                    ctx.lineTo(s.bx, s.by);
                }
            }
            ctx.stroke();
            ctx.restore();
        }

        // ==========================================
        // LAYER 5.5: Ensemble overlay (world space) — boundary or facility heatmap
        // ==========================================
        if (state.ensembleView && state.ensemble) {
            this.drawEnsembleOverlay(ctx, state);
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

        // ==========================================
        // LAYER 7: Legend (screen space, bottom-left)
        // ==========================================
        if (this.config.showLegend !== false) {
            this.drawLegend(ctx, state);
        }

        ctx.restore();
    }

    /**
     * Compact legend, bottom-left, screen space. Entries adapt to what
     * is actually on screen: districts always; super boundaries,
     * candidate stars, facility crosses, and ensemble encodings only
     * when their layer is active. Disable with config.showLegend=false.
     */
    drawLegend(ctx, state) {
        const entries = [];
        if (state.districtColorsOff) {
            entries.push({ swatch: "neutral", label: "district colors hidden" });
        } else if (state.currentSupers && state.currentSupers.size) {
            entries.push({ swatch: "tones", label: "hue = super-district, tone = district" });
        } else {
            entries.push({ swatch: "district", label: "districts (color = level-1)" });
        }
        if (state.currentSupers) {
            entries.push({ swatch: "superline", label: "super-district boundary" });
        }
        const anyCandidate = state.manifest?.node_candidates
            && Object.values(state.manifest.node_candidates).some(Boolean);
        if (anyCandidate) {
            entries.push({ swatch: "star", label: "candidate facility site" });
        }
        if (state.proposedCenters && Object.keys(state.proposedCenters).length) {
            entries.push({ swatch: "cross", label: "selected facility" });
        }
        if (state.ensembleView === "boundary") {
            entries.push({ swatch: "heat", label: "boundary frequency (pale → dark)" });
        } else if (state.ensembleView === "facility") {
            entries.push({ swatch: "essential", label: "essential site (≥90% of plans)" });
            entries.push({ swatch: "subst", label: "substitutable site (<50%)" });
        }
        if (!entries.length) return;

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.font = "11px sans-serif";

        const rowH = 18;
        const padX = 10;
        const padY = 8;
        const swatchW = 26;
        let maxW = 0;
        for (const e of entries) {
            const w = ctx.measureText(e.label).width;
            if (w > maxW) maxW = w;
        }
        const boxW = padX * 2 + swatchW + 6 + maxW;
        const boxH = padY * 2 + rowH * entries.length - 4;
        const x0 = 10;
        const y0 = this.canvas.height - boxH - 10;

        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.fillRect(x0, y0, boxW, boxH);

        let y = y0 + padY + 9;
        for (const e of entries) {
            const cx = x0 + padX + swatchW / 2;
            if (e.swatch === "district") {
                const colors = ["#4a90d9", "#67b26f", "#e2a33d"];
                colors.forEach((c, i) => {
                    ctx.fillStyle = c;
                    ctx.fillRect(x0 + padX + i * 8, y - 6, 7, 9);
                });
            } else if (e.swatch === "tones") {
                // three tones of one hue = one super-district's districts
                ["hsl(210,64%,44%)", "hsl(210,60%,58%)", "hsl(210,68%,70%)"]
                    .forEach((c, i) => {
                        ctx.fillStyle = c;
                        ctx.fillRect(x0 + padX + i * 8, y - 6, 7, 9);
                    });
            } else if (e.swatch === "neutral") {
                ctx.fillStyle = "#20242e";
                ctx.strokeStyle = "rgba(255,255,255,0.3)";
                ctx.fillRect(x0 + padX, y - 6, 24, 9);
                ctx.strokeRect(x0 + padX, y - 6, 24, 9);
            } else if (e.swatch === "superline") {
                ctx.strokeStyle = "rgba(10,10,14,0.95)";
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(x0 + padX, y - 1);
                ctx.lineTo(x0 + padX + swatchW, y - 1);
                ctx.stroke();
                ctx.strokeStyle = "rgba(255,255,255,0.5)";
                ctx.lineWidth = 0.5;
                ctx.stroke();
            } else if (e.swatch === "star") {
                this.drawStarPathAt(ctx, cx, y - 2, 6);
                ctx.fillStyle = "#FFD700";
                ctx.fill();
                ctx.strokeStyle = "#333";
                ctx.lineWidth = 0.8;
                ctx.stroke();
            } else if (e.swatch === "cross") {
                ctx.strokeStyle = "#00ffff";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(cx - 6, y - 2); ctx.lineTo(cx + 6, y - 2);
                ctx.moveTo(cx, y - 8); ctx.lineTo(cx, y + 4);
                ctx.stroke();
            } else if (e.swatch === "heat") {
                const ramp = ["rgba(180,180,180,0.5)", "rgba(255,209,102,0.9)",
                              "rgba(245,130,49,0.9)", "rgba(150,20,30,1.0)"];
                ramp.forEach((c, i) => {
                    ctx.fillStyle = c;
                    ctx.fillRect(x0 + padX + i * 6.5, y - 6, 6, 8);
                });
            } else if (e.swatch === "essential") {
                ctx.fillStyle = "#e6194b";
                ctx.beginPath();
                ctx.arc(cx, y - 2, 5, 0, Math.PI * 2);
                ctx.fill();
            } else if (e.swatch === "subst") {
                ctx.strokeStyle = "#42d4f4";
                ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.arc(cx, y - 2, 4, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.fillStyle = "#e8eaf0";
            ctx.fillText(e.label, x0 + padX + swatchW + 6, y + 2);
            y += rowH;
        }
        ctx.restore();
    }

    /** Star path on an explicit context at screen coordinates. */
    drawStarPathAt(ctx, x, y, rOuter, spikes = 5, inset = 0.5) {
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

    /**
     * Draw the ensemble-analysis overlay in world space.
     * Modes:
     *   "boundary"  — colour edges between block centroids by their
     *                 boundary-frequency across the ensemble. Dark red
     *                 for always-a-boundary (≥0.9), pale for sometimes
     *                 (0.1..0.5), gray for never (<0.1).
     *   "facility"  — colour candidate sites by their selection frequency.
     *                 Larger filled circles = essential (≥0.9), smaller
     *                 hollow = substitutable (<0.5).
     *   "capacity"  — overlay a small histogram of demand-CV samples.
     */
    drawEnsembleOverlay(ctx, state) {
        const ens = state.ensemble;
        const view = state.ensembleView;
        if (!ens) return;

        const coords = state.manifest?.node_coordinates || {};
        const centroidById = state.centroidMaps?.byFeatId;

        function resolveCoord(id) {
            const sid = String(id);
            if (coords[sid]) return coords[sid];
            if (centroidById && centroidById.get(sid)) return centroidById.get(sid);
            return null;
        }

        if (view === 'boundary') {
            const freqs = ens.boundary_frequencies || {};
            const lw = 1.6 / state.transform.k;
            ctx.lineWidth = lw;
            for (const [edge, f] of Object.entries(freqs)) {
                if (f < 0.05) continue;
                const [a, b] = edge.split('|');
                const ca = resolveCoord(a);
                const cb = resolveCoord(b);
                if (!ca || !cb) continue;
                ctx.strokeStyle = this._heatColor(f);
                ctx.beginPath();
                ctx.moveTo(ca[0], ca[1]);
                ctx.lineTo(cb[0], cb[1]);
                ctx.stroke();
            }
        } else if (view === 'facility') {
            const freqs = ens.facility_frequencies || {};
            const baseR = 4 / state.transform.k;
            for (const [nid, f] of Object.entries(freqs)) {
                const c = resolveCoord(nid);
                if (!c) continue;
                const r = baseR * (0.6 + 1.4 * f);
                ctx.beginPath();
                ctx.arc(c[0], c[1], r, 0, Math.PI * 2);
                if (f >= 0.9) {
                    // Essential — solid red
                    ctx.fillStyle = '#e6194b';
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 0.6 / state.transform.k;
                    ctx.fill();
                    ctx.stroke();
                } else if (f >= 0.5) {
                    // Common — orange filled, lighter
                    ctx.fillStyle = '#f58231';
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 0.4 / state.transform.k;
                    ctx.globalAlpha = 0.85;
                    ctx.fill();
                    ctx.stroke();
                    ctx.globalAlpha = 1.0;
                } else {
                    // Substitutable — hollow ring
                    ctx.strokeStyle = '#42d4f4';
                    ctx.lineWidth = 1.0 / state.transform.k;
                    ctx.globalAlpha = 0.7;
                    ctx.stroke();
                    ctx.globalAlpha = 1.0;
                }
            }
        } else if (view === 'capacity') {
            // Capacity uses a separate screen-space histogram (drawn in HUD).
            // Render an unobtrusive marker for now.
        }
    }

    /** Map a frequency in [0,1] to a heat colour (gray → orange → dark red). */
    _heatColor(f) {
        if (f < 0.1) return 'rgba(180, 180, 180, 0.35)';
        if (f < 0.3) return 'rgba(255, 209, 102, 0.7)';
        if (f < 0.5) return 'rgba(245, 130, 49, 0.8)';
        if (f < 0.7) return 'rgba(229, 81, 47, 0.85)';
        if (f < 0.9) return 'rgba(200, 30, 30, 0.9)';
        return 'rgba(150, 20, 30, 1.0)';
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