"""
falcomplot.mapping
==================
Interactive Leaflet mapping for facility location data.

Quickstart
----------
::

    from falcomplot import mapping

    m = mapping.build_basemap("path/to/boundary.pkl")
    mapping.add_markers(m, facilities)
    m.save("interactive_map.html")

call_data
---------
An example data module for Chicago health facilities is included temporarily.
It will move to a separate data library in a future release::

    from falcomplot.mapping import call_data

    boundary   = call_data.load_boundary()
    facilities = call_data.fetch_all()
"""

from .plott import build_basemap, add_markers, HEALTH_CATEGORIES
from . import call_data

__all__ = ["build_basemap", "add_markers", "HEALTH_CATEGORIES", "call_data"]
