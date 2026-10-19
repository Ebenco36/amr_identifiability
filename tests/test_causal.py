"""Causal effects: ID / IDC, adjustment, front-door, and Section 3.5 of Mohan & Pearl (2021).

Every estimand is evaluated on random discrete models and compared with the interventional
distribution computed by truncated factorisation. Runs the page's engine in Node.
"""

import itertools
import json
import random
import shutil

import pytest

from amr_identifiability import MGraph
from amr_identifiability.estimand import evaluate, free_symbols
from amr_identifiability.simulate import RandomModel
from amr_identifiability.viz import run_node

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")


def mgraph(spec):
    return MGraph([tuple(e) for e in spec["edges"]], latent=[n["id"] for n in spec["nodes"] if n.get("latent")],
                  nodes=[n["id"] for n in spec["nodes"]])


def max_error(g, expr, X, Y, Z, seeds=2):
    assert free_symbols(expr) <= set(X) | set(Y) | set(Z)
    worst = 0.0
    for seed in range(seeds):
        m = RandomModel(g, seed=seed)
        obs = m.observed()
        for xv in itertools.product((0, 1), repeat=len(X)):
            for vals, p in m.truth(Y, Z, do=dict(zip(X, xv))).items():
                env = {**dict(zip(Y + Z, vals)), **dict(zip(X, xv))}
                worst = max(worst, abs(evaluate(expr, obs, env) - p))
    return worst


def random_dag(rng):
    n = rng.randint(3, 6)
    V = [f"V{i}" for i in range(n)]
    lines = [f"{V[i]} -> {V[j]}" for i in range(n) for j in range(i + 1, n) if rng.random() < 0.45]
    lines += [f"{a} <-> {b}" for a, b in itertools.combinations(V, 2) if rng.random() < 0.15]
    return "\n".join(lines + V)


@pytest.mark.parametrize("seed", [3, 4])
def test_random_graphs(seed):
    rng = random.Random(seed)
    texts = [random_dag(rng) for _ in range(30)]
    graphs = [mgraph(p["spec"]) for p in json.loads(run_node({"action": "parse", "texts": texts}))]
    items = []
    for t, g in zip(texts, graphs):
        obs = sorted(g.fully_observed)
        qs = [{"X": [x], "Y": [y]} for x, y in itertools.permutations(obs, 2)]
        if len(obs) >= 3:
            x, y, z = rng.sample(obs, 3)
            qs += [{"X": [x], "Y": [y], "Z": [z]}]
            x1, x2, y = rng.sample(obs, 3)
            qs += [{"X": [x1, x2], "Y": [y]}]
        items.append({"text": t, "queries": qs})
    out = json.loads(run_node({"action": "effect", "items": items}))
    n_id = n_adj = 0
    for t, g, res in zip(texts, graphs, out):
        for r in res:
            assert "error" not in r, (t, r)
            if r["identifiable"]:
                n_id += 1
                assert max_error(g, r["expr"], r["X"], r["Y"], r["Z"]) < 1e-9, (t, r["X"], r["Y"], r["Z"], r["text"])
            else:
                # completeness cross-check: no adjustment set or front-door set may exist
                assert not (r.get("adjustment") or {}).get("exists"), (t, r)
                assert not r.get("frontDoor"), (t, r)
            for ex in r.get("adjustmentExprs", []) + r.get("frontDoorExprs", []):
                n_adj += 1
                assert max_error(g, ex, r["X"], r["Y"], []) < 1e-9, (t, r)
    assert n_id > 200 and n_adj > 100


@pytest.fixture(scope="module")
def gallery():
    return {e["key"]: e for e in json.loads(run_node({"action": "gallery"}))}


def test_paper_and_textbook_examples(gallery):
    items, meta = [], []
    for k, e in gallery.items():
        for c in e["expect"].get("causal", []):
            items.append({"gallery": k, "queries": [{"X": c["x"], "Y": c["y"]}]})
            meta.append((k, c))
    out = json.loads(run_node({"action": "effect", "items": items}))
    for (k, c), res in zip(meta, out):
        r = res[0]
        if "identifiable" in c:
            assert r["identifiable"] == c["identifiable"], k
        if "recoverable" in c:
            assert r["recoverable"] == c["recoverable"], k
        if c.get("adjustment") is not None:
            assert r["adjustment"]["minimal"] == [sorted(z) for z in c["adjustment"]], k
        if "adjustment" in c and c["adjustment"] is None:
            assert not r["adjustment"]["exists"], k
        if c.get("frontdoor"):
            assert r["frontDoor"] == [sorted(m) for m in c["frontdoor"]], k
        if c.get("instruments"):
            assert [i["z"] for i in r["instruments"]] == c["instruments"], k
        if r.get("expr"):
            assert max_error(mgraph(gallery[k]["spec"]), r["expr"], r["X"], r["Y"], []) < 1e-9, k


def test_equation_12_and_equation_6(gallery):
    out = json.loads(run_node({"action": "effect", "items": [{"gallery": "mp-fig7a", "queries": [{"X": ["Z"], "Y": ["Y"]}]}]}))
    assert out[0][0]["text"] == "Σ_{W} P(W | R_Y = 0) P(Y* | R_Y = 0, W, Z)"
    rec = json.loads(run_node({"action": "recover", "items": [{"gallery": "mp-fig5a", "queries": [{"target": ["X"]}]}]}))[0]["results"][0]
    assert rec["method"] == "intervention"
    assert rec["text"] == "(Σ_{R_Y} P(R_Y) P(R_X = 0 | R_Y, R_Z = 0) P(X* | R_X = 0, R_Y, R_Z = 0)) / (Σ_{R_Y} P(R_Y) P(R_X = 0 | R_Y, R_Z = 0))"


def test_hedge_for_the_bow_arc(gallery):
    out = json.loads(run_node({"action": "effect", "items": [{"gallery": "mp-fig7c", "queries": [{"X": ["X"], "Y": ["Y"]}]}]}))
    r = out[0][0]
    assert r["identifiable"] is False and r["hedge"] == {"F": ["X", "Y"], "Fprime": ["Y"]}
