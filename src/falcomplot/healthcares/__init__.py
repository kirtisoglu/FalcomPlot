"""
falcomplot.healthcares
======================
Interactive Leaflet mapping for health facility data.

Sub-modules
-----------
plott
    Map building functions: :func:`~plott.build_basemap`, :func:`~plott.add_markers`.
    Import these to build and save maps from any GeoDataFrame.

call_data
    Data fetching and caching for Chicago health facilities (OSM, Chicago
    Data Portal, Google Places, HRSA).  This module is scheduled to move to
    a separate data library in a future release.

Quickstart
----------
::

    from falcomplot.healthcares import plott, call_data

    boundary   = call_data.load_boundary()   # bundled Chicago example; pass a path for your own data
    facilities = call_data.fetch_all()

    m = plott.build_basemap(boundary)
    plott.add_markers(m, facilities)
    m.save("interactive_map.html")
"""

from . import plott
from . import call_data

__all__ = ["plott", "call_data"]
