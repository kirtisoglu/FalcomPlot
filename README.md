
# FalcomPlot

A visualization tool for FalcomChain, combining Python data handling with a high-performance JavaScript Animation/Plotting engine.

## Installation

```bash
pip install .
```

## Development

### Prerequisites

- Python 3.7+
- Node.js & npm (for building the JS app)

### Setup

1.  **Build the JavaScript Application**:
    ```bash
    cd js
    npm install
    npm run build
    cd ..
    ```

2.  **Install the Python Package**:
    ```bash
    pip install -e .
    ```

## Usage

```python
import falcomplot

# Launch the visualization
# falcomplot will serve the built JS app and your data directory
falcomplot.animate("path/to/your/data_directory")
```

The `animate` function launches a local server and opens your default web browser to view the visualization.

## Modules

-   **Wrapper (Python)**: `src/falcomplot` - Handles the local server and data serving.
-   **Core (JavaScript)**: `js/` - The visualization engine, bundled with Vite.

