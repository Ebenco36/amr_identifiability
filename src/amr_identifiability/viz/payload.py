"""Graphs to plain data for the browser explorer."""

from __future__ import annotations

import re
from typing import Iterable

import networkx as nx

from amr_identifiability.mgraph import MGraph
from amr_identifiability.models import MODEL_NAMES, NODE_DESCRIPTIONS, build_model

SCALE = 90.0  # pixels per DAGitty layout unit


def describe(node: str) -> str:
    """A readable description of a node, including the numbered upstream antibiotics."""
    if node in NODE_DESCRIPTIONS:
        return NODE_DESCRIPTIONS[node]
    m = re.fullmatch(r"(R_)?Yj(\d*)(_star)?", node)
    if m:
        which = f"upstream antibiotic {m.group(2)}" if m.group(2) else "the upstream antibiotic"
        if m.group(1):
            return f"missingness of the result for {which}"
        if m.group(3):
            return f"recorded resistance to {which}"
        return f"resistance to {which}"
    return ""


def _fallback_positions(graph: MGraph) -> dict[str, tuple[float, float]]:
    """Layered layout for nodes without DAGitty coordinates: depth down, alphabetical across."""
    g = graph.graph
    depth: dict[str, int] = {}
    for n in nx.topological_sort(g):
        depth[n] = max((depth[p] + 1 for p in g.predecessors(n)), default=0)
    layers: dict[int, list[str]] = {}
    for n, d in depth.items():
        layers.setdefault(d, []).append(n)
    out = {}
    for d, members in layers.items():
        members.sort()
        for i, n in enumerate(members):
            out[n] = ((i - (len(members) - 1) / 2) * 1.7, d * 1.5)
    return out


def model_payload(graph: MGraph, key: str | None = None, family: str | None = None, upstream: int | None = None) -> dict:
    """One graph as JSON-ready data: nodes with layout and descriptions, and edges."""
    positions = dict(graph.positions)
    missing = graph.nodes - set(positions)
    if missing:
        fallback = _fallback_positions(graph)
        if positions:  # place unplaced nodes below the existing layout
            base = max(y for _, y in positions.values()) + 2
            for n in missing:
                positions[n] = (fallback[n][0], base + fallback[n][1])
        else:
            positions = fallback
    return {
        "key": key or graph.name or "graph",
        "name": graph.name or key or "graph",
        "family": family,
        "upstream": upstream,
        "nodes": [
            {
                "id": n,
                "latent": n in graph.latent,
                "x": round(positions[n][0] * SCALE, 2),
                "y": round(positions[n][1] * SCALE, 2),
                "description": describe(n),
            }
            for n in sorted(graph.nodes)
        ],
        "edges": sorted([list(e) for e in graph.edges]),
    }


def default_models(upstream: Iterable[int] = (4, 1)) -> list[tuple[MGraph, str, str, int]]:
    """M1, M2 and M3 for each upstream count, as (graph, key, family, upstream)."""
    return [(build_model(name, n), f"{name}-{n}", name, n) for n in upstream for name in MODEL_NAMES]
