"""Python access to the explorer's engine: recoverability (Mohan & Pearl 2021) and causal effects.

The algorithms run in the page's JavaScript core (through Node.js), so Python and the explorer
always give the same answers. Each answer carries its estimand as a tree that
`amr_identifiability.estimand.evaluate` computes on a probability table, as text, and as LaTeX.

    from amr_identifiability import build_model
    from amr_identifiability.engine import recover, effect, classify

    classify(build_model("M1"))["mechanism"]          # "MNAR"
    r = recover(build_model("M1"), ["Yk"], given=["S", "W", "T"])
    r["recoverable"], r["method"], r["text"]
    e = effect("dag { Z -> X  Z -> Y  X -> Y }", ["X"], ["Y"])
    e["identifiable"], e["text"], e["adjustment"]["minimal"]

A graph can be an MGraph or text in any format the explorer's Import dialog reads.
"""

from __future__ import annotations

import json
from typing import Iterable

from amr_identifiability.mgraph import MGraph
from amr_identifiability.viz import run_node
from amr_identifiability.viz.payload import model_payload


def _source(graph: MGraph | str) -> dict:
    if isinstance(graph, MGraph):
        return {"model": model_payload(graph, "graph")}
    if isinstance(graph, str):
        return {"text": graph}
    raise TypeError("graph must be an MGraph or graph text (DAGitty, edge list, JSON or Graphviz)")


def _latex(expr: dict | None) -> str | None:
    return None if expr is None else json.loads(run_node({"action": "latex", "exprs": [expr]}))[0]


def recover(graph: MGraph | str, target: Iterable[str], given: Iterable[str] = ()) -> dict:
    """Is P(target | given) recoverable from the incomplete data, and how?

    Returns a dict with recoverable (True, False, or None when undetermined), method, reason,
    expr (the estimand tree), text and latex.
    """
    q = {"target": list(target), "given": list(given)}
    out = json.loads(run_node({"action": "recover", "items": [{**_source(graph), "queries": [q]}]}))[0]
    r = out["results"][0]
    if "error" in r:
        raise ValueError(r["error"])
    r["latex"] = _latex(r.get("expr"))
    return r


def classify(graph: MGraph | str) -> dict:
    """MCAR / v-MAR / MNAR, Theorem 2 for the joint distribution, and testability (Section 4)."""
    out = json.loads(run_node({"action": "recover", "items": [{**_source(graph), "queries": []}]}))[0]
    return {"mechanism": out["classify"]["mechanism"] if out["classify"] else None, "theorem2": out["theorem2"], "testability": out["testability"]}


def effect(graph: MGraph | str, treatment: Iterable[str], outcome: Iterable[str], given: Iterable[str] = ()) -> dict:
    """P(outcome | do(treatment), given): identification (ID / IDC), recovery under missingness,
    adjustment sets, front-door sets and instruments."""
    q = {"X": list(treatment), "Y": list(outcome), "Z": list(given)}
    r = json.loads(run_node({"action": "effect", "items": [{**_source(graph), "queries": [q]}]}))[0][0]
    if "error" in r:
        raise ValueError(r["error"])
    r["latex"] = _latex(r.get("expr"))
    return r
