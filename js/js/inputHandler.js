// Input handling
export class InputHandler {
    constructor(canvas, viewManager) {
        this.canvas = canvas;
        this.viewManager = viewManager;
        this.isDragging = false;
        this.dragStart = null;
    }

    findNearestNode(nodes, state, mousePos) {
        let nearest = null, minDist = 6 / state.transform.k;
        for (const n of nodes) {
            const d = Math.hypot(n.x - mousePos.x, n.y - mousePos.y);
            if (d < minDist) {
                minDist = d;
                nearest = n;
            }
        }
        return nearest;
    }

    renderTooltip(node, state, toleranceChecker, metadata) {
        const fmtInt = new Intl.NumberFormat('en-US');
        const fmtFixed = (x, k = 6) => (Number.isFinite(x) ? x.toFixed(k) : "N/A");

        const pop = node.population != null ? fmtInt.format(node.population) : "N/A";
        const within = toleranceChecker.isWithinTolerance(node, metadata) ? "✅ within" : "❌ outside";
        const isRoot = node.id === state.rootId ? " (root)" : "";
        const degree = state.links.filter(e => e.source === node.id || e.target === node.id).length;

        const overrideColor = state.nodeColorOverrides.get(node.id);
        const districtInfo = overrideColor ? `<div><b>District Color</b> <span style="display:inline-block;width:12px;height:12px;background:${overrideColor};border-radius:50%;vertical-align:middle;"></span></div>` : "";

        return `
            <div style="min-width: 250px; font-size: 12px; line-height: 1.6;">
                <div><b>Node ID</b> ${node.id}${isRoot}</div>
                <div><b>Lon</b> ${fmtFixed(node.x, 6)}</div>
                <div><b>Lat</b> ${fmtFixed(node.y, 6)}</div>
                <div><b>Degree</b> ${degree}</div>
                <div><b>Population:</b> ${pop} <span style="padding:1px 6px;border-radius:999px;background:#eee;font-size:11px;">${within}</span></div>
                <hr style="border: none; border-top: 1px solid #ddd; margin: 6px 0;">
                <div><b>Has Facility:</b> ${node.has_facility ? "✓" : "✗"}</div>
                <div><b>Compl. Facility:</b> ${node.compl_facility ? "✓" : "✗"}</div>
                <div><b>Candidate:</b> ${node.candidate ? "✓" : "✗"}</div>
                ${districtInfo}
            </div>
        `;
    }

    findBlockAt(state, mousePos) {
        // Iterate through all blocks to find if mouse is inside
        // Use bounding box check first for performance
        const mx = mousePos.x;
        const my = mousePos.y;

        for (const [blockId, geom] of state.blockIdToGeometry.entries()) {
            if (!geom || !geom.coordinates) continue;

            // Bounding box check
            const bounds = state.blockIdToBounds.get(blockId);
            if (bounds) {
                if (mx < bounds[0] || my < bounds[1] || mx > bounds[2] || my > bounds[3]) {
                    continue;
                }
            }

            let isInside = false;
            const checkRing = (ring) => {
                let inside = false;
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const xi = state.detectedSwap ? ring[i][1] : ring[i][0];
                    const yi = state.detectedSwap ? ring[i][0] : ring[i][1];
                    const xj = state.detectedSwap ? ring[j][1] : ring[j][0];
                    const yj = state.detectedSwap ? ring[j][0] : ring[j][1];

                    const intersect = ((yi > my) !== (yj > my))
                        && (mx < (xj - xi) * (my - yi) / (yj - yi) + xi);
                    if (intersect) inside = !inside;
                }
                return inside;
            };

            if (geom.type === "Polygon") {
                if (checkRing(geom.coordinates[0])) isInside = true;
            } else if (geom.type === "MultiPolygon") {
                for (const poly of geom.coordinates) {
                    if (checkRing(poly[0])) {
                        isInside = true;
                        break;
                    }
                }
            }

            if (isInside) return blockId;
        }
        return null;
    }

    renderBlockMetadata(blockId, state) {
        const feature = state.blockIdToFeature.get(blockId);
        const props = feature?.properties || {};
        const districtColor = state.districtBlockColors.get(blockId);
        const districtId = state.blockIdToDistrictId.get(blockId);
        const districtMeta = districtId ? state.districtMetadata.get(districtId) : null;

        let html = `
            <div style="margin-bottom:8px;">
                <div><b>Block ID:</b> ${blockId}</div>
                <div><b>GEOID:</b> ${props.GEOID20 || props.GEOID || "N/A"}</div>
                <div><b>Population:</b> ${props.population || "N/A"}</div>
            </div>
        `;

        if (districtColor) {
            html += `
                <div style="border-top: 1px solid #eee; pt-2; mt-2;">
                    <div style="margin-bottom:4px;"><b>District ${districtId}</b> 
                        <span style="display:inline-block;width:12px;height:12px;background:${districtColor};border-radius:50%;vertical-align:middle;"></span>
                    </div>
            `;
            if (districtMeta) {
                if (districtMeta.center_node) html += `<div><b>Center Node:</b> ${districtMeta.center_node}</div>`;
                if (districtMeta.population != null) html += `<div><b>Dist. Pop:</b> ${districtMeta.population}</div>`;
                if (districtMeta.radius != null) html += `<div><b>Radius:</b> ${districtMeta.radius.toFixed(4)}</div>`;
            }
            html += `</div>`;
        }
        return html;
    }

    renderDistrictMetadata(districtId, state) {
        const districtMeta = state.districtMetadata.get(districtId);
        const districtColor = [...state.districtBlockColors.entries()].find(([blockId, color]) =>
            state.blockIdToDistrictId.get(blockId) === districtId
        )?.[1];

        // Count blocks in this district
        const blockCount = [...state.blockIdToDistrictId.values()].filter(id => id === districtId).length;

        let html = `
            <div style="margin-bottom:8px; font-size: 12px; line-height: 1.6;">
                <div style="margin-bottom:4px;"><b>District ${districtId}</b> 
                    <span style="display:inline-block;width:12px;height:12px;background:${districtColor || '#ccc'};border-radius:50%;vertical-align:middle;"></span>
                </div>
                <div><b>Blocks:</b> ${blockCount}</div>
            </div>
        `;

        if (districtMeta) {
            html += `<div style="border-top: 1px solid #eee; padding-top: 8px; margin-top: 8px; font-size: 12px; line-height: 1.6;">`;
            if (districtMeta.iteration != null) html += `<div><b>Iteration:</b> ${districtMeta.iteration}</div>`;
            if (districtMeta.district_id) html += `<div><b>District ID:</b> ${districtMeta.district_id}</div>`;
            if (districtMeta.timestamp) html += `<div><b>Timestamp:</b> ${districtMeta.timestamp}</div>`;
            if (districtMeta.root) html += `<div><b>Root:</b> ${districtMeta.root}</div>`;
            if (districtMeta.tot_pop != null) html += `<div><b>Total Pop:</b> ${districtMeta.tot_pop}</div>`;
            if (districtMeta.hired_teams != null) html += `<div><b>Hired Teams:</b> ${districtMeta.hired_teams}</div>`;
            if (districtMeta.debt != null) html += `<div><b>Debt:</b> ${districtMeta.debt.toFixed(2)}</div>`;
            html += `</div>`;
        }

        return html;
    }

    attachMouseListeners(canvas, state, viewManager, redraw, nodes, toleranceChecker, metadata, tooltip) {
        const districtMetadataPanel = document.getElementById("districtMetadata");
        let isRotating = false;
        let rotationStart = { x: 0, y: 0, startAngle: 0 };

        canvas.addEventListener("mousedown", e => {
            if (e.button === 2) { // Right-click for rotation
                e.preventDefault();
                isRotating = true;
                rotationStart = {
                    x: e.clientX,
                    y: e.clientY,
                    startAngle: state.transform.angle
                };
            } else { // Left-click for panning
                this.isDragging = true;
                this.dragStart = { x: e.clientX, y: e.clientY };
            }
        });

        canvas.addEventListener("mousemove", e => {
            if (isRotating) {
                // Calculate rotation based on horizontal mouse movement
                const dx = e.clientX - rotationStart.x;
                const rotationSensitivity = 0.005; // Radians per pixel
                state.transform.angle = rotationStart.startAngle + (dx * rotationSensitivity);
                redraw();
            } else if (this.isDragging) {
                state.transform.x += e.clientX - this.dragStart.x;
                state.transform.y += e.clientY - this.dragStart.y;
                this.dragStart = { x: e.clientX, y: e.clientY };
                redraw();
            } else {
                const m = viewManager.getMousePos(e, state);

                // Check for tree nodes first (only if in tree mode)
                if (state.viewMode === 'tree') {
                    const hitNode = this.findNearestNode(state.nodes, state, m);
                    if (hitNode) {
                        // Show node tooltip
                        tooltip.style.left = (e.pageX + 10) + "px";
                        tooltip.style.top = (e.pageY + 10) + "px";
                        tooltip.innerHTML = this.renderTooltip(hitNode, state, toleranceChecker, metadata);
                        tooltip.style.display = "block";

                        // Clear district metadata panel
                        if (districtMetadataPanel) {
                            districtMetadataPanel.innerHTML = "<div style='color:#999;font-style:italic;'>Hover over a district...</div>";
                        }

                        // Highlight the node and its corresponding block
                        if (state.highlightNodeId !== hitNode.id) {
                            state.highlightNodeId = hitNode.id;
                            state.highlightBlockId = hitNode.id; // Highlight the block corresponding to this node
                            state.highlightDistrictId = null; // Clear district highlight
                            state.highlightUntil = Date.now() + 100000;
                            redraw();
                        }
                        return;
                    }
                }

                // If no node (or in district mode), check for blocks/districts
                if (state.viewMode === 'district') {
                    const hitBlockId = this.findBlockAt(state, m);
                    if (hitBlockId) {
                        const districtId = state.blockIdToDistrictId.get(hitBlockId);

                        // Only highlight if this block belongs to a colored/active district
                        const isDistrictActive = districtId && state.districtBlockColors.has(hitBlockId);

                        if (isDistrictActive) {
                            // Hide floating tooltip
                            tooltip.style.display = "none";

                            // Update sidebar with DISTRICT metadata
                            if (districtMetadataPanel) {
                                districtMetadataPanel.innerHTML = this.renderDistrictMetadata(districtId, state);
                            }

                            // Highlight the entire district
                            if (state.highlightDistrictId !== districtId) {
                                state.highlightDistrictId = districtId;
                                state.highlightBlockId = null; // Clear block highlight
                                state.highlightNodeId = null; // Clear node highlight
                                redraw();
                            }
                            return;
                        }
                    }
                }

                // Not hovering over anything active
                tooltip.style.display = "none";
                if (state.highlightNodeId || state.highlightBlockId || state.highlightDistrictId) {
                    state.highlightNodeId = null;
                    state.highlightBlockId = null;
                    state.highlightDistrictId = null;
                    if (districtMetadataPanel) {
                        districtMetadataPanel.innerHTML = "<div style='color:#999;font-style:italic;'>Hover over a district...</div>";
                    }
                    redraw();
                }
            }
        });

        canvas.addEventListener("mouseup", () => {
            this.isDragging = false;
            isRotating = false;
        });

        canvas.addEventListener("mouseleave", () => {
            this.isDragging = false;
            isRotating = false;
            tooltip.style.display = "none";
            state.highlightNodeId = null;
            state.highlightBlockId = null;
            redraw();
        });

        // Prevent context menu on right-click
        canvas.addEventListener("contextmenu", e => {
            e.preventDefault();
            return false;
        });

        canvas.addEventListener("wheel", e => {
            e.preventDefault();
            const scale = e.deltaY < 0 ? 1.1 : 0.9;
            const m = viewManager.getMousePos(e, state);
            state.transform.x -= m.x * (scale - 1) * state.transform.k;
            state.transform.y -= m.y * (scale - 1) * state.transform.k;
            state.transform.k *= scale;
            redraw();
        }, { passive: false });
    }
}