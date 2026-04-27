# FalcomPlot

Interactive visualization for [FalcomChain](https://github.com/kirtisoglu/FalcomChain) MCMC runs. Animates the Markov chain step by step on a Canvas-based map, showing district assignments, facility candidates, spanning trees, and cut selection.

## What it shows

- **District mode**: Blocks colored by district assignment. Gold stars mark facility candidate nodes. Step through the chain to see districts shift as proposals are accepted/rejected.
- **Tree mode**: Spanning tree edges overlaid on the map. Root node (gold star), cut node (red diamond), and tree edges (white lines). Substeps within each chain iteration are animated — you see each bipartition call.
- **Metadata sidebar**: Step number, energy, acceptance status, psi scores, number of admissible cuts.

## Data format

FalcomPlot reads output from FalcomChain's `Recorder`. The `data/` directory should contain:

```
data/
  manifest.json          # chain metadata, node coordinates, candidate flags
  blocks.json            # GeoJSON with block geometries
  step_0001.json         # per-step: assignment, energy, accepted, changed_nodes
  step_0002.json
  ...
  substeps/              # optional: tree animation data
    substeps_0001.json   # per-step: list of bipartition substeps with tree edges
    ...
```

### Generating data from FalcomChain

```python
from falcomchain.tree.snapshot import Recorder

# During chain run
recorder = Recorder("output/", record_substeps=True)
recorder.write_header(graph, partition, params)
# ... chain runs, recorder.record_step() called automatically ...
recorder.close()

# Export to JSON for FalcomPlot
Recorder.export_to_json("output/", "output/json/")
# Copy output/json/* and blocks.json to FalcomPlot/js/data/
```

Or use the demo script:
```bash
cd /path/to/FalcomChain
python -m experiments.demo
# Output in experiments/demo_output/json/
```

### File schemas

**manifest.json**
```json
{
  "total_steps": 100,
  "graph_nodes": 100,
  "parameters": {"epsilon": 0.2, "demand_target": 500, ...},
  "node_coordinates": {"(0, 0)": [0.0, 0.0], ...},
  "node_candidates": {"(0, 0)": false, "(1, 2)": true, ...}
}
```

**step_NNNN.json**
```json
{
  "step": 42,
  "accepted": true,
  "energy": 8850.0,
  "log_proposal_ratio": -0.12,
  "assignment": {"(0, 0)": "1", "(0, 1)": "1", ...},
  "changed_nodes": {"(3, 4)": "2", ...},
  "districts": {"1": {"nodes": 15, "demand": 750}, ...}
}
```

**substeps/substeps_NNNN.json**
```json
[
  {
    "root": "6",
    "cut_node": "7",
    "psi_chosen": 2.0,
    "psi_total": 5.0,
    "n_cuts": 3,
    "edges": [["6", "1"], ["1", "3"], ...]
  },
  ...
]
```

**blocks.json** — Standard GeoJSON FeatureCollection. Each feature needs:
- `properties.id` — node ID (must match keys in manifest/step files)
- `geometry` — Polygon coordinates for rendering

## Running locally

### Prerequisites
- Node.js 18+
- npm

### Development server
```bash
cd js
npm install
npx vite --port 5173
```
Open http://localhost:5173

### With Python server
```bash
pip install -e .
python -c "import falcomplot; falcomplot.animate('path/to/data')"
```

## Controls

| Control | Action |
|---------|--------|
| Play | Animate forward through chain steps |
| Pause | Stop animation, keep current frame |
| Stop | Reset to step 0 |
| Final | Jump to last step |
| Go to step | Type a number, click Go |
| Speed slider | 0.5x to 3x playback speed |
| Switch to Tree/District | Toggle between district coloring and tree visualization |
| Colored/Uncolored | Toggle district fill vs boundary-only view |
| Mouse drag | Pan the view |
| Scroll wheel | Zoom in/out |
| Right-drag | Rotate |
| Hover (district mode) | Highlight district, show metadata |

## Architecture

```
js/
  main.js                  # State, UI event handlers, initialization
  js/
    config.js              # Colors, sizes, animation timing
    logger.js              # Console + UI status output
    dataLoader.js          # Fetch manifest, steps, substeps, blocks
    renderer.js            # Canvas 2D drawing (blocks, districts, trees, candidates)
    animationController.js # Frame stepping, substep cycling, jump-to
    viewManager.js         # Pan, zoom, auto-center
    inputHandler.js        # Mouse/wheel listeners, tooltips
    toleranceChecker.js    # Population tolerance validation
    geometry.js            # Centroid calculation
src/falcomplot/
  __init__.py              # Public API: animate()
  server.py                # HTTP server routing data/ and web assets
```

## License

MIT
