// Animation control — nested four-phase stepping
//
// Each chain step has a nested structure:
//   Phase 1: Hierarchical Proposal
//     upper_level:
//       Phase 2+3: tree cuts on supergraph
//       Phase 4: level-2 facility assignment
//     select: choose superdistrict
//     lower_level:
//       Phase 2+3: tree cuts on base graph
//       Phase 4: level-1 facility assignment
//     accept_reject
//
// The controller flattens this into a frame sequence for playback.

export class AnimationController {
    constructor(dataLoader, logger, config) {
        this.dataLoader = dataLoader;
        this.logger = logger;
        this.config = config;
    }

    async play(state, redraw, viewManager, onStepLoaded) {
        if (state.isPlaying) return;
        state.isPlaying = true;
        state.isPaused = false;
        this.logger.log("Animation started", "success");
        this._nextFrame(state, redraw, viewManager, onStepLoaded);
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
        this._clearPhaseState(state);
        state.districts.clear();
        state.nodeColorOverrides.clear();
        state.districtBlockColors.clear();
        state.blockIdToDistrictId.clear();
        state.stepData = null;
        this.logger.log("Animation stopped", "info");
        redraw();
    }

    _clearPhaseState(state) {
        state.frames = null;
        state.frameIndex = -1;
        state.currentFrame = null;
        state.phaseLabel = "";
        state.nodes = [];
        state.links = [];
        state.nodesById = {};
        state.rootId = null;
        state.cutNodeId = null;
        state.cutSideNodes = new Set();
        state.extractedNodes = new Set();
        state.mergedSuperdistricts = new Set();
        state.mergedBaseNodes = new Set();
        state.supergraphEdges = [];
        state.supergraphNodes = {};
        state.proposedCenters = {};
        state.energyProposed = 0;
        state.energyCurrent = 0;
        state.stepAccepted = false;
        state.metadata = null;
    }

    /**
     * Flatten the nested phase structure into a linear frame sequence.
     */
    _buildFrames(phaseData) {
        const step = Array.isArray(phaseData) ? phaseData[0] : phaseData;
        if (!step) return [];

        const frames = [];
        const sgCoords = step.upper_level?.supergraph_coords || {};

        // Upper level tree cuts
        if (step.upper_level?.phase2?.tree_cuts) {
            for (const tc of step.upper_level.phase2.tree_cuts) {
                frames.push({
                    type: "tree_cut",
                    section: "upper",
                    sectionLabel: step.upper_level.label,
                    data: { ...tc, supergraph_coords: sgCoords },
                });
            }
        }
        // Upper level phase 4
        if (step.upper_level?.phase4) {
            frames.push({
                type: "facility",
                section: "upper",
                sectionLabel: step.upper_level.label,
                data: { ...step.upper_level.phase4, supergraph_coords: sgCoords },
            });
        }

        // Select superdistrict
        if (step.select) {
            frames.push({
                type: "select",
                section: "select",
                sectionLabel: "",
                data: step.select,
            });
        }

        // Lower level tree cuts
        if (step.lower_level?.phase2?.tree_cuts) {
            for (const tc of step.lower_level.phase2.tree_cuts) {
                frames.push({
                    type: "tree_cut",
                    section: "lower",
                    sectionLabel: step.lower_level.label,
                    data: tc,
                });
            }
        }
        // Lower level phase 4
        if (step.lower_level?.phase4) {
            frames.push({
                type: "facility",
                section: "lower",
                sectionLabel: step.lower_level.label,
                data: step.lower_level.phase4,
            });
        }

        // Accept/reject
        if (step.accept_reject) {
            frames.push({
                type: "accept_reject",
                section: "result",
                sectionLabel: "",
                data: step.accept_reject,
            });
        }

        return frames;
    }

    _applyFrame(state, frame) {
        state.currentFrame = frame;

        if (frame.type === "tree_cut") {
            const label = `${frame.sectionLabel}\n${frame.data.label}`;
            state.phaseLabel = label;
            const treeData = this.dataLoader.buildTreeFromSubstep(frame.data, state);
            state.nodes = treeData.nodes;
            state.links = treeData.links;
            state.nodesById = treeData.nodesById;
            state.rootId = treeData.rootId;
            state.cutNodeId = treeData.cutNodeId;
            state.cutSideNodes = treeData.cutSideNodes || new Set();
            state.extractedNodes = new Set(frame.data.extracted_nodes || []);
            state.metadata = treeData.metadata;

        } else if (frame.type === "select") {
            state.phaseLabel = frame.data.label;
            state.mergedSuperdistricts = new Set(frame.data.selected_superdistricts || []);
            state.mergedBaseNodes = new Set(frame.data.merged_base_nodes || []);
            state.supergraphEdges = frame.data.supergraph_edges || [];
            state.supergraphNodes = frame.data.supergraph_nodes || {};
            state.nodes = [];
            state.links = [];
            state.rootId = null;
            state.cutNodeId = null;
            state.cutSideNodes = new Set();
            state.metadata = null;

        } else if (frame.type === "facility") {
            state.phaseLabel = `${frame.sectionLabel}\n${frame.data.label}`;
            state.proposedCenters = frame.data.centers || {};
            state.nodes = [];
            state.links = [];
            state.rootId = null;
            state.cutNodeId = null;
            state.cutSideNodes = new Set();
            state.metadata = null;

        } else if (frame.type === "accept_reject") {
            state.phaseLabel = frame.data.label;
            state.energyProposed = frame.data.energy_proposed;
            state.energyCurrent = frame.data.energy_current;
            state.stepAccepted = frame.data.accepted;
            state.nodes = [];
            state.links = [];
            state.rootId = null;
            state.cutNodeId = null;
            state.cutSideNodes = new Set();
            // In overview mode, keep proposedCenters from facility phase
            if (state.detailLevel !== "overview") {
                state.proposedCenters = {};
            }
            state.metadata = null;
        }
    }

    // Main frame dispatcher
    async _nextFrame(state, redraw, viewManager, onStepLoaded) {
        if (!state.isPlaying) return;

        const advanced = await this._advance(state, onStepLoaded);
        if (!advanced) {
            this.pause(state);
            this.logger.log("Animation complete", "success");
            return;
        }

        redraw();

        if (state.isPlaying) {
            const isTreeCut = state.currentFrame?.type === "tree_cut";
            const delay = isTreeCut
                ? (this.config.animationDuration * 1.5) / state.animationSpeed
                : this.config.animationDuration / state.animationSpeed;
            setTimeout(() => this._nextFrame(state, redraw, viewManager, onStepLoaded), delay);
        }
    }

    async _advance(state, onStepLoaded) {
        // In overview mode: each advance = one full step (all frames applied, one render)
        if (state.detailLevel === "overview") {
            return this._advanceOverview(state, onStepLoaded);
        }

        // Advance within current step's frames
        if (state.frames && state.frameIndex < state.frames.length - 1) {
            state.frameIndex++;
            this._applyFrame(state, state.frames[state.frameIndex]);
            return true;
        }

        // Load next step
        const nextIter = state.iteration + 1;
        if (state.maxIteration && nextIter > state.maxIteration) return false;

        state.iteration = nextIter;

        // Load step assignment
        const stepData = await this.dataLoader.loadStep(nextIter);
        if (stepData) this.dataLoader.applyStepToState(stepData, state);

        // Load and flatten phases
        const phaseData = await this.dataLoader.loadPhases(nextIter);
        const frames = this._buildFrames(phaseData);
        state.frames = frames;
        state.frameIndex = 0;

        if (frames.length > 0) {
            this._applyFrame(state, frames[state.frameIndex]);
        } else {
            state.phaseLabel = `Step ${nextIter}`;
        }

        if (onStepLoaded) onStepLoaded();
        return true;
    }

    /**
     * Overview advance: load the next step and apply ALL frames so that
     * supergraph, facility, and accept_reject data all accumulate into state.
     * The renderer then composites all layers in a single draw.
     */
    async _advanceOverview(state, onStepLoaded) {
        const nextIter = state.iteration + 1;
        if (state.maxIteration && nextIter > state.maxIteration) return false;

        state.iteration = nextIter;

        // Load step assignment (districts)
        const stepData = await this.dataLoader.loadStep(nextIter);
        if (stepData) this.dataLoader.applyStepToState(stepData, state);

        // Load and flatten phases
        const phaseData = await this.dataLoader.loadPhases(nextIter);
        const frames = this._buildFrames(phaseData);
        state.frames = frames;

        // Apply every frame so all data accumulates in state
        // (select sets supergraphEdges, facility sets proposedCenters,
        //  accept_reject sets energy — overview mode keeps all of them)
        for (let i = 0; i < frames.length; i++) {
            state.frameIndex = i;
            this._applyFrame(state, frames[i]);
        }

        // Set a summary label
        if (stepData) {
            const acceptStr = state.stepAccepted ? "Accepted" : "Rejected";
            state.phaseLabel = `Step ${nextIter} — ${acceptStr}\nE = ${stepData.energy?.toFixed(1) ?? '?'}`;
        } else {
            state.phaseLabel = `Step ${nextIter}`;
        }

        if (onStepLoaded) onStepLoaded();
        return true;
    }

    // Called by next/prev buttons
    advanceOneFrame(state) {
        if (!state.frames || state.frameIndex >= state.frames.length - 1) return false;
        state.frameIndex++;
        this._applyFrame(state, state.frames[state.frameIndex]);
        return true;
    }

    retreatOneFrame(state) {
        if (!state.frames || state.frameIndex <= 0) return false;
        state.frameIndex--;
        this._applyFrame(state, state.frames[state.frameIndex]);
        return true;
    }

    async jumpToIteration(targetIter, state, redraw, viewManager, centroidMaps, onStepLoaded) {
        state.isPlaying = false;
        state.iteration = targetIter;
        this._clearPhaseState(state);

        const stepData = await this.dataLoader.loadStep(targetIter);
        if (stepData) {
            this.dataLoader.applyStepToState(stepData, state);

            const phaseData = await this.dataLoader.loadPhases(targetIter);
            const frames = this._buildFrames(phaseData);
            state.frames = frames;

            if (frames.length > 0) {
                if (state.detailLevel === "overview") {
                    // Apply all frames to accumulate supergraph + facility data
                    for (let i = 0; i < frames.length; i++) {
                        state.frameIndex = i;
                        this._applyFrame(state, frames[i]);
                    }
                    const acceptStr = state.stepAccepted ? "Accepted" : "Rejected";
                    state.phaseLabel = `Step ${targetIter} — ${acceptStr}\nE = ${stepData.energy?.toFixed(1) ?? '?'}`;
                } else {
                    // Show first frame (phase 1)
                    state.frameIndex = 0;
                    this._applyFrame(state, frames[0]);
                }
            }

            if (onStepLoaded) onStepLoaded();
            redraw();
        }
    }
}
