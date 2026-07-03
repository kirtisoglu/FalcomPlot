"""
falcomplot.geo
==============
Static matplotlib maps for real geographic instances.

This module is for GeoDataFrames of geographic units (census areas,
LSOAs, ZIP codes) — the inputs FalcomChain builds its graphs from.
For synthetic grid graphs use :mod:`falcomplot.grid`; for interactive
Leaflet maps use :mod:`falcomplot.mapping`.

Public API
----------
:func:`plot_units`
    Plot the unit polygons with an optional dissolved outer boundary.
:func:`plot_dual_graph`
    Plot the (rook-adjacency) dual graph — one node per unit, one edge
    per adjacent pair — optionally over the polygons as a backdrop.

Typical usage
-------------
::

    import geopandas as gpd
    import falcomplot as fp

    gdf = gpd.read_file("units.geojson")
    fp.plot_units(gdf, title="Study region");
    fp.plot_dual_graph(gdf, edges, id_col="GEOID");
"""

from typing import Iterable, Optional, Sequence, Tuple

import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection

_DEFAULT_FACECOLOR = "#eef0f4"
_DEFAULT_EDGECOLOR = "#9aa3b5"
_DEFAULT_BOUNDARY_COLOR = "#1a1f2b"
_DEFAULT_NODE_COLOR = "#14213d"
_DEFAULT_GRAPH_EDGE_COLOR = "#4a5568"


def _outer_boundary(gdf):
    """
    Dissolved exterior boundary of all unit polygons, as a GeoSeries.

    Only the exterior rings of non-sliver parts are kept, so unioning
    simplified polygons (whose tiny gaps become interior holes and
    speckle) still yields a clean outline.
    """
    import geopandas as gpd
    from shapely.geometry import LineString, MultiPolygon

    try:
        union = gdf.geometry.union_all()
    except AttributeError:  # geopandas < 1.0
        union = gdf.geometry.unary_union
    parts = list(union.geoms) if isinstance(union, MultiPolygon) else [union]
    cutoff = 1e-6 * sum(p.area for p in parts)
    rings = [LineString(p.exterior) for p in parts if p.area > cutoff]
    return gpd.GeoSeries(rings, crs=gdf.crs)


def _resolve_boundary(gdf, boundary):
    """Turn the ``boundary`` argument into a plottable GeoSeries or None."""
    if boundary is None or boundary is False:
        return None
    if boundary is True:
        return _outer_boundary(gdf)
    return boundary.geometry if hasattr(boundary, "geometry") else boundary


def _new_axes(figsize):
    fig, ax = plt.subplots(figsize=figsize)
    return ax


def plot_units(
    gdf,
    *,
    boundary: bool = True,
    facecolor: str = _DEFAULT_FACECOLOR,
    edgecolor: str = _DEFAULT_EDGECOLOR,
    linewidth: float = 0.25,
    boundary_color: str = _DEFAULT_BOUNDARY_COLOR,
    boundary_linewidth: float = 1.3,
    title: Optional[str] = None,
    figsize: Tuple[float, float] = (8.0, 6.5),
    ax=None,
):
    """
    Plot geographic unit polygons with an optional dissolved boundary.

    Parameters
    ----------
    gdf:
        GeoDataFrame of unit polygons.
    boundary:
        ``True`` (default) dissolves ``gdf`` and draws the outer
        boundary of the study region on top of the units; ``False``
        draws none; a GeoSeries/GeoDataFrame is drawn as given (use
        this when you have a boundary from full-resolution geometry).
    facecolor, edgecolor, linewidth:
        Styling for the unit polygons.
    boundary_color, boundary_linewidth:
        Styling for the dissolved outer boundary.
    title:
        Optional axes title.
    figsize:
        Figure size when ``ax`` is not supplied.
    ax:
        Existing matplotlib axes to draw into.

    Returns
    -------
    matplotlib.axes.Axes
    """
    if ax is None:
        ax = _new_axes(figsize)

    gdf.plot(ax=ax, facecolor=facecolor, edgecolor=edgecolor,
             linewidth=linewidth)
    outline = _resolve_boundary(gdf, boundary)
    if outline is not None:
        outline.plot(ax=ax, color=boundary_color,
                     linewidth=boundary_linewidth)

    ax.set_axis_off()
    if title:
        ax.set_title(title)
    return ax


def _rook_edges(gdf) -> list:
    """
    Compute rook-adjacency index pairs from polygon geometry.

    Two units are adjacent when their geometries intersect in more
    than a point (shared boundary length > 0). Positional indices
    into ``gdf`` are returned. Note that pre-simplified geometry can
    open gaps between true neighbors — prefer passing edges computed
    from full-resolution data when you have them.
    """
    sindex = gdf.sindex
    geoms = gdf.geometry.values
    edges = set()
    for i, geom in enumerate(geoms):
        for j in sindex.query(geom, predicate="intersects"):
            j = int(j)
            if j <= i:
                continue
            inter = geom.intersection(geoms[j])
            if inter.length > 0:
                edges.add((i, j))
    return sorted(edges)


def plot_dual_graph(
    gdf,
    edges: Optional[Iterable[Sequence]] = None,
    *,
    id_col: Optional[str] = None,
    backdrop: bool = True,
    boundary: bool = True,
    facecolor: str = "#f5f6f8",
    node_size: float = 1.6,
    node_color: str = _DEFAULT_NODE_COLOR,
    edge_color: str = _DEFAULT_GRAPH_EDGE_COLOR,
    edge_linewidth: float = 0.3,
    boundary_color: str = _DEFAULT_BOUNDARY_COLOR,
    boundary_linewidth: float = 1.3,
    title: Optional[str] = None,
    figsize: Tuple[float, float] = (8.0, 6.5),
    ax=None,
):
    """
    Plot the dual graph of a set of geographic units.

    One node per unit (placed at its representative point), one edge
    per adjacent pair — the graph FalcomChain's proposals operate on.

    Parameters
    ----------
    gdf:
        GeoDataFrame of unit polygons.
    edges:
        Iterable of ``(u, v)`` pairs. When ``id_col`` is given, ``u``
        and ``v`` are values of that column; otherwise they are values
        of ``gdf.index``. When omitted, rook adjacency is computed
        from the geometry (see :func:`_rook_edges` for the caveat on
        simplified polygons).
    id_col:
        Column of ``gdf`` that the edge pairs refer to.
    backdrop:
        Draw the unit polygons faintly underneath (default ``True``).
    boundary:
        Same contract as in :func:`plot_units`: ``True`` dissolves
        ``gdf``, ``False`` draws none, a GeoSeries/GeoDataFrame is
        drawn as given.
    facecolor:
        Backdrop fill color.
    node_size, node_color, edge_color, edge_linewidth:
        Styling for the graph.
    boundary_color, boundary_linewidth:
        Styling for the dissolved outer boundary.
    title:
        Optional axes title.
    figsize:
        Figure size when ``ax`` is not supplied.
    ax:
        Existing matplotlib axes to draw into.

    Returns
    -------
    matplotlib.axes.Axes
    """
    if ax is None:
        ax = _new_axes(figsize)

    if backdrop:
        gdf.plot(ax=ax, facecolor=facecolor, edgecolor="none")
    outline = _resolve_boundary(gdf, boundary)
    if outline is not None:
        outline.plot(ax=ax, color=boundary_color,
                     linewidth=boundary_linewidth)

    pts = gdf.geometry.representative_point()
    xs, ys = pts.x.values, pts.y.values

    if edges is None:
        pairs = _rook_edges(gdf)
    else:
        if id_col is not None:
            lookup = {key: i for i, key in enumerate(gdf[id_col].values)}
        else:
            lookup = {key: i for i, key in enumerate(gdf.index)}
        pairs = [(lookup[u], lookup[v]) for u, v in edges]

    segments = [((xs[i], ys[i]), (xs[j], ys[j])) for i, j in pairs]
    ax.add_collection(LineCollection(
        segments, colors=edge_color, linewidths=edge_linewidth, zorder=3,
    ))
    ax.scatter(xs, ys, s=node_size, c=node_color, zorder=4, linewidths=0)

    ax.set_axis_off()
    if title:
        ax.set_title(title)
    return ax
