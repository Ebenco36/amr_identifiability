"""Evaluate an estimand (a probability expression over observed columns) on a probability table.

Estimands come from the explorer's engine as JSON trees (see viz/assets/js/core/expr.js):

    {"t": "P", "vars": [[column, value]], "given": [[column, value]], "do": []}
    {"t": "sum", "over": [symbol], "body": ...}
    {"t": "prod", "factors": [...]}
    {"t": "frac", "num": ..., "den": ...}
    {"t": "one"}

A value is a symbol (the name of a substantive variable, standing for its value) or a constant.
`evaluate` returns the number the estimand takes for given symbol values, computed from a
`Table` of the observed-data distribution. With frequencies from data in the table, this is
the closed-form estimate of Remark 1 in Mohan & Pearl (2021).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np


@dataclass
class Table:
    """A joint probability table over named discrete columns."""

    columns: tuple[str, ...]
    probs: np.ndarray  # shape (levels of column 0, levels of column 1, ...)

    def __post_init__(self) -> None:
        self.columns = tuple(self.columns)
        if self.probs.ndim != len(self.columns):
            raise ValueError("one axis per column")
        self._axis = {c: i for i, c in enumerate(self.columns)}
        self._marginals: dict[tuple[str, ...], np.ndarray] = {}

    @classmethod
    def from_counts(cls, columns: Sequence[str], rows: Sequence[Sequence[int]], levels: Sequence[int]) -> "Table":
        """Empirical table from data rows (integer codes per column)."""
        counts = np.zeros(tuple(levels))
        for r in rows:
            counts[tuple(r)] += 1
        return cls(tuple(columns), counts / counts.sum())

    def marginal(self, cols: Sequence[str]) -> np.ndarray:
        key = tuple(cols)
        if key not in self._marginals:
            self._marginals[key] = self._marginal(cols)
        return self._marginals[key]

    def _marginal(self, cols: Sequence[str]) -> np.ndarray:
        keep = [self._axis[c] for c in cols]
        drop = tuple(i for i in range(len(self.columns)) if i not in keep)
        m = self.probs.sum(axis=drop)
        # axes of m are the kept axes in table order; reorder to `cols`
        order = sorted(keep)
        return np.moveaxis(m, [order.index(k) for k in keep], list(range(len(keep)))) if keep else m

    def prob(self, event: Mapping[str, int]) -> float:
        """P(event) for an assignment of some columns."""
        cols = list(event)
        if not cols:
            return float(self.probs.sum())
        m = self.marginal(cols)
        return float(m[tuple(event[c] for c in cols)])

    def conditional(self, event: Mapping[str, int], given: Mapping[str, int]) -> float:
        both = {**given, **event}
        for c in set(event) & set(given):
            if event[c] != given[c]:
                return 0.0
        den = self.prob(given)
        if den <= 0:
            raise ZeroDivisionError(f"P({given}) = 0: the estimand needs data in this stratum (positivity)")
        return self.prob(both) / den

    def levels(self, column: str) -> int:
        return self.probs.shape[self._axis[column]]


def evaluate(expr: dict, table: Table, values: Mapping[str, int], domains: Mapping[str, Sequence[int]] | None = None) -> float:
    """The estimand's value for the symbol values given, computed from the table.

    `domains` gives the values each summation symbol ranges over: default 0 and 1, and for a
    proxy's symbol (written X*) also 2, the code for "missing".
    """
    domains = domains or {}
    # a node's value depends only on the values of its free symbols, so each node is computed once
    # per assignment of those symbols (nested sums otherwise recompute the same terms many times)
    free: dict[int, tuple[str, ...]] = {}
    memo: dict[tuple, float] = {}

    def free_of(e) -> tuple[str, ...]:
        k = id(e)
        if k not in free:
            free[k] = tuple(sorted(free_symbols(e)))
        return free[k]

    def value(v, env):
        if isinstance(v, str):
            if v not in env:
                raise KeyError(f"symbol {v} has no value")
            return env[v]
        return int(v)

    def go(e, env) -> float:
        key = (id(e),) + tuple(env.get(s) for s in free_of(e))
        if key not in memo:
            memo[key] = compute(e, env)
        return memo[key]

    def compute(e, env) -> float:
        t = e["t"]
        if t == "one":
            return 1.0
        if t == "P":
            if e.get("do"):
                raise ValueError("an estimand must not contain do(): it is not yet expressed in observed data")
            event = {c: value(v, env) for c, v in e["vars"]}
            given = {c: value(v, env) for c, v in e["given"]}
            return table.conditional(event, given) if given else table.prob(event)
        if t == "sum":
            total = 0.0
            grids = [domains.get(s, (0, 1, 2) if s.endswith("*") else (0, 1)) for s in e["over"]]
            for combo in np.array(np.meshgrid(*grids, indexing="ij")).reshape(len(grids), -1).T:
                total += go(e["body"], {**env, **dict(zip(e["over"], map(int, combo)))})
            return total
        if t == "prod":
            out = 1.0
            for f in e["factors"]:
                out *= go(f, env)
            return out
        if t == "frac":
            den = go(e["den"], env)
            if den == 0:
                raise ZeroDivisionError("division by zero in the estimand (positivity)")
            return go(e["num"], env) / den
        raise ValueError(f"unknown expression node {t!r}")

    return go(expr, dict(values))


def free_symbols(expr: dict) -> set[str]:
    out: set[str] = set()

    def go(e, bound):
        t = e["t"]
        if t == "P":
            for part in ("vars", "given", "do"):
                for _, v in e.get(part, []):
                    if isinstance(v, str) and v not in bound:
                        out.add(v)
        elif t == "sum":
            go(e["body"], bound | set(e["over"]))
        elif t == "prod":
            for f in e["factors"]:
                go(f, bound)
        elif t == "frac":
            go(e["num"], bound)
            go(e["den"], bound)

    go(expr, set())
    return out
