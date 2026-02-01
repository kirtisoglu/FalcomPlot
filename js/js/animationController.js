// Animation control
export class AnimationController {
    constructor(dataLoader, logger, config) {
        this.dataLoader = dataLoader;
        this.logger = logger;
        this.config = config;
    }

    async play(state, redraw, viewManager, onTreeLoaded) {
        if (state.isPlaying) return;
        state.isPlaying = true;
        state.isPaused = false;
        this.logger.log("Animation started", "success");
        this.animationStep(state, redraw, viewManager, onTreeLoaded);
    }

    pause(state) {
        state.isPlaying = false;
        state.isPaused = true;
        this.logger.log("Animation paused", "info");
    }

    stop(state, redraw) {
        state.isPlaying = false;
        state.isPaused = false;
        state.iteration = 0;
        state.nodes = [];
        state.links = [];
        state.nodesById = {};
        state.districts.clear();
        state.nodeColorOverrides.clear();
        state.districtBlockColors.clear();
        state.metadata = null;
        state.rootId = null;
        this.logger.log("Animation stopped", "info");
        redraw();
    }

    async animationStep(state, redraw, viewManager, onTreeLoaded) {
        if (!state.isPlaying) return;

        const nextIter = state.iteration + 1;
        if (state.maxIteration && nextIter > state.maxIteration) {
            this.pause(state); // Pause instead of stop to keep the view
            this.logger.log("Animation complete", "success");
            return;
        }

        state.iteration = nextIter;
        document.getElementById("currentIter").textContent = nextIter;

        // Load Tree
        const treeData = await this.dataLoader.loadTree(nextIter, state.centroidMaps, state.treePath);
        if (treeData) {
            state.nodes = treeData.nodes;
            state.links = treeData.links;
            state.nodesById = treeData.nodesById;
            state.metadata = treeData.metadata;
            state.rootId = treeData.rootId;
            if (onTreeLoaded) onTreeLoaded();
        }

        // Load ONE new district and add to existing
        const districtData = await this.dataLoader.loadDistrict(nextIter, state.districtPath);
        if (districtData) {
            this.logger.log(`Loaded district ${nextIter} with ${districtData.nodes.length} nodes`, "info");
            state.districtMetadata.set(nextIter, districtData.metadata);
            for (const nodeId of districtData.nodes) {
                state.nodeColorOverrides.set(nodeId, districtData.color);
                state.districtBlockColors.set(nodeId, districtData.color);
                state.blockIdToDistrictId.set(nodeId, nextIter);
            }
            console.log(`District colors size: ${state.districtBlockColors.size}`);
        } else {
            console.warn(`No district data for iteration ${nextIter}`);
        }

        redraw();

        // Schedule next
        if (state.isPlaying) {
            setTimeout(() => {
                this.animationStep(state, redraw, viewManager, onTreeLoaded);
            }, this.config.animationDuration / state.animationSpeed);
        }
    }

    async jumpToIteration(targetIter, state, redraw, viewManager, centroidMaps, onTreeLoaded) {
        state.isPlaying = false;
        state.iteration = targetIter;
        document.getElementById("currentIter").textContent = targetIter;
        this.logger.log(`Jumping to iteration ${targetIter}`, "info");

        const treeData = await this.dataLoader.loadTree(targetIter, centroidMaps, state.treePath);
        if (treeData) {
            state.nodes = treeData.nodes;
            state.links = treeData.links;
            state.nodesById = treeData.nodesById;
            state.metadata = treeData.metadata;
            state.rootId = treeData.rootId;
            if (onTreeLoaded) onTreeLoaded();

            viewManager.autoCenterAndScale(state);

            // Clear existing colors
            state.nodeColorOverrides.clear();
            state.districtBlockColors.clear();
            state.blockIdToDistrictId.clear();
            state.districtMetadata.clear();

            // Load ALL districts up to targetIter
            const districtPromises = [];
            for (let i = 1; i <= targetIter; i++) {
                districtPromises.push(this.dataLoader.loadDistrict(i, state.districtPath));
            }

            const districts = await Promise.all(districtPromises);

            for (let i = 0; i < districts.length; i++) {
                const districtData = districts[i];
                const districtId = i + 1;
                if (districtData) {
                    state.districtMetadata.set(districtId, districtData.metadata);
                    for (const nodeId of districtData.nodes) {
                        state.nodeColorOverrides.set(nodeId, districtData.color);
                        state.districtBlockColors.set(nodeId, districtData.color);
                        state.blockIdToDistrictId.set(nodeId, districtId);
                    }
                }
            }
            console.log(`Jump complete. Total colored blocks: ${state.districtBlockColors.size}`);

            // Compute district boundaries ONLY for final iteration
            if (targetIter === state.maxIteration) {
                try {
                    console.log("[ANIM] Computing boundaries for FINAL iteration...");
                    const { districtBoundaries, districtBoundaryColors } = this.dataLoader.computeDistrictBoundaries(state);
                    state.districtBoundaries = districtBoundaries;
                    state.districtBoundaryColors = districtBoundaryColors;
                    console.log("[ANIM] Final boundaries computed:", districtBoundaries.size);
                } catch (err) {
                    console.error("[ANIM] Error computing final boundaries:", err);
                }
            }

            redraw();
        }
    }
}