"""Recoverability checks (Mohan & Pearl 2021).

ordered_factorisation   Theorem 1: P(V) = prod_i P(V_i | V_<i, Z) is recoverable when each
                        V_i is independent of the indicators of V_i and of V_<i, given V_<i and Z.
                        Each factor is then estimated where those variables are all recorded.
find_recovery           searches orderings of helper variables and covariate sets that satisfy it
r_factorisation_problems  Theorem 2: sufficient conditions for recovering the joint distribution
                        when no ordering works

These are graphical checks. Positivity (the needed records exist in every stratum) is a
property of the data and is not checked here.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from itertools import combinations, permutations
from typing import Iterable, Sequence

from amr_identifiability.mgraph import R_PREFIX, Independence, MGraph, PathReport


@dataclass(frozen=True)
class Step:
    """One factor of an ordered factorisation and the independence it needs."""

    variable: str
    given: tuple[str, ...]
    requires: Independence
    holds: bool

    def __str__(self) -> str:
        return f"[{'ok' if self.holds else 'FAILS'}] P({self.variable} | {', '.join(self.given) or '-'}) needs {self.requires}"


@dataclass(frozen=True)
class Recovery:
    """The result of checking one ordered factorisation."""

    target: str
    order: tuple[str, ...]
    covariates: tuple[str, ...]
    steps: tuple[Step, ...]

    @property
    def recoverable(self) -> bool:
        return all(step.holds for step in self.steps)

    @property
    def functional(self) -> str:
        """The recovery formula in recorded data, for the target's distribution given the covariates."""
        factors = []
        for step in self.steps:
            zeros = [f"{r} = 0" for r in sorted(step.requires.y)]
            factors.append(f"P({step.variable} | {', '.join(list(step.given) + zeros)})")
        helpers = [v for v in self.order if v != self.target]
        total = f"sum over {', '.join(helpers)} of " if helpers else ""
        lhs = f"P({self.target} | {', '.join(self.covariates)})" if self.covariates else f"P({self.target})"
        return f"{lhs} = {total}" + " * ".join(factors)

    def report(self) -> str:
        head = f"{'RECOVERABLE' if self.recoverable else 'not recoverable'} by ordered factorisation: order {', '.join(self.order)}"
        if self.covariates:
            head += f"; covariates {', '.join(self.covariates)}"
        lines = [head] + [f"  {s}" for s in self.steps]
        if self.recoverable:
            lines.append(f"  {self.functional}")
        return "\n".join(lines)


def ordered_factorisation(graph: MGraph, order: Sequence[str], covariates: Iterable[str] = ()) -> Recovery:
    """Check the ordered factorisation of `order` (target last) given fully observed covariates.

    The last variable in `order` is the target; the others are helpers summed over.
    """
    order = tuple(order)
    covariates = tuple(sorted(covariates))
    if not order:
        raise ValueError("order must contain at least the target")
    if len(set(order)) != len(order):
        raise ValueError("order repeats a variable")
    partial = set(order) - graph.partially_observed
    if partial:
        raise ValueError(f"variables in the order must be partially observed: {sorted(partial)}")
    bad = set(covariates) - graph.fully_observed
    if bad:
        raise ValueError(f"covariates must be fully observed; put partially observed ones in the order instead: {sorted(bad)}")

    steps = []
    for i, variable in enumerate(order):
        earlier = order[:i]
        given = earlier + covariates
        indicators = {R_PREFIX + v for v in earlier + (variable,)}
        ind = Independence.of(variable, indicators, given)
        steps.append(Step(variable, given, ind, graph.is_d_separated(ind.x, ind.y, ind.z)))
    return Recovery(order[-1], order, covariates, tuple(steps))


def find_recovery(
    graph: MGraph,
    target: str,
    helpers: Iterable[str] | None = None,
    covariates: Iterable[str] | None = None,
    max_helpers: int = 4,
    max_covariates: int = 4,
    limit: int = 10,
) -> list[Recovery]:
    """Smallest recoveries of P(target | covariates) by ordered factorisation.

    Searches covariate sets by increasing size, and for each the smallest set of helper
    variables (partially observed variables summed over) and an ordering of them, with the
    target last. Returns up to `limit` recoveries of the smallest total size found, or an
    empty list when none exists within the size limits.
    """
    if target not in graph.partially_observed:
        raise ValueError(f"{target} is not partially observed")
    helper_pool = sorted(set(helpers) if helpers is not None else graph.partially_observed - {target})
    covariate_pool = sorted(set(covariates) if covariates is not None else graph.fully_observed)

    @lru_cache(maxsize=None)
    def sep(x: str, ys: frozenset[str], zs: frozenset[str]) -> bool:
        return graph.is_d_separated(x, ys, zs)

    found: list[Recovery] = []
    best = None
    for n_cov in range(min(max_covariates, len(covariate_pool)) + 1):
        for cov in combinations(covariate_pool, n_cov):
            for n_help in range(min(max_helpers, len(helper_pool)) + 1):
                if best is not None and n_cov + n_help > best:
                    break
                for chosen in combinations(helper_pool, n_help):
                    last = sep(target, frozenset(R_PREFIX + v for v in chosen + (target,)), frozenset(chosen + cov))
                    if not last:
                        continue
                    for order in permutations(chosen):
                        ok = all(
                            sep(v, frozenset(R_PREFIX + w for w in order[: i + 1]), frozenset(order[:i] + cov))
                            for i, v in enumerate(order)
                        )
                        if ok:
                            found.append(ordered_factorisation(graph, order + (target,), cov))
                            best = n_cov + n_help
                            break
                    if len(found) >= limit:
                        return found
        if best is not None and n_cov >= best:
            break
    return found


def r_factorisation_problems(graph: MGraph, variables: Iterable[str] | None = None) -> list[str]:
    """Violations of the sufficient conditions for recovering the joint by R-factorisation.

    Checked for the given partially observed variables (default: all):
      * no variable drives its own indicator (self-masking, Theorem 3)
      * no indicator is a parent of another indicator
      * no path between a variable and its own indicator runs only through colliders that
        are recorded variables
      * no unrecorded common cause links two indicators
    An empty list means the conditions hold; it is not a proof that they are necessary.
    """
    variables = sorted(set(variables) if variables is not None else graph.partially_observed)
    problems = []
    masking = graph.self_masking()
    for v in variables:
        if v in masking:
            problems.append(f"self-masking: {masking[v]}")
    indicators = {R_PREFIX + v for v in variables}
    for a in sorted(indicators):
        for b in sorted(indicators - {a}):
            if graph.graph.has_edge(a, b):
                problems.append(f"indicator {a} is a parent of indicator {b}")
    recorded = graph.fully_observed | graph.partially_observed
    for v in variables:
        r = R_PREFIX + v
        for report in graph.paths(v, r, max_paths=500, max_length=6):
            inner = report.path[1:-1]
            if inner and all(n in recorded for n in inner) and _all_colliders(report):
                problems.append(f"all-collider path {' - '.join(report.path)}")
    for pair in sorted(graph.latent_links(), key=sorted):
        if pair <= indicators:
            a, b = sorted(pair)
            problems.append(f"unrecorded common cause of {a} and {b}")
    return problems


def _all_colliders(report: PathReport) -> bool:
    """True if every inner node of the path has both path edges pointing into it."""
    return all(report.forward[i - 1] and not report.forward[i] for i in range(1, len(report.path) - 1))
