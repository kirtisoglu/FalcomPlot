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
"""

from .plott import build_basemap, add_hierarchy, add_markers, HEALTH_CATEGORIES

__all__ = ["build_basemap", "add_hierarchy", "add_markers", "HEALTH_CATEGORIES"]
