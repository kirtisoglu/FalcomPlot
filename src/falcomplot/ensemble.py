"""
falcomplot.ensemble
===================
Ensemble and convergence diagnostics for FalcomChain runs.

This module turns the raw output of one or more chains (energy traces,
assignment snapshots) into the standard MCMC diagnostics figures:
multi-chain trace plots with burn-in shading, convergence panels with
post-burn-in distributions and the split Gelman--Rubin statistic, and
boundary (cut-edge) frequency maps over a dual graph. The statistical
helpers used by the plots (:func:`gelman_rubin`,
:func:`effective_sample_size`, :func:`cut_frequencies`) are exposed as
public functions so callers can report the numbers alongside the
figures.

All plotting functions follow the :mod:`falcomplot.grid` conventions:
they return a :class:`matplotlib.figure.Figure`, never save or show,
and accept an existing ``ax`` where a single axis suffices.

Public API
----------
:func:`gelman_rubin`
    Split Gelman--Rubin potential scale reduction factor across chains.
:func:`effective_sample_size`
    Effective sample size of one sequence (Geyer initial positive
    sequence estimator).
:func:`cut_frequencies`
    Fraction of ensemble snapshots in which each edge is cut, at
    level 1 and optionally level 2.
:func:`plot_trace`
    Multi-chain trace plot with optional burn-in shading.
:func:`plot_convergence`
    Two-panel convergence figure: traces plus post-burn-in
    distributions, annotated with the split Gelman--Rubin statistic.
:func:`plot_boundary_frequency`
    Cut-frequency map: dual-graph edges drawn between node positions,
    colored and weighted by how often the ensemble cuts them.

Typical usage
-------------
::

    from falcomplot import (
        gelman_rubin, cut_frequencies,
        plot_trace, plot_convergence, plot_boundary_frequency,
    )

    chains = [[rec["E"] for rec in run["diagnostics"]] for run in runs]
    plot_convergence(chains, burn_in=1_000, value_scale=1e-6,
                     value_label="E(s) (millions)");

    freq1, freq2 = cut_frequencies(edges, assignments, super_assignments)
    plot_boundary_frequency(edges, freq1, pos);
"""

from typing import Iterable, Mapping, Optional, Sequence, Tuple

import matplotlib.pyplot as plt


# Default colors. Callers can override per-call via the kwargs below.
# Chain series colors follow the validated categorical palette used in
# the FalCom paper figures (slots 1-4).
_DEFAULT_SERIES_COLORS = ("#2a78d6", "#1baf7a", "#eda100", "#008300")
_DEFAULT_BURNIN_COLOR = "#e1e0d9"
_DEFAULT_MUTED_COLOR = "#898781"
_DEFAULT_BACKDROP_COLOR = "#d9d8d2"


# ======================================================================
# Statistics
# ======================================================================

def gelman_rubin(chains: Sequence[Sequence[float]]) -> float:
    """
    Split Gelman--Rubin potential scale reduction factor.

    Each chain is split in half and the halves are treated as separate
    sequences, so within-chain drift also inflates the statistic
    (Gelman et al., *Bayesian Data Analysis*, 3rd ed.). Values close to
    1.0 indicate the chains are sampling the same distribution; a
    common convergence threshold is 1.01--1.1.

    Parameters
    ----------
    chains : sequence of sequences of float
        One numeric sequence per chain (e.g. post-burn-in energy
        traces). Chains are truncated to the shortest length.

    Returns
    -------
    float
        The split-:math:`\\hat R` statistic, or ``nan`` when the
        within-sequence variance is zero.

    Examples
    --------
    ::

        rhat = gelman_rubin([trace1, trace2, trace3, trace4])
    """
    import math

    half = min(len(c) for c in chains) // 2
    if half < 2:
        return float("nan")
    seqs = []
    for c in chains:
        seqs.append(list(c[:half]))
        seqs.append(list(c[half:2 * half]))
    m, n = len(seqs), half
    means = [sum(s) / n for s in seqs]
    grand = sum(means) / m
    between = n / (m - 1) * sum((mu - grand) ** 2 for mu in means)
    within = sum(
        sum((x - mu) ** 2 for x in s) / (n - 1)
        for s, mu in zip(seqs, means)
    ) / m
    if within <= 0:
        return float("nan")
    var_plus = (n - 1) / n * within + between / n
    return math.sqrt(var_plus / within)


def effective_sample_size(values: Sequence[float]) -> float:
    """
    Effective sample size of one autocorrelated sequence.

    Uses the Geyer initial positive sequence estimator: the
    autocorrelation time is accumulated over consecutive lag pairs
    while their sum remains positive, which is the standard truncation
    for reversible chains (Geyer 1992).

    Parameters
    ----------
    values : sequence of float
        One chain's post-burn-in scalar trace. For a multi-chain
        ensemble, sum the per-chain results.

    Returns
    -------
    float
        Estimated number of independent samples in ``values``.

    Examples
    --------
    ::

        ess = sum(effective_sample_size(c[burn_in:]) for c in chains)
    """
    import numpy as np

    x = np.asarray(list(values), dtype=float)
    n = x.size
    if n < 4:
        return float(n)
    x = x - x.mean()
    if not x.any():
        return float(n)
    nfft = 1 << (2 * n - 1).bit_length()
    f = np.fft.rfft(x, nfft)
    acov = np.fft.irfft(f * np.conjugate(f))[:n].real / n
    if acov[0] <= 0:
        return float(n)
    rho = acov / acov[0]
    # Geyer initial positive sequence over lag pairs (1,2), (3,4), ...
    tau = 1.0
    t = 1
    while t + 1 < n:
        pair = rho[t] + rho[t + 1]
        if pair <= 0:
            break
        tau += 2.0 * pair
        t += 2
    return float(n / max(tau, 1.0))


def cut_frequencies(
    edges: Sequence[Tuple],
    assignments: Iterable[Mapping],
    super_assignments: Optional[Iterable[Mapping]] = None,
):
    """
    Fraction of snapshots in which each edge is a district boundary.

    An edge ``(u, v)`` is *cut* at level 1 when its endpoints belong to
    different level-1 districts, and cut at level 2 when, additionally,
    those districts belong to different super-districts.

    Parameters
    ----------
    edges : sequence of tuple
        Dual-graph edges as ``(u, v)`` node pairs. Order defines the
        order of the returned frequencies.
    assignments : iterable of mapping
        One mapping ``node -> level1_district_id`` per ensemble
        snapshot.
    super_assignments : iterable of mapping, optional
        Aligned with ``assignments``: one mapping
        ``level1_district_id -> super_id`` per snapshot. When given,
        level-2 cut frequencies are computed as well.

    Returns
    -------
    list of float, or (list of float, list of float)
        Per-edge cut frequencies in ``[0, 1]``, in the order of
        ``edges``. A single list when ``super_assignments`` is
        ``None``, otherwise the ``(level1, level2)`` pair.

    Examples
    --------
    ::

        freq1, freq2 = cut_frequencies(edges, l1_snaps, l2_snaps)
        plot_boundary_frequency(edges, freq2, pos);
    """
    assignments = list(assignments)
    supers = list(super_assignments) if super_assignments is not None else None
    if supers is not None and len(supers) != len(assignments):
        raise ValueError(
            "super_assignments must align 1:1 with assignments "
            f"({len(supers)} vs {len(assignments)})"
        )
    n_snap = len(assignments)
    cut1 = [0] * len(edges)
    cut2 = [0] * len(edges)
    for i, a in enumerate(assignments):
        sup = supers[i] if supers is not None else None
        for j, (u, v) in enumerate(edges):
            du, dv = a.get(u), a.get(v)
            if du != dv:
                cut1[j] += 1
                if sup is not None and sup.get(du) != sup.get(dv):
                    cut2[j] += 1
    if n_snap == 0:
        freq1 = [0.0] * len(edges)
        freq2 = [0.0] * len(edges)
    else:
        freq1 = [c / n_snap for c in cut1]
        freq2 = [c / n_snap for c in cut2]
    return (freq1, freq2) if supers is not None else freq1


# ======================================================================
# Plots
# ======================================================================

def plot_trace(
    chains: Sequence[Sequence[float]],
    *,
    steps: Optional[Sequence[float]] = None,
    labels: Optional[Sequence[str]] = None,
    burn_in: Optional[float] = None,
    value_label: str = "E(s)",
    value_scale: float = 1.0,
    colors: Optional[Sequence[str]] = None,
    linewidth: float = 1.4,
    show_legend: bool = True,
    title: Optional[str] = None,
    figsize: Tuple[float, float] = (7.0, 3.2),
    ax=None,
):
    """
    Multi-chain trace plot with optional burn-in shading.

    Parameters
    ----------
    chains : sequence of sequences of float
        One scalar trace per chain (energy, district count, ...).
    steps : sequence of float, optional
        Common x-values for all chains. If ``None``, each chain is
        plotted against its own index ``0..len-1``.
    labels : sequence of str, optional
        Legend label per chain. Defaults to ``chain 1``, ``chain 2``,
        etc.
    burn_in : float, optional
        Shade the interval ``[0, burn_in]`` (in ``steps`` units) and
        annotate it. No shading when ``None``.
    value_label : str
        Y-axis label. Default ``"E(s)"``.
    value_scale : float
        Multiplied into every value before plotting (e.g. ``1e-6`` to
        show millions). Default ``1.0``.
    colors : sequence of str, optional
        Per-chain line colors. Defaults to the module's categorical
        series palette, cycled.
    linewidth : float
        Trace line width.
    show_legend : bool
        Draw the frameless legend. Default ``True``.
    title : str, optional
        Plot title.
    figsize : tuple of float
        Figure size when creating a new figure (ignored if ``ax``
        given).
    ax : matplotlib.axes.Axes, optional
        Existing axis to draw onto. If ``None``, creates a new figure.

    Returns
    -------
    matplotlib.figure.Figure

    Examples
    --------
    ::

        plot_trace(chains, burn_in=1_000, value_scale=1e-6,
                   value_label="E(s) (millions)");
    """
    if ax is None:
        fig, ax = plt.subplots(figsize=figsize)
    else:
        fig = ax.figure
    palette = list(colors) if colors is not None else list(_DEFAULT_SERIES_COLORS)
    if labels is None:
        labels = [f"chain {i + 1}" for i in range(len(chains))]

    for i, c in enumerate(chains):
        xs = steps if steps is not None else range(len(c))
        ax.plot(
            list(xs)[: len(c)],
            [v * value_scale for v in c],
            color=palette[i % len(palette)],
            lw=linewidth,
            label=labels[i],
        )
    if burn_in is not None and burn_in > 0:
        ax.axvspan(0, burn_in, color=_DEFAULT_BURNIN_COLOR, alpha=0.5, lw=0)
        ax.text(
            burn_in * 0.5, ax.get_ylim()[1], "burn-in",
            fontsize=8, color=_DEFAULT_MUTED_COLOR, ha="center", va="top",
        )
    ax.set_xlabel("step")
    ax.set_ylabel(value_label)
    if show_legend:
        ax.legend(frameon=False, fontsize=8, ncols=min(len(chains), 4),
                  loc="upper right")
    ax.spines[["top", "right"]].set_visible(False)
    if title:
        ax.set_title(title, fontsize=11)
    return fig


def plot_convergence(
    chains: Sequence[Sequence[float]],
    *,
    steps: Optional[Sequence[float]] = None,
    burn_in: float = 0,
    labels: Optional[Sequence[str]] = None,
    value_label: str = "E(s)",
    value_scale: float = 1.0,
    bins: int = 16,
    colors: Optional[Sequence[str]] = None,
    show_rhat: bool = True,
    title: Optional[str] = None,
    figsize: Tuple[float, float] = (10.5, 3.4),
):
    """
    Two-panel convergence figure: traces and post-burn-in distributions.

    The left panel shows every chain's trace with the burn-in interval
    shaded; the right panel shows each chain's post-burn-in values as a
    frequency polygon over shared bins, so overlapping distributions
    stay readable (a stacked histogram would not). The split
    Gelman--Rubin statistic over the post-burn-in traces is annotated
    in the right panel.

    Parameters
    ----------
    chains : sequence of sequences of float
        One scalar trace per chain, aligned with ``steps``.
    steps : sequence of float, optional
        Common x-values for all chains. If ``None``, chain indices are
        used and ``burn_in`` is interpreted as an index.
    burn_in : float
        End of the burn-in interval (in ``steps`` units). Values at or
        before it are shaded in the trace panel and excluded from the
        distribution panel and the Gelman--Rubin statistic. Default 0.
    labels : sequence of str, optional
        Legend label per chain.
    value_label : str
        Axis label for the traced quantity. Default ``"E(s)"``.
    value_scale : float
        Multiplied into every value before plotting. Default ``1.0``.
    bins : int
        Number of shared bins for the frequency polygons. Default 16.
    colors : sequence of str, optional
        Per-chain colors. Defaults to the module palette, cycled.
    show_rhat : bool
        Annotate the split Gelman--Rubin statistic. Default ``True``.
    title : str, optional
        Figure suptitle.
    figsize : tuple of float
        Figure size. Default ``(10.5, 3.4)``.

    Returns
    -------
    matplotlib.figure.Figure

    Examples
    --------
    ::

        chains = [[r["E"] for r in run["diagnostics"]] for run in runs]
        plot_convergence(chains, burn_in=1_000, value_scale=1e-6,
                         value_label="E(s) (millions)");
    """
    import numpy as np

    fig, axes = plt.subplots(
        1, 2, figsize=figsize, gridspec_kw={"width_ratios": [1.9, 1]}
    )
    palette = list(colors) if colors is not None else list(_DEFAULT_SERIES_COLORS)

    plot_trace(
        chains, steps=steps, labels=labels, burn_in=burn_in,
        value_label=value_label, value_scale=value_scale,
        colors=palette, ax=axes[0],
    )

    def _post(c):
        if steps is not None:
            return [v for s, v in zip(steps, c) if s > burn_in]
        return [v for i, v in enumerate(c) if i > burn_in]

    post = [_post(c) for c in chains]
    ax = axes[1]
    scaled = [[v * value_scale for v in c] for c in post if c]
    if scaled:
        allp = [v for c in scaled for v in c]
        edges = np.linspace(min(allp), max(allp), bins)
        centers = (edges[:-1] + edges[1:]) / 2
        for i, c in enumerate(scaled):
            hist, _ = np.histogram(c, bins=edges)
            ax.plot(centers, hist, color=palette[i % len(palette)], lw=1.4)
    ax.set_xlabel(f"{value_label} post burn-in")
    ax.set_ylabel("count")
    ax.spines[["top", "right"]].set_visible(False)
    if show_rhat and len(post) >= 2 and all(len(c) >= 4 for c in post):
        rhat = gelman_rubin(post)
        ax.text(
            0.97, 0.95, f"$\\hat R$ = {rhat:.3f}",
            transform=ax.transAxes, ha="right", va="top", fontsize=9,
            color=_DEFAULT_MUTED_COLOR,
        )
    if title:
        fig.suptitle(title, fontsize=11)
    fig.tight_layout()
    return fig


def plot_boundary_frequency(
    edges: Sequence[Tuple],
    frequencies: Sequence[float],
    pos: Mapping,
    *,
    floor: float = 0.05,
    cmap_name: str = "YlOrRd",
    ramp_floor: float = 0.35,
    show_backdrop: bool = True,
    backdrop_color: str = _DEFAULT_BACKDROP_COLOR,
    show_colorbar: bool = True,
    colorbar_label: str = "cut frequency across ensemble",
    colorbar_ax=None,
    aspect: Optional[float] = None,
    title: Optional[str] = None,
    figsize: Tuple[float, float] = (6.5, 5.2),
    ax=None,
):
    """
    Cut-frequency map over a dual graph's edges.

    Each edge is drawn as a straight segment between its endpoints'
    positions, colored on a warm single-hue ramp and weighted by its
    cut frequency, with rare cuts dropped (``floor``) and the ramp's
    lower portion skipped (``ramp_floor``) so mid frequencies stay
    visible at thin line widths. A faint backdrop of all edges keeps
    the geography readable. High-frequency edges are drawn last (on
    top).

    Parameters
    ----------
    edges : sequence of tuple
        Dual-graph edges as ``(u, v)`` node pairs.
    frequencies : sequence of float
        Per-edge cut frequency in ``[0, 1]``, aligned with ``edges``
        (see :func:`cut_frequencies`).
    pos : dict
        node -> (x, y). For geographic graphs, longitude/latitude.
    floor : float
        Edges with frequency below this are not drawn (the backdrop
        still shows them). Default 0.05.
    cmap_name : str
        Matplotlib colormap for the ramp. Default ``"YlOrRd"``.
    ramp_floor : float
        Fraction of the colormap's lower range to skip, so the
        faintest drawn edge is still visible. Default 0.35.
    show_backdrop : bool
        Draw all edges thinly underneath for geographic context.
        Default ``True``.
    backdrop_color : str
        Backdrop edge color.
    show_colorbar : bool
        Attach a colorbar mapping the (un-floored) ``[0, 1]``
        frequency range. Default ``True``.
    colorbar_label : str
        Colorbar caption.
    colorbar_ax : matplotlib axes or sequence of axes, optional
        Steal colorbar space from these axes instead of ``ax``. Pass
        all panel axes for a multi-panel figure with one shared
        colorbar, so every panel shrinks equally.
    aspect : float, optional
        Axis aspect ratio. For longitude/latitude positions use
        ``1 / cos(latitude)`` (e.g. ``1.6`` for London) so distances
        read correctly. ``None`` leaves matplotlib's default.
    title : str, optional
        Plot title.
    figsize : tuple of float
        Figure size when creating a new figure (ignored if ``ax``
        given).
    ax : matplotlib.axes.Axes, optional
        Existing axis to draw onto (e.g. for level-1/level-2 panels of
        one figure). If ``None``, creates a new figure.

    Returns
    -------
    matplotlib.figure.Figure

    Examples
    --------
    ::

        freq1, freq2 = cut_frequencies(edges, l1_snaps, l2_snaps)
        fig, axes = plt.subplots(1, 2, figsize=(12, 5.2))
        plot_boundary_frequency(edges, freq1, pos, ax=axes[0],
                                aspect=1.6, show_colorbar=False,
                                title="level-1 district boundaries");
        plot_boundary_frequency(edges, freq2, pos, ax=axes[1],
                                aspect=1.6, colorbar_ax=axes,
                                title="level-2 super-district boundaries");
    """
    import numpy as np
    from matplotlib import colors as mcolors
    from matplotlib import cm

    if len(edges) != len(frequencies):
        raise ValueError(
            f"edges and frequencies must align ({len(edges)} vs "
            f"{len(frequencies)})"
        )
    if ax is None:
        fig, ax = plt.subplots(figsize=figsize)
    else:
        fig = ax.figure

    ramp = plt.get_cmap(cmap_name)
    freq = np.asarray(list(frequencies), dtype=float)

    if show_backdrop:
        for u, v in edges:
            (x1, y1), (x2, y2) = pos[u], pos[v]
            ax.plot([x1, x2], [y1, y2], color=backdrop_color, lw=0.3,
                    zorder=1)
    for j in np.argsort(freq):
        f = freq[j]
        if f < floor:
            continue
        u, v = edges[j]
        (x1, y1), (x2, y2) = pos[u], pos[v]
        ax.plot(
            [x1, x2], [y1, y2],
            color=ramp(ramp_floor + (1 - ramp_floor) * f),
            lw=0.7 + 2.0 * f,
            solid_capstyle="round",
            zorder=2 + f,
        )
    if aspect is not None:
        ax.set_aspect(aspect)
    ax.axis("off")
    if title:
        ax.set_title(title, fontsize=11)
    if show_colorbar:
        floored = mcolors.LinearSegmentedColormap.from_list(
            "cutfreq",
            [ramp(ramp_floor + (1 - ramp_floor) * x)
             for x in np.linspace(0, 1, 64)],
        )
        sm = cm.ScalarMappable(cmap=floored, norm=plt.Normalize(0, 1))
        cbar = fig.colorbar(sm, ax=colorbar_ax if colorbar_ax is not None
                            else ax, shrink=0.75, pad=0.02)
        cbar.set_label(colorbar_label, fontsize=10)
    return fig
