"""
falcomplot
==========
Interactive mapping and visualization tools for FalcomChain.

Sub-packages
------------
healthcares
    Interactive Leaflet maps for health facility data.
    Contains :mod:`~falcomplot.healthcares.plott` and
    :mod:`~falcomplot.healthcares.call_data`.

Functions
---------
animate(data_path, port=0, open_browser=True)
    Launch the FalcomPlot JS visualization server.
"""

from .server import start_server
from . import healthcares
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
