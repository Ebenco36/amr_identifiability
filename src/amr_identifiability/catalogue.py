"""Every conditional independence an m-graph implies, organised by node and by pair.

For each pair of recorded nodes (every node that is not latent) the catalogue lists:

    separators   every minimal set of recorded nodes that d-separates the pair
    testable     every minimal separating set that makes the statement checkable in recorded
                 data: no proxies, and the indicator of each partially observed variable
                 involved is in the set (Mohan & Pearl 2014)

A pair with no separating set is either adjacent or joined by a path that no recorded
node can block (through latent nodes, or through colliders that must be conditioned on).

The lists hold the minimal statements. A larger set can also separate a pair (when it opens
no collider path) but is not listed; query it with MGraph.implies. Each node also has its
local Markov statement, X _||_ non-descendants | parents, which may involve latent nodes.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Iterable

from amr_identifiability.mgraph import R_PREFIX, Independence, MGraph
from amr_identifiability.separators import minimal_d_separators


@dataclass(frozen=True)
class PairConditions:
    """The minimal independences between two nodes."""

    x: str
    y: str
    adjacent: bool
    separators: tuple[frozenset[str], ...]
    testable: tuple[frozenset[str], ...]
    truncated: bool = False

    @property
    def separable(self) -> bool:
        return bool(self.separators)

    @property
    def reason(self) -> str:
        if self.separators:
            return f"{len(self.separators)} minimal separating set(s)"
        if self.adjacent:
            return "adjacent: joined by an edge"
        return "no set of recorded nodes separates them"

    def statements(self, testable_only: bool = False) -> list[Independence]:
        sets = self.testable if testable_only else self.separators
        return [Independence.of(self.x, self.y, z) for z in sets]

    def other(self, node: str) -> str:
        return self.y if node == self.x else self.x


class ConditionCatalogue:
    """All minimal conditional independences of an MGraph.

    Parameters
    ----------
    graph:  the m-graph
    nodes:  the nodes to pair up (default: every node that is not latent)
    limit:  stop listing a pair's separating sets after this many (default: no limit)

    Examples
    --------
    >>> cat = ConditionCatalogue(build_model("M1"))
    >>> print(cat.report("Yk"))
    >>> cat.pair("Yj1", "R_Yj2").testable
    """

    def __init__(self, graph: MGraph, nodes: Iterable[str] | None = None, limit: int | None = None) -> None:
        self.graph = graph
        recorded = graph.nodes - graph.latent
        self.nodes = tuple(sorted(recorded if nodes is None else nodes))
        unknown = set(self.nodes) - graph.nodes
        if unknown:
            raise KeyError(f"not in the graph: {sorted(unknown)}")
        self.limit = limit
        self._allowed = frozenset(recorded)
        self._testable_allowed = frozenset(recorded - graph.proxies)
        self._pairs: dict[frozenset[str], PairConditions] = {}
        for x, y in combinations(self.nodes, 2):
            self._pairs[frozenset((x, y))] = self._build_pair(x, y)

    # ------------------------------------------------------------------ building

    def _build_pair(self, x: str, y: str) -> PairConditions:
        g = self.graph.graph
        adjacent = g.has_edge(x, y) or g.has_edge(y, x)
        if adjacent:
            return PairConditions(x, y, True, (), ())
        seps, truncated = minimal_d_separators(g, x, y, allowed=self._allowed, limit=self.limit)
        return PairConditions(x, y, False, tuple(seps), tuple(self._testable_separators(x, y)), truncated)

    def _testable_separators(self, x: str, y: str) -> list[frozenset[str]]:
        """Minimal testable separating sets, adding required indicators until the set is closed."""
        g = self.graph
        if {x, y} & (g.proxies | g.latent):
            return []
        partial = g.partially_observed
        found: set[frozenset[str]] = set()
        start = frozenset(R_PREFIX + v for v in {x, y} & partial)
        if {x, y} & start:
            return []
        queue, tried = [start], set()
        while queue:
            required = queue.pop()
            if required in tried:
                continue
            tried.add(required)
            seps, _ = minimal_d_separators(g.graph, x, y, included=required,
                                           allowed=self._testable_allowed, limit=self.limit)
            for z in seps:
                needed = frozenset(R_PREFIX + v for v in z & partial)
                if needed <= z:
                    found.add(z)
                elif not needed & {x, y}:
                    queue.append(required | needed)
        minimal = [z for z in found if not any(other < z for other in found)]
        return sorted(minimal, key=lambda s: (len(s), sorted(s)))

    # ------------------------------------------------------------------ queries

    def pair(self, x: str, y: str) -> PairConditions:
        try:
            return self._pairs[frozenset((x, y))]
        except KeyError:
            raise KeyError(f"no pair {x}, {y} in the catalogue (latent or unknown node?)") from None

    @property
    def pairs(self) -> list[PairConditions]:
        return list(self._pairs.values())

    def for_node(self, node: str) -> list[PairConditions]:
        """Every pair that involves the node, ordered by the other node."""
        if node not in self.nodes:
            raise KeyError(f"{node} is not in the catalogue")
        return sorted((p for p in self._pairs.values() if node in (p.x, p.y)), key=lambda p: p.other(node))

    def local_markov(self, node: str) -> Independence | None:
        """X _||_ (non-descendants minus parents) | parents, or None when that set is empty."""
        g = self.graph
        rest = g.nodes - g.descendants(node) - g.parents(node) - {node}
        return Independence.of(node, rest, g.parents(node)) if rest else None

    def statements(self, testable_only: bool = False) -> list[Independence]:
        return [s for p in self._pairs.values() for s in p.statements(testable_only)]

    # ------------------------------------------------------------------ output

    def summary(self) -> str:
        pairs = self.pairs
        separable = [p for p in pairs if p.separable]
        n_sep = sum(len(p.separators) for p in pairs)
        n_test = sum(len(p.testable) for p in pairs)
        adjacent = sum(p.adjacent for p in pairs)
        text = (f"{self.graph.name or 'graph'}: {len(self.nodes)} recorded nodes, {len(pairs)} pairs; "
                f"{len(separable)} separable ({n_sep} minimal separating sets, {n_test} testable), "
                f"{adjacent} adjacent, {len(pairs) - len(separable) - adjacent} not separable by recorded nodes")
        if any(p.truncated for p in pairs):
            text += f"; some pairs stopped at {self.limit} sets"
        return text

    def report(self, node: str | None = None, testable_only: bool = False) -> str:
        """Plain-text listing, for one node or for every node."""
        nodes = [node] if node else list(self.nodes)
        lines = [self.summary(), ""]
        for n in nodes:
            role = self.graph.role(n)
            lines.append(f"{n}  ({role})")
            lm = self.local_markov(n)
            if lm:
                lines.append(f"  local Markov: {lm}")
            for p in self.for_node(n):
                other = p.other(n)
                if not testable_only:
                    if not p.separators:
                        lines.append(f"  {other:10s} never independent ({p.reason})")
                    for z in p.separators:
                        mark = "  [testable]" if z in p.testable else ""
                        lines.append(f"  {other:10s} given {', '.join(sorted(z)) or '(nothing)'}{mark}")
                for z in p.testable:
                    if testable_only or z not in p.separators:
                        recorded = self.graph.recorded_form(Independence.of(p.x, p.y, z))
                        lines.append(f"  {other:10s} testable: {recorded}")
            lines.append("")
        return "\n".join(lines)

    def rows(self, testable_only: bool = False) -> list[dict[str, str]]:
        """One row per minimal statement, for CSV or a data frame."""
        out = []
        for p in self.pairs:
            for z in (p.testable if testable_only else p.separators):
                ind = Independence.of(p.x, p.y, z)
                testable = z in p.testable
                out.append({
                    "x": p.x, "y": p.y, "given": ", ".join(sorted(z)),
                    "statement": str(ind), "testable": "yes" if testable else "no",
                    "recorded_form": self.graph.recorded_form(ind) if testable else "",
                })
        return out

    def to_csv(self, path: str | Path, testable_only: bool = False) -> Path:
        path = Path(path)
        rows = self.rows(testable_only)
        with path.open("w", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=["x", "y", "given", "statement", "testable", "recorded_form"])
            writer.writeheader()
            writer.writerows(rows)
        return path

    def __repr__(self) -> str:
        return f"ConditionCatalogue({self.summary()})"
