"""
falcomplot
==========
Interactive mapping and visualization tools for FalcomChain.

Sub-packages
------------
mapping
    Interactive Leaflet maps for facility location data.
    Use ``mapping.build_basemap()`` and ``mapping.add_markers()``.

Functions
---------
animate(data_path, port=0, open_browser=True)
    Launch the FalcomPlot JS visualization server.

Modules
-------
grid
    Static matplotlib figures for grid-shaped graphs
    (``plot_grid``, ``plot_partition``, ``animate_chain``).
ensemble
    Ensemble and convergence diagnostics (``plot_trace``,
    ``plot_convergence``, ``plot_boundary_frequency``,
    ``gelman_rubin``, ``effective_sample_size``,
    ``cut_frequencies``).
"""

from .server import start_server
from . import mapping
from .grid import animate_chain, plot_grid, plot_partition
from .ensemble import (
    cut_frequencies,
    effective_sample_size,
    gelman_rubin,
    plot_boundary_frequency,
    plot_convergence,
    plot_trace,
)
import os


def animate(data_path, port=0, open_browser=True):
    """Launch the FalcomPlot visualization server.

    Parameters
    ----------
    data_path:
        Path to the directory containing the data files (blocks.json, etc.).
    port:
        Port to run the server on. ``0`` lets the OS pick a free port.
    open_browser:
        Whether to open the default web browser automatically.

    Raises
    ------
    FileNotFoundError
        If ``data_path`` does not exist.
    """
    if not os.path.exists(data_path):
        raise FileNotFoundError(f"Data path not found: {data_path}")
    start_server(data_path, port=port, open_browser=open_browser)
