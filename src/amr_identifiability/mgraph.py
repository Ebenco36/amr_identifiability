"""The MGraph class: a missingness graph with node roles and independence queries.

Conventions (Mohan & Pearl 2021):

    X         a substantive variable
    R_X       its missingness indicator: R_X = 0 observed, R_X = 1 missing
    X_star    its recorded proxy: X when R_X = 0, missing otherwise

A variable with both R_X and X_star in the graph is partially observed. A node that is not
latent, not an indicator and not a proxy, and has no indicator, is fully observed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from itertools import combinations
from typing import Iterable, Mapping

import networkx as nx

R_PREFIX = "R_"
PROXY_SUFFIX = "_star"


def _as_set(nodes: str | Iterable[str] | None) -> frozenset[str]:
    if nodes is None:
        return frozenset()
    if isinstance(nodes, str):
        return frozenset([nodes])
    return frozenset(nodes)


@dataclass(frozen=True)
class Independence:
    """The statement X _||_ Y | Z."""

    x: frozenset[str]
    y: frozenset[str]
    z: frozenset[str] = frozenset()

    @classmethod
    def of(cls, x: str | Iterable[str], y: str | Iterable[str], z: str | Iterable[str] | None = None) -> "Independence":
        return cls(_as_set(x), _as_set(y), _as_set(z))

    @classmethod
    def parse(cls, text: str) -> "Independence":
        """Parse "X, Y _||_ Z | A, B" (DAGitty style). Commas or spaces separate names."""
        if "_||_" not in text:
            raise ValueError(f"not an independence statement (expected '_||_'): {text!r}")
        left, right = text.split("_||_", 1)
        right, _, given = right.partition("|")

        def names(part: str) -> frozenset[str]:
            return frozenset(n for n in re.split(r"[,\s]+", part.strip()) if n)

        x, y = names(left), names(right)
        if not x or not y:
            raise ValueError(f"both sides of '_||_' need at least one variable: {text!r}")
        return cls(x, y, names(given))

    def __str__(self) -> str:
        def fmt(nodes: frozenset[str]) -> str:
            return ", ".join(sorted(nodes))

        text = f"{fmt(self.x)} _||_ {fmt(self.y)}"
        return f"{text} | {fmt(self.z)}" if self.z else text


@dataclass(frozen=True)
class PathReport:
    """One path between two nodes, and whether it is open given a conditioning set."""

    path: tuple[str, ...]
    forward: tuple[bool, ...]    # forward[i] is True when the edge points from path[i] to path[i + 1]
    open: bool
    reason: str

    def __str__(self) -> str:
        parts = []
        for i in range(len(self.path) - 1):
            parts += [self.path[i], "->" if self.forward[i] else "<-"]
        parts.append(self.path[-1])
        return f"{'OPEN   ' if self.open else 'blocked'}  {' '.join(parts)}   ({self.reason})"


class MGraph:
    """A missingness DAG.

    Parameters
    ----------
    edges:      directed edges (parent, child)
    latent:     unobserved nodes
    nodes:      extra nodes without edges
    name:       a label used in reports
    positions:  optional DAGitty layout coordinates, kept for export
    """

    def __init__(
        self,
        edges: Iterable[tuple[str, str]],
        latent: Iterable[str] = (),
        nodes: Iterable[str] = (),
        name: str = "",
        positions: Mapping[str, tuple[float, float]] | None = None,
    ) -> None:
        graph = nx.DiGraph()
        graph.add_nodes_from(nodes)
        graph.add_edges_from(edges)
        latent = frozenset(latent)
        missing = latent - set(graph)
        if missing:
            raise ValueError(f"latent nodes not in the graph: {sorted(missing)}")
        if not nx.is_directed_acyclic_graph(graph):
            raise ValueError(f"graph has a cycle: {nx.find_cycle(graph)}")
        self._graph = nx.freeze(graph)
        self.latent = latent
        self.name = name
        self.positions = dict(positions or {})

    # ------------------------------------------------------------------ structure

    @property
    def graph(self) -> nx.DiGraph:
        """The underlying networkx graph (read-only)."""
        return self._graph

    @property
    def nodes(self) -> frozenset[str]:
        return frozenset(self._graph.nodes)

    @property
    def edges(self) -> frozenset[tuple[str, str]]:
        return frozenset(self._graph.edges)

    def parents(self, node: str) -> frozenset[str]:
        self._require([node])
        return frozenset(self._graph.predecessors(node))

    def children(self, node: str) -> frozenset[str]:
        self._require([node])
        return frozenset(self._graph.successors(node))

    def ancestors(self, node: str) -> frozenset[str]:
        self._require([node])
        return frozenset(nx.ancestors(self._graph, node))

    def descendants(self, node: str) -> frozenset[str]:
        self._require([node])
        return frozenset(nx.descendants(self._graph, node))

    # ------------------------------------------------------------------ roles

    def indicator_of(self, variable: str) -> str | None:
        """R_X for a partially observed X, else None."""
        name = R_PREFIX + variable
        return name if name in self._graph else None

    def proxy_of(self, variable: str) -> str | None:
        name = variable + PROXY_SUFFIX
        return name if name in self._graph else None

    @property
    def partially_observed(self) -> frozenset[str]:
        return frozenset(
            n for n in self._graph
            if n not in self.latent and self.indicator_of(n) and self.proxy_of(n)
        )

    @property
    def indicators(self) -> frozenset[str]:
        return frozenset(R_PREFIX + v for v in self.partially_observed)

    @property
    def proxies(self) -> frozenset[str]:
        return frozenset(v + PROXY_SUFFIX for v in self.partially_observed)

    @property
    def fully_observed(self) -> frozenset[str]:
        special = self.latent | self.partially_observed | self.indicators | self.proxies
        return frozenset(self._graph.nodes) - special

    def role(self, node: str) -> str:
        self._require([node])
        if node in self.latent:
            return "latent"
        if node in self.partially_observed:
            return "partially observed"
        if node in self.indicators:
            return "missingness indicator"
        if node in self.proxies:
            return "recorded proxy"
        return "fully observed"

    def validate(self) -> list[str]:
        """Problems with the graph as an m-graph. An empty list means none were found."""
        problems = []
        for v in sorted(self.partially_observed):
            r, star = R_PREFIX + v, v + PROXY_SUFFIX
            if self.parents(star) != {v, r}:
                problems.append(f"{star} must have exactly the parents {v} and {r}; has {sorted(self.parents(star))}")
            if self.children(star):
                problems.append(f"{star} is a proxy and must have no children; has {sorted(self.children(star))}")
            for child in sorted(self.children(r) - {star}):
                if child not in self.indicators:
                    problems.append(f"{r} is a missingness indicator; its child {child} is neither its proxy nor an indicator")
        for node in sorted(self._graph):
            if node.startswith(R_PREFIX) and node not in self.indicators:
                problems.append(f"{node} looks like an indicator but {node[len(R_PREFIX):]} has no proxy or is latent")
            if node.endswith(PROXY_SUFFIX) and node not in self.proxies:
                problems.append(f"{node} looks like a proxy but {node[:-len(PROXY_SUFFIX)]} has no indicator or is latent")
        for node in sorted(self.latent & (self.indicators | self.proxies)):
            problems.append(f"{node} is marked latent but indicators and proxies are recorded")
        return problems

    # ------------------------------------------------------------------ d-separation

    def is_d_separated(self, x: str | Iterable[str], y: str | Iterable[str], z: str | Iterable[str] | None = None) -> bool:
        """True if every path between X and Y is blocked given Z."""
        x, y, z = _as_set(x), _as_set(y), _as_set(z)
        self._require(x | y | z)
        if not x or not y:
            raise ValueError("X and Y must each contain at least one node")
        if x & y:
            raise ValueError(f"X and Y overlap: {sorted(x & y)}")
        if (x | y) & z:
            raise ValueError(f"the conditioning set overlaps X or Y: {sorted((x | y) & z)}")
        return nx.is_d_separator(self._graph, set(x), set(y), set(z))

    def implies(self, statement: str | Independence) -> bool:
        """True if the graph implies the independence, e.g. "Yk _||_ R_Yk | Yj1, S, W, T"."""
        ind = Independence.parse(statement) if isinstance(statement, str) else statement
        return self.is_d_separated(ind.x, ind.y, ind.z)

    def paths(
        self,
        x: str,
        y: str,
        z: str | Iterable[str] | None = None,
        only_open: bool = False,
        max_paths: int = 200,
        max_length: int | None = None,
    ) -> list[PathReport]:
        """Paths between two nodes in the skeleton, each marked open or blocked given Z.

        A path is blocked at a non-collider in Z, or at a collider that is not in Z and has
        no descendant in Z. Enumeration stops after max_paths paths.
        """
        z = _as_set(z)
        self._require({x, y} | z)
        skeleton = self._graph.to_undirected(as_view=True)
        out = []
        for path in nx.all_simple_paths(skeleton, x, y, cutoff=max_length):
            report = self._path_status(tuple(path), z)
            if report.open or not only_open:
                out.append(report)
            if len(out) >= max_paths:
                break
        return out

    def explain(self, statement: str | Independence, max_paths: int = 20) -> str:
        """Why an independence holds or fails: the open paths, or a note that all are blocked."""
        ind = Independence.parse(statement) if isinstance(statement, str) else statement
        holds = self.implies(ind)
        lines = [f"{ind}: {'implied' if holds else 'NOT implied'} by {self.name or 'the graph'}"]
        if holds:
            lines.append("  every path is blocked")
            return "\n".join(lines)
        shown = 0
        for a in sorted(ind.x):
            for b in sorted(ind.y):
                for report in self.paths(a, b, ind.z, only_open=True, max_paths=max_paths - shown):
                    lines.append("  " + str(report))
                    shown += 1
                if shown >= max_paths:
                    lines.append(f"  (stopped after {max_paths} open paths)")
                    return "\n".join(lines)
        return "\n".join(lines)

    def _path_status(self, path: tuple[str, ...], z: frozenset[str]) -> PathReport:
        forward = tuple(self._graph.has_edge(path[i], path[i + 1]) for i in range(len(path) - 1))
        status = None
        for i in range(1, len(path) - 1):
            node = path[i]
            into_from_left = forward[i - 1]          # path[i-1] -> node
            into_from_right = not forward[i]         # node <- path[i+1]
            collider = into_from_left and into_from_right
            if collider:
                if node not in z and not (nx.descendants(self._graph, node) & z):
                    status = (False, f"collider {node} not conditioned on")
                    break
            elif node in z:
                status = (False, f"{node} conditioned on")
                break
        return PathReport(path, forward, *(status or (True, "no blocking node")))

    # ------------------------------------------------------------------ missing-data structure

    def latent_links(self) -> frozenset[frozenset[str]]:
        """Pairs of non-latent nodes with a common latent ancestor reached through latent nodes only.

        These are the bidirected edges of the latent projection.
        """
        links = set()
        for u in self.latent:
            reached = set()
            stack = [u]
            seen = {u}
            while stack:
                for child in self._graph.successors(stack.pop()):
                    if child in self.latent:
                        if child not in seen:
                            seen.add(child)
                            stack.append(child)
                    else:
                        reached.add(child)
            links.update(frozenset(p) for p in combinations(sorted(reached), 2))
        return frozenset(links)

    def latent_directed(self, source: str, target: str) -> bool:
        """True if source reaches target by a directed path whose inner nodes are all latent."""
        stack, seen = [source], {source}
        while stack:
            for child in self._graph.successors(stack.pop()):
                if child == target:
                    return True
                if child in self.latent and child not in seen:
                    seen.add(child)
                    stack.append(child)
        return False

    def self_masking(self) -> dict[str, str]:
        """Partially observed variables whose own value can drive their missingness.

        Returns {variable: reason}. Covers a direct edge X -> R_X, a directed path through
        latent nodes only, and an unrecorded common cause of X and R_X (latent selection).
        """
        links = self.latent_links()
        out = {}
        for v in sorted(self.partially_observed):
            r = R_PREFIX + v
            if self._graph.has_edge(v, r):
                out[v] = f"direct edge {v} -> {r}"
            elif self.latent_directed(v, r):
                out[v] = f"{v} reaches {r} through latent nodes only"
            elif frozenset((v, r)) in links:
                out[v] = f"{v} and {r} share an unrecorded cause"
        return out

    # ------------------------------------------------------------------ testability

    def is_testable(self, statement: str | Independence) -> bool:
        """True if the statement can be checked on recorded data.

        Sufficient condition (Mohan & Pearl 2014): it involves no latent node or proxy, and the
        indicator of every partially observed variable in it is in the conditioning set, so the
        statement can be evaluated among records where that variable is observed.
        """
        ind = Independence.parse(statement) if isinstance(statement, str) else statement
        involved = ind.x | ind.y | ind.z
        if involved & (self.latent | self.proxies):
            return False
        needed = {R_PREFIX + v for v in involved & self.partially_observed}
        return needed <= ind.z

    def recorded_form(self, statement: str | Independence) -> str:
        """The statement written in recorded variables, e.g. "Yj1_star _||_ R_Yj2 | S, R_Yj1 = 0"."""
        ind = Independence.parse(statement) if isinstance(statement, str) else statement
        if not self.is_testable(ind):
            raise ValueError(f"not testable on recorded data: {ind}")
        rename = {v: v + PROXY_SUFFIX for v in self.partially_observed}
        fixed = {R_PREFIX + v for v in (ind.x | ind.y | ind.z) & self.partially_observed}

        def fmt(nodes: Iterable[str]) -> str:
            return ", ".join(sorted(rename.get(n, n) for n in nodes))

        given = [fmt(ind.z - fixed)] if ind.z - fixed else []
        given += [f"{r} = 0" for r in sorted(fixed)]
        text = f"{fmt(ind.x)} _||_ {fmt(ind.y)}"
        return f"{text} | {', '.join(given)}" if given else text

    def testable_implications(self) -> list[Independence]:
        """One testable independence for each non-adjacent pair of recordable nodes, where one exists.

        For each pair, a minimal separating set is sought among fully observed variables,
        partially observed variables and indicators, with the indicators of every partially
        observed variable involved forced into it. Pairs with no such set are skipped.
        """
        candidates = self.fully_observed | self.partially_observed | self.indicators
        skeleton = self._graph.to_undirected(as_view=True)
        out = []
        for u, v in combinations(sorted(candidates), 2):
            if skeleton.has_edge(u, v) or u == R_PREFIX + v or v == R_PREFIX + u:
                continue
            separator = self._testable_separator(u, v, candidates)
            if separator is not None:
                out.append(Independence.of(u, v, separator))
        return out

    def _testable_separator(self, u: str, v: str, candidates: frozenset[str]) -> frozenset[str] | None:
        required = {R_PREFIX + n for n in {u, v} & self.partially_observed}
        restricted = set(candidates) - {u, v}
        for _ in range(len(candidates)):
            if not required <= restricted:
                return None
            try:
                sep = nx.find_minimal_d_separator(self._graph, {u}, {v}, included=required, restricted=restricted)
            except nx.NetworkXError:
                return None
            if sep is None:
                return None
            needed = required | {R_PREFIX + n for n in sep & self.partially_observed}
            if needed <= set(sep):
                return frozenset(sep)
            required = needed
        return None

    # ------------------------------------------------------------------ editing

    def with_changes(
        self,
        add: Iterable[tuple[str, str]] = (),
        remove: Iterable[tuple[str, str]] = (),
        latent: Iterable[str] = (),
        name: str | None = None,
    ) -> "MGraph":
        """A new graph with edges added or removed; the original is unchanged."""
        remove = set(remove)
        missing = remove - set(self._graph.edges)
        if missing:
            raise ValueError(f"cannot remove edges that are not in the graph: {sorted(missing)}")
        edges = [e for e in self._graph.edges if e not in remove] + list(add)
        return MGraph(edges, latent=self.latent | set(latent), nodes=self._graph.nodes,
                      name=name or self.name, positions=self.positions)

    # ------------------------------------------------------------------ helpers

    def _require(self, nodes: Iterable[str]) -> None:
        unknown = set(nodes) - set(self._graph)
        if unknown:
            raise KeyError(f"not in the graph: {sorted(unknown)}")

    def __repr__(self) -> str:
        return (f"MGraph({self.name!r}: {self._graph.number_of_nodes()} nodes, {self._graph.number_of_edges()} edges, "
                f"{len(self.latent)} latent, {len(self.partially_observed)} partially observed)")
