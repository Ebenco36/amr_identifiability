"""Every minimal d-separating set between two nodes.

A set Z is a minimal d-separator of x and y if x _||_ y | Z holds in the DAG and no proper
subset of Z (that still contains the required nodes) separates them.

Method
  1. Minimal separators lie inside the ancestral set An(x, y, required)
     (van der Zander, Liskiewicz & Textor 2019, Lemma 3.4), and there d-separation equals
     vertex separation in the moral graph of that ancestral set (Lauritzen et al. 1990).
  2. Required nodes are removed from the moral graph; nodes that may not be conditioned on
     (latent nodes, for example) are eliminated, joining their neighbours, so paths through
     them can never be blocked.
  3. The minimal x-y vertex separators of the resulting undirected graph are listed with the
     close-separator algorithm (Berry, Bordat & Cogis 1999; Kloks & Kratsch 1998).

The tests compare this against brute-force subset search on random graphs.
"""

from __future__ import annotations

from collections import deque
from typing import Iterable

import networkx as nx

Adjacency = dict[str, set[str]]


def ancestral_closure(graph: nx.DiGraph, nodes: Iterable[str]) -> set[str]:
    """The nodes and all their ancestors."""
    out = set(nodes)
    stack = list(out)
    while stack:
        for parent in graph.predecessors(stack.pop()):
            if parent not in out:
                out.add(parent)
                stack.append(parent)
    return out


def moral_graph(graph: nx.DiGraph, nodes: set[str]) -> Adjacency:
    """Moral graph of the subgraph induced by an ancestral set: skeleton plus married parents."""
    adj: Adjacency = {n: set() for n in nodes}
    for child in nodes:
        parents = [p for p in graph.predecessors(child) if p in nodes]
        for p in parents:
            adj[p].add(child)
            adj[child].add(p)
        for i, p in enumerate(parents):
            for q in parents[i + 1:]:
                adj[p].add(q)
                adj[q].add(p)
    return adj


def eliminate(adj: Adjacency, nodes: Iterable[str]) -> Adjacency:
    """Remove nodes, joining every pair of remaining nodes linked through them.

    Two remaining nodes become adjacent when they both border the same connected group of
    eliminated nodes, so separation among sets that avoid the eliminated nodes is unchanged.
    """
    gone = set(nodes) & set(adj)
    out = {n: {m for m in adj[n] if m not in gone} for n in adj if n not in gone}
    seen: set[str] = set()
    for start in gone:
        if start in seen:
            continue
        group, border, stack = {start}, set(), [start]
        while stack:
            for m in adj[stack.pop()]:
                if m in gone:
                    if m not in group:
                        group.add(m)
                        stack.append(m)
                else:
                    border.add(m)
        seen |= group
        for m in border:
            out[m] |= border - {m}
    return out


def _component(adj: Adjacency, start: str, removed: set[str] | frozenset[str]) -> set[str]:
    seen, stack = {start}, [start]
    while stack:
        for m in adj[stack.pop()]:
            if m not in removed and m not in seen:
                seen.add(m)
                stack.append(m)
    return seen


def _border(adj: Adjacency, component: set[str]) -> frozenset[str]:
    return frozenset(m for n in component for m in adj[n] if m not in component)


def minimal_vertex_separators(adj: Adjacency, a: str, b: str, limit: int | None = None) -> tuple[list[frozenset[str]], bool]:
    """All minimal a-b vertex separators of an undirected graph.

    Returns (separators, truncated). Adjacent a and b have none; disconnected a and b have
    exactly one, the empty set.
    """
    if b in adj[a]:
        return [], False
    if b not in _component(adj, a, frozenset()):
        return [frozenset()], False
    first = _border(adj, _component(adj, b, adj[a] | {a}))
    seen, queue, out = {first}, deque([first]), []
    while queue:
        sep = queue.popleft()
        out.append(sep)
        if limit is not None and len(out) >= limit:
            return _sorted(out), bool(queue) or _has_more(adj, b, sep, seen)
        for x in sep:
            if b in adj[x]:
                continue
            nxt = _border(adj, _component(adj, b, sep | adj[x]))
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return _sorted(out), False


def _has_more(adj: Adjacency, b: str, sep: frozenset[str], seen: set[frozenset[str]]) -> bool:
    return any(
        _border(adj, _component(adj, b, sep | adj[x])) not in seen for x in sep if b not in adj[x]
    )


def _sorted(seps: list[frozenset[str]]) -> list[frozenset[str]]:
    return sorted(seps, key=lambda s: (len(s), sorted(s)))


def minimal_d_separators(
    graph: nx.DiGraph,
    x: str,
    y: str,
    included: Iterable[str] = (),
    allowed: Iterable[str] | None = None,
    limit: int | None = None,
) -> tuple[list[frozenset[str]], bool]:
    """Every minimal d-separator Z of x and y with included <= Z <= included | allowed.

    Minimal is relative to `included`: no proper subset of Z that still contains `included`
    separates x and y. Returns (separators, truncated); `truncated` is True when `limit`
    stopped the listing early.
    """
    included = set(included)
    if x == y:
        raise ValueError("x and y must differ")
    if {x, y} & included:
        raise ValueError("x and y cannot be in the conditioning set")
    allowed = set(graph.nodes) if allowed is None else set(allowed)
    ancestral = ancestral_closure(graph, {x, y} | included)
    adj = {n: nbrs - included for n, nbrs in moral_graph(graph, ancestral).items() if n not in included}
    forbidden = set(adj) - allowed - {x, y}
    adj = eliminate(adj, forbidden)
    seps, truncated = minimal_vertex_separators(adj, x, y, limit)
    return [frozenset(s | included) for s in seps], truncated
