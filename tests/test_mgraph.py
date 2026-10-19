import pytest

from amr_identifiability import Independence, MGraph


def chain_fork_collider() -> MGraph:
    # chain a -> b -> c, fork b <- d -> e, collider c -> f <- e, f -> g
    return MGraph([("a", "b"), ("b", "c"), ("d", "b"), ("d", "e"), ("c", "f"), ("e", "f"), ("f", "g")], name="toy")


def missing_toy(extra=()) -> MGraph:
    # X fully observed, Y partially observed with indicator R_Y and proxy Y_star
    edges = [("X", "Y"), ("X", "R_Y"), ("Y", "Y_star"), ("R_Y", "Y_star"), *extra]
    return MGraph(edges, latent={n for e in extra for n in e if n.startswith("U")})


class TestIndependence:
    def test_parse_and_print(self):
        ind = Independence.parse("Yk _||_ R_Yk, R_Yj | Yj, S W,T")
        assert ind.x == {"Yk"} and ind.y == {"R_Yk", "R_Yj"} and ind.z == {"Yj", "S", "W", "T"}
        assert str(ind) == "Yk _||_ R_Yj, R_Yk | S, T, W, Yj"

    def test_parse_without_given(self):
        assert Independence.parse("a _||_ b").z == frozenset()

    @pytest.mark.parametrize("text", ["a b", "_||_ b", "a _||_ | c"])
    def test_parse_rejects(self, text):
        with pytest.raises(ValueError):
            Independence.parse(text)


class TestDSeparation:
    def test_chain_blocked_by_middle(self):
        g = chain_fork_collider()
        assert not g.is_d_separated("a", "c")
        assert g.is_d_separated("a", "c", "b")

    def test_fork_blocked_by_root(self):
        g = chain_fork_collider()
        assert not g.is_d_separated("b", "e")
        assert g.is_d_separated("b", "e", "d")

    def test_collider_opened_by_descendant(self):
        g = chain_fork_collider()
        assert g.is_d_separated("c", "e", "b")
        assert not g.is_d_separated("c", "e", {"b", "g"})

    def test_implies_accepts_text(self):
        assert chain_fork_collider().implies("a _||_ e")

    def test_bad_queries(self):
        g = chain_fork_collider()
        with pytest.raises(KeyError):
            g.is_d_separated("a", "nope")
        with pytest.raises(ValueError):
            g.is_d_separated("a", "a")
        with pytest.raises(ValueError):
            g.is_d_separated("a", "c", {"a"})

    def test_paths_and_reasons(self):
        g = chain_fork_collider()
        reports = {r.path: r for r in g.paths("c", "e", "b")}
        assert not reports[("c", "b", "d", "e")].open
        assert "b conditioned on" in reports[("c", "b", "d", "e")].reason
        assert "collider f" in reports[("c", "f", "e")].reason
        opened = g.paths("c", "e", {"b", "g"}, only_open=True)
        assert [r.path for r in opened] == [("c", "f", "e")]
        assert str(opened[0]).startswith("OPEN")

    def test_explain(self):
        text = chain_fork_collider().explain("c _||_ e | b, g")
        assert "NOT implied" in text and "c -> f <- e" in text


class TestRoles:
    def test_roles(self):
        g = missing_toy()
        assert g.partially_observed == {"Y"}
        assert g.indicators == {"R_Y"} and g.proxies == {"Y_star"}
        assert g.fully_observed == {"X"}
        assert g.role("R_Y") == "missingness indicator"

    def test_validate_flags_proxy_with_child(self):
        g = missing_toy(extra=[("Y_star", "X2")])
        assert any("must have no children" in p for p in g.validate())

    def test_validate_clean(self):
        assert missing_toy().validate() == []

    def test_cycle_rejected(self):
        with pytest.raises(ValueError):
            MGraph([("a", "b"), ("b", "a")])


class TestSelfMasking:
    def test_direct(self):
        assert "direct edge" in missing_toy(extra=[("Y", "R_Y")]).self_masking()["Y"]

    def test_through_latent(self):
        assert "latent nodes only" in missing_toy(extra=[("Y", "U1"), ("U1", "R_Y")]).self_masking()["Y"]

    def test_latent_common_cause(self):
        assert "unrecorded cause" in missing_toy(extra=[("U2", "Y"), ("U2", "R_Y")]).self_masking()["Y"]

    def test_none(self):
        assert missing_toy().self_masking() == {}


class TestTestability:
    def test_partially_observed_needs_its_indicator(self):
        g = missing_toy()
        assert not g.is_testable("Y _||_ X")
        assert g.is_testable("Y _||_ X | R_Y")

    def test_latent_not_testable(self):
        g = missing_toy(extra=[("U2", "X")])
        assert not g.is_testable("U2 _||_ R_Y")

    def test_recorded_form(self):
        assert missing_toy().recorded_form("Y _||_ X | R_Y") == "Y_star _||_ X | R_Y = 0"

    def test_implications_are_implied_and_testable(self):
        g = MGraph([("X", "Y"), ("Z", "R_Y"), ("Y", "Y_star"), ("R_Y", "Y_star")])
        found = g.testable_implications()
        assert found, "expected at least one implication"
        for ind in found:
            assert g.implies(ind) and g.is_testable(ind)
        assert Independence.of("Y", "Z", "R_Y") in found


def test_with_changes_leaves_original_alone():
    g = chain_fork_collider()
    h = g.with_changes(add=[("a", "e")], remove=[("f", "g")])
    assert ("a", "e") in h.edges and ("f", "g") not in h.edges
    assert ("a", "e") not in g.edges and ("f", "g") in g.edges
    with pytest.raises(ValueError):
        g.with_changes(remove=[("x", "y")])
