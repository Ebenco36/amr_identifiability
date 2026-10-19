import itertools
import random

import networkx as nx
import pytest

from amr_identifiability import ConditionCatalogue, MGraph, build_model
from amr_identifiability.separators import eliminate, minimal_d_separators, minimal_vertex_separators


def brute_force(g: nx.DiGraph, x, y, included, allowed):
    """Minimal separators by checking every subset, smallest first."""
    candidates = sorted(set(allowed) - {x, y} - set(included))
    found = []
    for k in range(len(candidates) + 1):
        for extra in itertools.combinations(candidates, k):
            z = set(included) | set(extra)
            if any(f <= z for f in found):
                continue
            if nx.is_d_separator(g, {x}, {y}, z):
                found.append(frozenset(z))
    return sorted(found, key=lambda s: (len(s), sorted(s)))


def random_dag(rng, n):
    order = [f"v{i}" for i in range(n)]
    g = nx.DiGraph()
    g.add_nodes_from(order)
    p = rng.uniform(0.15, 0.5)
    for i in range(n):
        for j in range(i + 1, n):
            if rng.random() < p:
                g.add_edge(order[i], order[j])
    return g, order


class TestSeparators:
    def test_matches_brute_force_on_random_graphs(self):
        rng = random.Random(7)
        checked = 0
        for _ in range(150):
            g, order = random_dag(rng, rng.randint(4, 9))
            latent = {v for v in order if rng.random() < 0.25}
            allowed = set(order) - latent
            for x, y in itertools.combinations(order, 2):
                if x in latent or y in latent:
                    continue
                pool = sorted(allowed - {x, y})
                included = {rng.choice(pool)} if pool and rng.random() < 0.3 else set()
                got, truncated = minimal_d_separators(g, x, y, included=included, allowed=allowed)
                assert not truncated
                assert got == brute_force(g, x, y, included, allowed), (sorted(g.edges), latent, x, y, included)
                checked += 1
        assert checked > 1000

    def test_adjacent_and_disconnected(self):
        adj = {"a": {"b"}, "b": {"a"}, "c": set()}
        assert minimal_vertex_separators(adj, "a", "b") == ([], False)
        assert minimal_vertex_separators(adj, "a", "c") == ([frozenset()], False)

    def test_eliminate_joins_through_hidden_nodes(self):
        adj = {"a": {"u"}, "u": {"a", "b"}, "b": {"u"}}
        assert eliminate(adj, {"u"}) == {"a": {"b"}, "b": {"a"}}

    def test_limit_reports_truncation(self):
        # four parallel two-step paths give 2**4 minimal separators
        edges = [("x", f"m{i}") for i in range(4)] + [(f"m{i}", f"n{i}") for i in range(4)] + [(f"n{i}", "y") for i in range(4)]
        g = nx.DiGraph(edges)
        everything, _ = minimal_d_separators(g, "x", "y")
        assert len(everything) == 16
        some, truncated = minimal_d_separators(g, "x", "y", limit=5)
        assert len(some) == 5 and truncated

    def test_required_node_cannot_be_an_endpoint(self):
        with pytest.raises(ValueError):
            minimal_d_separators(nx.DiGraph([("a", "b")]), "a", "b", included={"a"})


class TestCatalogue:
    @pytest.fixture(scope="class")
    def m1(self):
        return ConditionCatalogue(build_model("M1", 4))

    def test_counts(self, m1):
        assert len(m1.pairs) == 29 * 28 // 2
        assert sum(len(p.separators) for p in m1.pairs) == 669
        assert sum(len(p.testable) for p in m1.pairs) == 201

    def test_every_statement_holds(self, m1):
        g = m1.graph
        for s in m1.statements():
            assert g.implies(s), s

    def test_every_testable_statement_is_testable_and_holds(self, m1):
        g = m1.graph
        for s in m1.statements(testable_only=True):
            assert g.implies(s) and g.is_testable(s), s

    def test_separators_are_minimal(self, m1):
        g = m1.graph
        for p in m1.pairs:
            for z in p.separators:
                for drop in z:
                    assert not g.is_d_separated(p.x, p.y, z - {drop}), (p.x, p.y, z, drop)

    def test_the_mar_step_for_each_upstream(self, m1):
        for y in ["Yj1", "Yj2", "Yj3", "Yj4"]:
            assert set(m1.pair(y, f"R_{y}").separators) == {frozenset({"C", "T"}), frozenset({"S", "T", "W"})}

    def test_yk_needs_the_upstream_results(self, m1):
        seps = m1.pair("Yk", "R_Yk").separators
        assert all({"Yj1", "Yj2", "Yj3", "Yj4"} <= z for z in seps)

    def test_never_independent_reasons(self, m1):
        assert m1.pair("A", "Yk").adjacent
        assert not m1.pair("Yk", "C").separable and not m1.pair("Yk", "C").adjacent  # C -> U_B -> Yk

    def test_testable_cascade_implication(self, m1):
        assert frozenset({"R_Yj1", "S", "T", "W"}) in m1.pair("Yj1", "R_Yj2").testable

    def test_m2_loses_the_mar_step(self):
        cat = ConditionCatalogue(build_model("M2", 4))
        assert not cat.pair("Yj1", "R_Yj1").separable

    def test_m3_loses_the_downstream_step(self):
        cat = ConditionCatalogue(build_model("M3", 1))
        assert not cat.pair("Yk", "R_Yk").separable and cat.pair("Yk", "R_Yk").adjacent

    def test_local_markov(self, m1):
        lm = m1.local_markov("Yk")
        assert lm.z == {"A", "U_B"} and "Yk_star" not in lm.y and "R_Yk" in lm.y
        assert m1.graph.implies(lm)

    def test_report_and_csv(self, m1, tmp_path):
        text = m1.report("Yj1")
        assert "R_Yj1      given C, T" in text and "never independent" in text
        path = m1.to_csv(tmp_path / "c.csv")
        lines = path.read_text().splitlines()
        assert lines[0] == "x,y,given,statement,testable,recorded_form" and len(lines) == 670

    def test_unknown_nodes(self, m1):
        with pytest.raises(KeyError):
            m1.pair("U_B", "Yk")
        with pytest.raises(KeyError):
            ConditionCatalogue(build_model("M1", 1), nodes=["nope"])

    def test_small_graph_by_hand(self):
        g = MGraph([("X", "Y"), ("Z", "R_Y"), ("Y", "Y_star"), ("R_Y", "Y_star")])
        cat = ConditionCatalogue(g)
        assert cat.pair("Y", "Z").separators == (frozenset(),)
        assert cat.pair("Y", "Z").testable == (frozenset({"R_Y"}),)
        assert cat.pair("X", "R_Y").separators == (frozenset(),)
