"""Mohan & Pearl (2021): classification, recoverability and testability.

Every recoverable answer is an estimand that is evaluated on random discrete models and
compared with the truth from the full joint distribution. Runs the page's engine in Node.
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


def queries_for(g, limit=60):
    V = sorted(g.fully_observed | g.partially_observed)
    Vm = sorted(g.partially_observed)
    qs = [{"target": [x]} for x in Vm] + [{"target": V}]
    qs += [{"target": [a, b]} for a, b in itertools.combinations(V, 2) if a in Vm or b in Vm]
    qs += [{"target": [x], "given": [z]} for x in Vm for z in V if z != x]
    return qs[:limit]


def assert_correct(g, results, label, n_models=2):
    """Every recoverable answer matches the truth; returns counts."""
    counts = {True: 0, False: 0, None: 0}
    for r in results:
        assert "error" not in r, (label, r)
        counts[r["recoverable"]] += 1
        if r["recoverable"] is not True:
            continue
        T, S = r["target"], r["given"]
        assert free_symbols(r["expr"]) <= set(T) | set(S), (label, r["text"])
        for seed in range(n_models):
            m = RandomModel(g, seed=seed)
            obs, truth = m.observed(), m.truth(T, S)
            err = max(abs(evaluate(r["expr"], obs, dict(zip(T + S, v))) - p) for v, p in truth.items())
            assert err < 1e-9, f"{label}: {r['method']} for P({T} | {S}) is off by {err:.3g}: {r['text']}"
    return counts


@pytest.fixture(scope="module")
def gallery():
    return {e["key"]: e for e in json.loads(run_node({"action": "gallery"}))}


@pytest.fixture(scope="module")
def gallery_results(gallery):
    entries = [e for e in gallery.values() if mgraph(e["spec"]).partially_observed]
    out = json.loads(run_node({"action": "recover", "items": [{"gallery": e["key"], "queries": queries_for(mgraph(e["spec"]))} for e in entries]}))
    return {e["key"]: (e, r) for e, r in zip(entries, out)}


def test_every_gallery_estimand_is_correct(gallery_results):
    total = 0
    for key, (e, res) in gallery_results.items():
        total += assert_correct(mgraph(e["spec"]), res["results"], key)[True]
    assert total > 100


def test_mechanisms_match_the_paper(gallery_results):
    for key, (e, res) in gallery_results.items():
        expected = e["expect"].get("mechanism")
        if expected:
            assert res["classify"]["mechanism"] == expected, key


def test_paper_recoverability_claims(gallery):
    items, claims = [], []
    for e in gallery.values():
        for c in e["expect"].get("recover", []):
            target, _, given = c["target"].partition("|")
            q = {"target": [v.strip() for v in target.split(",")], "given": [v.strip() for v in given.split(",") if v.strip()]}
            items.append({"gallery": e["key"], "queries": [q]})
            claims.append((e, c))
    out = json.loads(run_node({"action": "recover", "items": items}))
    for (e, c), res in zip(claims, out):
        r = res["results"][0]
        assert r["recoverable"] == c["recoverable"], (e["key"], c, r["method"], r["reason"])
        if c.get("by") == "intervention":
            assert r["method"] == "intervention", (e["key"], r["method"])
        if c.get("by") == "Theorem 3" or (c.get("by") == "Theorem 2" and not c["recoverable"]):
            assert r["method"] == "Theorem 3"
        if c.get("completeCases") is not None:
            assert r["completeCases"] == c["completeCases"], (e["key"], c)
        if c.get("availableCases") is not None:
            assert r["availableCases"] == c["availableCases"], (e["key"], c)
        assert_correct(mgraph(e["spec"]), [r], e["key"])


def test_example_4b_needs_r_factorisation(gallery):
    out = json.loads(run_node({"action": "recover", "items": [{"gallery": "mp-fig4b", "queries": [{"target": ["X", "Y"]}]}]}))
    assert out[0]["results"][0]["method"] == "R-factorisation"


def random_mgraph(rng):
    nv = rng.randint(2, 5)
    V = [f"V{i}" for i in range(nv)]
    partial = [v for v in V if rng.random() < 0.6] or [V[0]]
    lines = [f"{V[i]} -> {V[j]}" for i in range(nv) for j in range(i + 1, nv) if rng.random() < 0.4]
    Rs = [f"R_{v}" for v in partial]
    for k, r in enumerate(Rs):
        lines += [f"{v} -> {r}" for v in V if rng.random() < 0.3]
        lines += [f"{r2} -> {r}" for r2 in Rs[:k] if rng.random() < 0.2]
    lines += [f"{a} <-> {b}" for a, b in itertools.combinations(V + Rs, 2) if rng.random() < 0.08]
    return "\n".join(lines + V + Rs)


@pytest.mark.parametrize("seed", [11, 12])
def test_random_m_graphs(seed):
    rng = random.Random(seed)
    texts = [random_mgraph(rng) for _ in range(40)]
    specs = [p["spec"] for p in json.loads(run_node({"action": "parse", "texts": texts}))]
    graphs = [mgraph(s) for s in specs]
    out = json.loads(run_node({"action": "recover", "items": [{"text": t, "queries": queries_for(g, 30)} for t, g in zip(texts, graphs)]}))
    counts = {True: 0, False: 0, None: 0}
    for i, (g, res) in enumerate(zip(graphs, out)):
        for k, v in assert_correct(g, res["results"], texts[i]).items():
            counts[k] += v
    assert counts[True] > 100 and counts[False] > 50


def test_no_method_succeeds_where_theorem_3_proves_non_recoverability(gallery):
    """Run every recovery method even when Theorem 3 applies: none may succeed."""
    rng = random.Random(5)
    texts = [random_mgraph(rng) for _ in range(40)]
    specs = [p["spec"] for p in json.loads(run_node({"action": "parse", "texts": texts}))]
    items = [{"text": t, "queries": queries_for(mgraph(s), 30)} for t, s in zip(texts, specs)]
    items += [{"gallery": k, "queries": queries_for(mgraph(e["spec"]))} for k, e in gallery.items() if mgraph(e["spec"]).partially_observed]
    out = json.loads(run_node({"action": "recover", "items": items, "ignoreTheorem3": True}))
    proofs = 0
    for item, res in zip(items, out):
        for r in res["results"]:
            if r["theorem3"]:
                proofs += 1
                assert r["recoverable"] is not True, (item.get("text") or item.get("gallery"), r["target"], r["given"], r["method"], r["text"])
    assert proofs > 50


def test_testability(gallery_results):
    # the paper writes Z ⊥⊥ R_Z | X, Y; the minimal separating set is {Y} (Z -> X -> Y -> R_Z)
    t = gallery_results["mp-fig8d"][1]["testability"]
    assert [u["statement"] for u in t["untestable"]] == ["Z _||_ R_Z | Y"] and t["untestable"][0]["theorem4"]
    assert gallery_results["mp-fig8a"][1]["testability"]["untestable"][0]["statement"] == "X _||_ R_X"
    assert gallery_results["mp-fig1c"][1]["testability"]["vmar"] is False  # one partially observed variable
    assert gallery_results["mp-fig4a"][1]["testability"]["vmar"] is True
