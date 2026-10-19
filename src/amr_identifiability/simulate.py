"""Random discrete models over an m-graph, with exact ground truth.

Used to verify estimands numerically: every variable is binary with a random conditional
probability table (probabilities kept away from 0 and 1, so the observed-data distribution is
strictly positive, as Definition 1 of Mohan & Pearl (2021) requires), indicators are binary
(1 = missing), and each proxy follows Equation (1): X* = X when R_X = 0 and "missing" (code 2)
when R_X = 1.

    model = RandomModel(graph, seed=1)
    model.observed()                          # Table over Vo, R and V*: what data can show
    model.truth(["X", "Y"])                   # P(X, Y) from the full joint distribution
    model.truth(["Y"], do={"X": 1})           # P(Y | do(X = 1)) by truncated factorisation
"""

from __future__ import annotations

from itertools import product
from typing import Mapping, Sequence

import networkx as nx
import numpy as np

from amr_identifiability.estimand import Table
from amr_identifiability.mgraph import MGraph

MISSING = 2


class RandomModel:
    def __init__(self, graph: MGraph, seed: int = 0, low: float = 0.12, high: float = 0.88, max_nodes: int = 22) -> None:
        self.graph = graph
        g = graph.graph
        self.proxies = set(graph.proxies)
        self.nodes = [n for n in nx.topological_sort(g) if n not in self.proxies]
        if len(self.nodes) > max_nodes:
            raise ValueError(f"{len(self.nodes)} non-proxy nodes is too many to enumerate exactly (max {max_nodes})")
        rng = np.random.default_rng(seed)
        self.parents = {n: [p for p in sorted(g.predecessors(n))] for n in self.nodes}
        for n in self.nodes:
            if any(p in self.proxies for p in self.parents[n]):
                raise ValueError(f"{n} has a proxy as a parent; proxies must have no children")
        # p1[n][parent values] = P(n = 1 | parents)
        self.p1 = {n: rng.uniform(low, high, size=(2,) * len(self.parents[n])) for n in self.nodes}
        self._index = {n: i for i, n in enumerate(self.nodes)}
        self._joint = None

    # ------------------------------------------------------------------ full joint

    def _states(self) -> np.ndarray:
        n = len(self.nodes)
        return ((np.arange(2 ** n)[:, None] >> np.arange(n)[None, :]) & 1).astype(np.int8)

    def joint(self, do: Mapping[str, int] | None = None) -> np.ndarray:
        """Probabilities of every assignment of the non-proxy nodes (bit i = node i)."""
        do = dict(do or {})
        if not do and self._joint is not None:
            return self._joint
        s = self._states()
        p = np.ones(len(s))
        for n in self.nodes:
            i = self._index[n]
            if n in do:
                p *= s[:, i] == do[n]
                continue
            pa = [self._index[q] for q in self.parents[n]]
            q1 = self.p1[n][tuple(s[:, k] for k in pa)] if pa else np.full(len(s), float(self.p1[n]))
            p *= np.where(s[:, i] == 1, q1, 1 - q1)
        if not do:
            self._joint = p
        return p

    def table(self, columns: Sequence[str], do: Mapping[str, int] | None = None) -> Table:
        """Joint table over any columns, including proxies (codes 0, 1 and 2 = missing)."""
        s = self._states()
        p = self.joint(do)
        codes = []
        levels = []
        for c in columns:
            if c in self.proxies:
                v = c[: -len("_star")]
                r = "R_" + v
                x, rx = s[:, self._index[v]], s[:, self._index[r]]
                codes.append(np.where(rx == 0, x, MISSING))
                levels.append(3)
            else:
                codes.append(s[:, self._index[c]])
                levels.append(2)
        flat = np.ravel_multi_index(tuple(codes), tuple(levels)) if columns else np.zeros(len(s), dtype=int)
        probs = np.bincount(flat, weights=p, minlength=int(np.prod(levels))).reshape(tuple(levels) if columns else ())
        return Table(tuple(columns), probs)

    def observed(self) -> Table:
        """The observed-data distribution P(Vo, R, V*): no partially observed or latent variable."""
        g = self.graph
        cols = sorted(g.fully_observed) + sorted(g.indicators) + sorted(g.proxies)
        return self.table(cols)

    # ------------------------------------------------------------------ targets

    def truth(self, target: Sequence[str], given: Sequence[str] = (), do: Mapping[str, int] | None = None) -> dict[tuple[int, ...], float]:
        """{values of target + given: P(target | given, do)} from the full joint distribution."""
        target, given = list(target), list(given)
        t = self.table(target + given, do=do)
        out = {}
        for vals in product((0, 1), repeat=len(target) + len(given)):
            g_event = dict(zip(given, vals[len(target):]))
            event = dict(zip(target, vals[: len(target)]))
            out[vals] = t.conditional(event, g_event) if given else t.prob(event)
        return out
