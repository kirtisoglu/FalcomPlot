"""
falcomplot.grid
===============
Static matplotlib visualizations for grid-shaped FalcomChain graphs.

This module is for the synthetic / abstract graphs FalcomChain ships
for tutorials and tests (typically ``networkx`` graphs with ``C_X``,
``C_Y``, ``candidate``, and optionally ``super_candidate`` node
attributes). For interactive maps over real geographies, use
:mod:`falcomplot.mapping`.

Public API
----------
:func:`plot_grid`
    Plot a graph with optional candidate markers, partition coloring,
    artificial-candidate highlights, and level-2 facility rings.
    Designed to cover every static grid plot the FalcomChain
    documentation needs without requiring callers to write per-page
    helpers.

Typical usage
-------------
::

    from falcomplot import plot_grid

    plot_grid(graph, title="Initial state");
    plot_grid(graph, artificial_candidates=added);
    plot_grid(graph, super_centers=state.super_facility.centers.values());
    plot_grid(graph, node_colors=zone_color_map);
"""

from typing import Iterable, Mapping, Optional, Tuple

import matplotlib.pyplot as plt
import networkx as nx


# Default colors. Callers can override per-call via the kwargs below.
_DEFAULT_OTHER_COLOR = "lightgray"
_DEFAULT_LEVEL1_COLOR = "steelblue"
_DEFAULT_LEVEL2_COLOR = "crimson"
_DEFAULT_ARTIFICIAL_COLOR = "orange"
_DEFAULT_EDGE_COLOR = "lightgray"
_DEFAULT_RING_COLOR = "black"
_SUPERDISTRICT_OUTLINE_COLOR = (100 / 255, 100 / 255, 100 / 255)  # paper "super"


def _draw_super_outlines(
    ax,
    pos: Mapping,
    mapping: Mapping,
    super_parts: Mapping,
    *,
    color_for: Mapping,
    show_labels: bool = True,
    pad: float = 0.42,
    linewidth: float = 2.5,
):
    """
    Draw a rounded outline around each super-district's footprint.

    Matches the paper-style figure (`presentation/figures/fig.tex`):
    each super-district is enclosed by a thick dark-gray polygon. We
    use the convex hull of the super-district's node positions, then
    inflate each hull vertex outward from the centroid by `pad` so the
    outline doesn't run through the nodes. Polygon line joins are
    rounded.

    Parameters
    ----------
    ax : matplotlib.axes.Axes
    pos : dict
        node -> (x, y).
    mapping : dict
        base_node -> level1_district_id.
    super_parts : dict
        super_id -> iterable of level1_district_ids.
    color_for : dict
        level1_district_id -> hex color (used only to find a label
        anchor; outline colour is fixed dark gray).
    show_labels : bool
        Annotate each super-district with its id at the polygon's
        bounding-box top.
    pad : float
        How far outward to inflate each hull vertex (in graph
        coordinates). Default 0.42 — works for unit-spaced grids.
    linewidth : float
        Outline thickness.
    """
    import matplotlib.patches as mpatches
    import numpy as np

    try:
        from scipy.spatial import ConvexHull
        _HAS_SCIPY = True
    except ImportError:  # graceful degradation: bounding rectangle
        _HAS_SCIPY = False

    # level1_id -> super_id reverse map for fast lookup
    l1_to_super = {}
    for sid, l1_ids in super_parts.items():
        for l1 in l1_ids:
            l1_to_super[l1] = sid

    # super_id -> list of base nodes
    nodes_per_super = {sid: [] for sid in super_parts}
    for n, l1 in mapping.items():
        sid = l1_to_super.get(l1)
        if sid is not None and n in pos:
            nodes_per_super[sid].append(n)

    for sid, nodes in nodes_per_super.items():
        if not nodes:
            continue
        xs = np.array([pos[n][0] for n in nodes], dtype=float)
        ys = np.array([pos[n][1] for n in nodes], dtype=float)
        cx, cy = xs.mean(), ys.mean()
        pts = np.column_stack([xs, ys])

        if _HAS_SCIPY and len(pts) >= 3:
            try:
                hull = ConvexHull(pts)
                hull_pts = pts[hull.vertices]
            except Exception:
                hull_pts = pts
        else:
            # Fall back: bounding rectangle
            hull_pts = np.array([
                [xs.min(), ys.min()],
                [xs.max(), ys.min()],
                [xs.max(), ys.max()],
                [xs.min(), ys.max()],
            ])

        # Inflate each vertex outward from the centroid by `pad`.
        outlined = []
        for x, y in hull_pts:
            dx, dy = x - cx, y - cy
            norm = (dx * dx + dy * dy) ** 0.5
            if norm < 1e-9:
                outlined.append((x, y))
            else:
                outlined.append((x + dx / norm * pad, y + dy / norm * pad))

        polygon = mpatches.Polygon(
            outlined,
            closed=True,
            fill=False,
            edgecolor=_SUPERDISTRICT_OUTLINE_COLOR,
            linewidth=linewidth,
            joinstyle="round",
            capstyle="round",
            zorder=2.5,
        )
        ax.add_patch(polygon)

        if show_labels:
            # Place the label just above the polygon's top vertex
            top_y = max(p[1] for p in outlined)
            ax.text(
                cx, top_y + 0.15,
                rf"$D^{{2}}_{{{sid}}}$",
                fontsize=9, fontweight="bold",
                color=_SUPERDISTRICT_OUTLINE_COLOR,
                ha="center", va="bottom",
            )


def plot_grid(
    graph: nx.Graph,
    *,
    title: Optional[str] = None,
    node_colors: Optional[Mapping] = None,
    artificial_candidates: Optional[Iterable] = None,
    super_centers: Optional[Iterable] = None,
    show_level1_candidates: bool = True,
    show_level2_candidates: bool = True,
    figsize: Tuple[float, float] = (5.5, 5.5),
    ax=None,
    legend: bool = True,
):
    """
    Plot a grid-style graph with optional partition coloring and
    candidate / facility overlays.

    Each node must have ``C_X`` and ``C_Y`` attributes (used for
    layout). The function reads ``candidate`` and ``super_candidate``
    node attributes to identify candidates; both default to ``0`` when
    absent.

    Parameters
    ----------
    graph : networkx.Graph
        The base graph to plot. Each node should have ``C_X``, ``C_Y``,
        ``candidate``, and optionally ``super_candidate`` attributes.
    title : str, optional
        Plot title.
    node_colors : Mapping[node, str], optional
        Per-node color override. Useful for partition / zone coloring.
        Nodes absent from this mapping fall back to the default coloring
        (gray for non-candidates).
    artificial_candidates : Iterable[node], optional
        Nodes to highlight as orange squares (e.g., synthetic candidates
        added by :func:`falcomchain.repair_facility_density`).
    super_centers : Iterable[node], optional
        Nodes to mark with a black ring (e.g., level-2 facility centers
        from ``state.super_facility.centers.values()``).
    show_level1_candidates : bool
        Render ``candidate=1`` nodes as blue circles. Default ``True``.
    show_level2_candidates : bool
        Render ``super_candidate=1`` nodes as red squares. Default
        ``True``.
    figsize : tuple of float
        Figure size in inches. Ignored when ``ax`` is provided.
    ax : matplotlib.axes.Axes, optional
        Existing axis to draw onto. If ``None``, a new figure and axis
        are created.
    legend : bool
        Show a legend. Default ``True``.

    Returns
    -------
    matplotlib.figure.Figure
        The figure containing the plot.
    """
    pos = {n: (d["C_X"], d["C_Y"]) for n, d in graph.nodes(data=True)}

    artificial_set = set(artificial_candidates or ())
    super_centers_list = list(super_centers or ())

    is_candidate = {
        n: bool(graph.nodes[n].get("candidate", 0)) for n in graph.nodes
    }
    is_super_candidate = {
        n: bool(graph.nodes[n].get("super_candidate", 0)) for n in graph.nodes
    }

    if ax is None:
        fig, ax = plt.subplots(figsize=figsize)
    else:
        fig = ax.figure

    nx.draw_networkx_edges(graph, pos, ax=ax, edge_color=_DEFAULT_EDGE_COLOR)

    # Base layer: every node, colored by node_colors override or by
    # default rule (gray for non-candidate, light blue if level-1, etc.).
    # We always paint the base layer first, then overlay candidate
    # markers so they appear on top.
    if node_colors is not None:
        # Caller-provided coloring (e.g., zones). Paint each node with
        # its color; nodes missing from the mapping use the default
        # other-color.
        per_node_color = [
            node_colors.get(n, _DEFAULT_OTHER_COLOR) for n in graph.nodes
        ]
        nx.draw_networkx_nodes(
            graph, pos, nodelist=list(graph.nodes),
            node_color=per_node_color, node_size=80, ax=ax,
        )
    else:
        # No partition coloring: just gray for non-candidate base nodes.
        # Candidate nodes are drawn below as the level-1 / level-2
        # overlays, so we exclude them here to avoid double-drawing.
        non_candidates = [
            n for n in graph.nodes
            if not (is_candidate[n] or is_super_candidate[n])
            and n not in artificial_set
        ]
        nx.draw_networkx_nodes(
            graph, pos, nodelist=non_candidates,
            node_color=_DEFAULT_OTHER_COLOR, node_size=80, ax=ax,
        )

    # Level-1 candidate overlay (blue circles).
    if show_level1_candidates:
        l1 = [
            n for n in graph.nodes
            if is_candidate[n] and n not in artificial_set
        ]
        if l1:
            nx.draw_networkx_nodes(
                graph, pos, nodelist=l1,
                node_color=_DEFAULT_LEVEL1_COLOR, node_size=170, ax=ax,
                label="level-1 candidate",
            )

    # Level-2 candidate overlay (red squares).
    if show_level2_candidates:
        l2 = [
            n for n in graph.nodes
            if is_super_candidate[n] and n not in artificial_set
        ]
        if l2:
            nx.draw_networkx_nodes(
                graph, pos, nodelist=l2,
                node_color=_DEFAULT_LEVEL2_COLOR, node_size=80,
                node_shape="s", ax=ax, label="level-2 candidate",
            )

    # Artificial candidate overlay (orange squares).
    if artificial_set:
        nx.draw_networkx_nodes(
            graph, pos, nodelist=list(artificial_set),
            node_color=_DEFAULT_ARTIFICIAL_COLOR, node_size=140,
            node_shape="s", ax=ax, label="artificial candidate",
        )

    # Level-2 facility center rings.
    if super_centers_list:
        nx.draw_networkx_nodes(
            graph, pos, nodelist=super_centers_list,
            node_color="none", edgecolors=_DEFAULT_RING_COLOR,
            linewidths=2.0, node_size=260, ax=ax,
            label="selected level-2 facility",
        )

    if title:
        ax.set_title(title)
    ax.set_aspect("equal")
    if legend:
        # Only show legend when at least one labeled artist was added.
        handles, labels = ax.get_legend_handles_labels()
        if handles:
            # Place the legend outside the plot, to the right of the grid,
            # vertically centered. Keeps the grid visible and avoids the
            # legend obscuring nodes near the corners on dense plots.
            ax.legend(
                loc="center left",
                bbox_to_anchor=(1.02, 0.5),
                fontsize=8,
                frameon=True,
                borderaxespad=0.0,
            )
    ax.axis("off")
    fig.tight_layout()
    return fig


# ===========================================================================
# Partition visualization (district coloring) and chain animation.
# ===========================================================================

def plot_partition(
    graph: nx.Graph,
    partition,
    *,
    title: Optional[str] = None,
    figsize: Tuple[float, float] = (5.5, 5.5),
    ax=None,
    centers=None,
    super_centers=None,
    show_centers: bool = True,
    show_super_centers: bool = True,
    show_super_boundaries: bool = True,
    show_super_labels: bool = True,
    show_team_counts: bool = True,
    show_all_candidates: bool = False,
    show_boundaries: bool = False,
    cmap_name: str = "tab20",
    demand_target: Optional[float] = None,
    c_min: Optional[int] = None,
    c_max: Optional[int] = None,
    epsilon: Optional[float] = None,
    demand_target_super: Optional[float] = None,
    c_min_super: Optional[int] = None,
    c_max_super: Optional[int] = None,
    epsilon_super: Optional[float] = None,
):
    """
    Plot a graph with each level-1 district shown in a distinct color.

    Per-district color already encodes the partition, so district
    boundaries are off by default. The visual emphasis is on the
    *assigned* facility center per district (one node per district),
    rendered as a black-bordered star — this is the operationally
    meaningful overlay for a partition. The full candidate set is
    available via ``show_all_candidates=True`` for diagnostic plots.

    Parameters
    ----------
    graph : networkx.Graph
        Base graph with ``C_X``, ``C_Y`` node attributes.
    partition
        Object exposing ``partition.assignment.mapping`` (a dict
        ``node -> district_id``). FalcomChain ``Partition`` instances
        satisfy this. If the object also exposes ``.facility.centers``
        (e.g. a ``ChainState``), centers are inferred automatically.
    title : str, optional
        Plot title.
    figsize : tuple of float
        Figure size when creating a new figure (ignored if ``ax`` given).
    ax : matplotlib.axes.Axes, optional
        Existing axis to draw onto. If ``None``, creates a new figure.
    centers : dict, optional
        Map ``level1_district_id -> facility_node`` for the assigned
        level-1 facility in each district. If ``None``, attempts to
        read from ``partition.facility.centers`` (works when
        ``partition`` is a ``ChainState``).
    super_centers : dict, optional
        Map ``superdistrict_id -> super_facility_node`` for the
        assigned level-2 facility in each superdistrict. If ``None``,
        attempts to read from ``partition.super_facility.centers``.
        Drawn as a larger diamond with a thick black border.
    show_centers : bool
        Overlay assigned level-1 facility centers as black-bordered
        stars coloured by district. Default ``True``.
    show_super_centers : bool
        Overlay assigned level-2 facility centers as larger diamonds.
        Default ``True`` (no-op if ``super_centers`` is unavailable).
    show_super_boundaries : bool
        Outline level-2 superdistrict boundaries with thick black
        edges. Drawn only when the partition has a non-trivial
        super-assignment (more level-1 districts than superdistricts).
        Default ``True``.
    show_team_counts : bool
        Annotate each assigned-facility star with its district's team
        count (read from ``partition.assignment.teams[district]``).
        Default ``True`` (no-op if ``show_centers`` is False or teams
        dict is unavailable).
    show_all_candidates : bool
        Overlay every node with ``candidate=1`` as a small white-filled
        circle (faded). Useful for diagnostic plots; off by default
        because the assigned-center overlay carries the operational
        information. Default ``False``.
    show_boundaries : bool
        Thicken cross-level-1-district edges to make level-1 boundaries
        visible. Default ``False`` — district colours already convey
        the same information without visual clutter. Set ``True`` for
        plots where level-1 boundary topology is the focus. Independent
        of ``show_super_boundaries``.
    cmap_name : str
        Name of the matplotlib colormap used to assign per-district
        colors. ``tab20`` (default) handles up to 20 districts cleanly.
    demand_target, c_min, c_max, epsilon : optional numeric parameters
        Partition regime metadata. When any of these are supplied, a
        small annotation box is rendered to the **right** of the plot
        showing the regime: ``d̄ = …, ε = …, c_min = …, c_max = …``
        (``d̄`` is the per-team demand target, paper symbol ``w``).
        Read the partition's ``capacity_level`` for ``c_max`` if the
        param is not provided and the partition exposes it.

    Returns
    -------
    matplotlib.figure.Figure
    """
    import matplotlib
    import matplotlib.colors as mcolors

    mapping = partition.assignment.mapping
    distinct = sorted(set(mapping.values()))
    # matplotlib.cm.get_cmap was removed in matplotlib 3.9; use the
    # colormap registry, which is stable across 3.6+.
    cmap = matplotlib.colormaps[cmap_name].resampled(max(len(distinct), 1))
    color_for = {d: mcolors.to_hex(cmap(i)) for i, d in enumerate(distinct)}
    node_colors = {n: color_for[mapping[n]] for n in graph.nodes if n in mapping}

    # Resolve centers: explicit kwarg > partition.facility.centers > none
    if centers is None:
        facility = getattr(partition, "facility", None)
        if facility is not None:
            centers = getattr(facility, "centers", None)

    # Resolve super-centers similarly
    if super_centers is None:
        super_facility = getattr(partition, "super_facility", None)
        if super_facility is not None:
            super_centers = getattr(super_facility, "centers", None)

    # Resolve teams dict for per-district capacity labels
    teams = None
    assignment = getattr(partition, "assignment", None)
    if assignment is not None:
        teams = getattr(assignment, "teams", None)

    # Resolve super_assignment for boundary drawing (level1 -> super_id)
    super_assignment = None
    super_parts = None
    inner = getattr(partition, "partition", partition)  # ChainState -> Partition
    super_assignment = getattr(inner, "super_assignment", None)
    super_parts = getattr(inner, "super_parts", None)

    # Decide if level-2 is meaningful: more level-1 districts than super-districts
    has_meaningful_l2 = (
        super_parts is not None
        and len(super_parts) > 0
        and len(super_parts) < len(set(mapping.values()))
    )

    # Fall back to partition.capacity_level for c_max if user didn't pass it
    if c_max is None:
        c_max = getattr(partition, "capacity_level", None)

    if ax is None:
        fig, ax = plt.subplots(figsize=figsize)
    else:
        fig = ax.figure

    pos = {n: (d["C_X"], d["C_Y"]) for n, d in graph.nodes(data=True)}

    # Edge drawing — light grey, optionally with level-1 boundaries thickened.
    if show_boundaries:
        intra = [(u, v) for u, v in graph.edges() if mapping.get(u) == mapping.get(v)]
        inter = [(u, v) for u, v in graph.edges() if mapping.get(u) != mapping.get(v)]
        nx.draw_networkx_edges(graph, pos, edgelist=intra, edge_color="lightgray",
                               width=0.5, ax=ax)
        nx.draw_networkx_edges(graph, pos, edgelist=inter, edge_color="black",
                               width=1.0, ax=ax)
    else:
        nx.draw_networkx_edges(graph, pos, ax=ax, edge_color="lightgray", width=0.5)

    nx.draw_networkx_nodes(
        graph, pos, nodelist=list(graph.nodes),
        node_color=[node_colors.get(n, _DEFAULT_OTHER_COLOR) for n in graph.nodes],
        node_size=60, ax=ax, edgecolors="white", linewidths=0.4,
    )

    # Level-2 super-district outlines as rounded convex-hull polygons,
    # paper-style (see presentation/figures/fig.tex).
    if show_super_boundaries and has_meaningful_l2:
        _draw_super_outlines(
            ax, pos, mapping, super_parts,
            color_for=color_for,
            show_labels=show_super_labels,
        )

    # Faded background for all candidate sites (off by default).
    if show_all_candidates:
        all_cand = [n for n, d in graph.nodes(data=True) if d.get("candidate")]
        if all_cand:
            nx.draw_networkx_nodes(
                graph, pos, nodelist=all_cand,
                node_color="white",
                node_size=110, ax=ax,
                edgecolors="dimgray", linewidths=0.8,
                label="candidate site",
            )

    # Level-2 facility per super-district — hollow circle, drawn BEFORE
    # the level-1 stars so the star sits visually on top of the ring
    # when the two markers coincide (concentric "star inside a ring").
    if show_super_centers and super_centers:
        super_nodes = [
            c for c in super_centers.values()
            if c is not None and c in graph.nodes
        ]
        if super_nodes:
            nx.draw_networkx_nodes(
                graph, pos, nodelist=super_nodes,
                node_color="white",
                node_shape="o",
                node_size=720, ax=ax,
                edgecolors="black", linewidths=2.0,
                label="assigned super-facility",
            )

    # Assigned facility per district — the headline overlay.
    if show_centers and centers:
        # Build (district_id, center_node) pairs so we can label each.
        center_pairs = [
            (d, c) for d, c in centers.items()
            if c is not None and c in graph.nodes
        ]
        if center_pairs:
            center_nodes = [c for _, c in center_pairs]
            center_colors = [
                color_for.get(d, _DEFAULT_OTHER_COLOR)
                for d, _ in center_pairs
            ]
            nx.draw_networkx_nodes(
                graph, pos, nodelist=center_nodes,
                node_color=center_colors,
                node_shape="*",
                node_size=320, ax=ax,
                edgecolors="black", linewidths=1.5,
                label="assigned facility",
            )

            # Annotate each center with its district's team count.
            if show_team_counts and teams:
                for d, c in center_pairs:
                    t = teams.get(d)
                    if t is None:
                        continue
                    x, y = pos[c]
                    ax.annotate(
                        str(t),
                        xy=(x, y),
                        xytext=(6, 6),
                        textcoords="offset points",
                        fontsize=9, fontweight="bold",
                        color="black",
                        bbox=dict(
                            boxstyle="round,pad=0.15",
                            facecolor="white", edgecolor="black",
                            linewidth=0.6, alpha=0.9,
                        ),
                    )

    # Regime annotation — placed to the right of the plot. When level-2
    # parameters are provided alongside level-1, both are shown with
    # superscripts (¹/²) per paper notation.
    regime_parts = []
    has_l2 = any(
        v is not None for v in
        (demand_target_super, epsilon_super, c_min_super, c_max_super)
    )

    def _line(symbol, l1, l2, fmt="g"):
        if l1 is None and l2 is None:
            return None
        # Build with explicit superscripts only when level-2 is given.
        if has_l2:
            l1_str = f"{l1:{fmt}}" if l1 is not None else "-"
            l2_str = f"{l2:{fmt}}" if l2 is not None else "-"
            # Keep the entire expression inside mathtext so '=' and '-'
            # render in the same math font (avoids literal "\!-" leaks).
            return rf"${symbol}^1 = {l1_str}, \quad {symbol}^2 = {l2_str}$"
        if l1 is None:
            return None
        return rf"${symbol} = {l1:{fmt}}$"

    line = _line(r"\bar{d}", demand_target, demand_target_super)
    if line:
        regime_parts.append(line)
    line = _line(r"\varepsilon", epsilon, epsilon_super)
    if line:
        regime_parts.append(line)
    line = _line(r"c_{\min}", c_min, c_min_super, fmt="d") if (
        c_min is not None or c_min_super is not None
    ) else None
    if line:
        regime_parts.append(line)
    line = _line(r"c_{\max}", c_max, c_max_super, fmt="d") if (
        c_max is not None or c_max_super is not None
    ) else None
    if line:
        regime_parts.append(line)
    if regime_parts:
        ax.text(
            1.04, 0.5, "\n".join(regime_parts),
            transform=ax.transAxes,
            fontsize=10,
            verticalalignment="center", horizontalalignment="left",
            clip_on=False,
            bbox=dict(
                boxstyle="round,pad=0.45",
                facecolor="white", edgecolor="lightgray",
                linewidth=0.6, alpha=0.95,
            ),
        )
        # Reserve space on the right so the box doesn't get clipped.
        fig.subplots_adjust(right=0.78)

    if title:
        ax.set_title(title)
    ax.set_aspect("equal")
    ax.axis("off")
    # tight_layout would override subplots_adjust; only call when no regime box
    if not regime_parts:
        fig.tight_layout()
    return fig


def animate_chain(
    graph: nx.Graph,
    partitions: Iterable,
    *,
    interval: int = 400,
    figsize: Tuple[float, float] = (5.5, 5.5),
    title_fn=None,
    centers_fn=None,
    super_centers_fn=None,
    show_centers: bool = True,
    show_super_centers: bool = True,
    show_super_boundaries: bool = True,
    show_super_labels: bool = True,
    show_team_counts: bool = True,
    show_all_candidates: bool = False,
    show_boundaries: bool = False,
    cmap_name: str = "tab20",
    demand_target: Optional[float] = None,
    c_min: Optional[int] = None,
    c_max: Optional[int] = None,
    epsilon: Optional[float] = None,
    demand_target_super: Optional[float] = None,
    c_min_super: Optional[int] = None,
    c_max_super: Optional[int] = None,
    epsilon_super: Optional[float] = None,
):
    """
    Build a matplotlib FuncAnimation over a sequence of partitions.

    The returned animation works in Jupyter / MyST-NB via ``to_jshtml()``
    or by simply returning it from a notebook cell — myst-nb embeds the
    HTML5 video inline in the docs.

    Parameters
    ----------
    graph
        Base graph.
    partitions
        Iterable of partition-like objects (each with
        ``.assignment.mapping``). Snapshots taken from a
        :class:`MarkovChain` are typical.
    interval
        Milliseconds between frames. Default 400.
    title_fn : callable, optional
        ``(frame_index) -> str`` for per-frame titles. Default
        produces ``"step {i}"``.
    centers_fn : callable, optional
        ``(partition) -> dict[district_id, node]`` returning the
        assigned facility centers for the given partition. If ``None``,
        :func:`plot_partition` falls back to
        ``partition.facility.centers`` if available, else no center
        overlay.
    show_centers, show_team_counts, show_all_candidates, show_boundaries,
    cmap_name, demand_target, c_min, c_max, epsilon
        Forwarded to :func:`plot_partition`.

    Returns
    -------
    matplotlib.animation.FuncAnimation
    """
    from matplotlib import animation

    partitions = list(partitions)
    if not partitions:
        raise ValueError("animate_chain: need at least one partition")

    if title_fn is None:
        title_fn = lambda i: f"step {i}"

    fig, ax = plt.subplots(figsize=figsize)

    def update(frame_index):
        ax.clear()
        partition = partitions[frame_index]
        centers = centers_fn(partition) if centers_fn else None
        super_centers = (
            super_centers_fn(partition) if super_centers_fn else None
        )
        plot_partition(
            graph, partition,
            title=title_fn(frame_index),
            ax=ax,
            centers=centers,
            super_centers=super_centers,
            show_centers=show_centers,
            show_super_centers=show_super_centers,
            show_super_boundaries=show_super_boundaries,
            show_super_labels=show_super_labels,
            show_team_counts=show_team_counts,
            show_all_candidates=show_all_candidates,
            show_boundaries=show_boundaries,
            cmap_name=cmap_name,
            demand_target=demand_target,
            c_min=c_min, c_max=c_max, epsilon=epsilon,
            demand_target_super=demand_target_super,
            c_min_super=c_min_super, c_max_super=c_max_super,
            epsilon_super=epsilon_super,
        )
        return []

    anim = animation.FuncAnimation(
        fig, update,
        frames=len(partitions),
        interval=interval,
        blit=False,
        repeat=True,
    )
    plt.close(fig)  # so myst-nb doesn't render the static figure too
    return anim
