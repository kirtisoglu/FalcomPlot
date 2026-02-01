// All constants and configuration
export const CONFIG = {
    rootOuterPx: 12,
    rootInset: 0.5,
    nodeRadiusPx: 2,
    nodeStrokePx: 1,
    haloPx: 0,
    colors: {
        greenFill: "#00e676",
        greenStroke: "rgba(255,255,255,0.95)",
        redFill: "#ff5252",
        redStroke: "rgba(255,255,255,0.6)",
        rootFill: "#ffd54f",
        rootStroke: "#333",
        linkStroke: "rgba(255,255,255,0.85)",
        blockFill: "rgba(80,80,80,0.7)",      // Lighter gray, more opaque for visibility
        blockStroke: "rgba(180,180,180,0.9)", // Much lighter stroke for clear boundaries
    },
    animationDuration: 400,
    framePadding: 40,
    highlightFlashDuration: 600,
    debug: false,
};

export const VISUAL = {
    blockLineWidth: 0.5,
    linkLineWidth: 0.7,
    rootLineWidth: 1.4,
};