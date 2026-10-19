import pytest

from amr_identifiability import build_model, find_recovery, ordered_factorisation, r_factorisation_problems
from amr_identifiability.cli import main

UP = ["Yj1", "Yj2", "Yj3", "Yj4"]
Z = ["S", "W", "T"]


class TestPrimaryClaim:
    """The framework document's claim: Yk is recoverable with Z = (S, W, T) in M1 only."""

    @pytest.mark.parametrize("name, expected", [("M1", True), ("M2", False), ("M3", False)])
    def test_single_upstream(self, name, expected):
        assert ordered_factorisation(build_model(name, 1), ["Yj", "Yk"], Z).recoverable is expected

    @pytest.mark.parametrize("name, expected", [("M1", True), ("M2", False), ("M3", False)])
    def test_four_upstream(self, name, expected):
        assert ordered_factorisation(build_model(name, 4), UP + ["Yk"], Z).recoverable is expected

    def test_m3_fails_at_the_downstream_step(self):
        rec = ordered_factorisation(build_model("M3", 1), ["Yj", "Yk"], Z)
        assert [s.holds for s in rec.steps] == [True, False]

    def test_m2_fails_at_the_upstream_step(self):
        rec = ordered_factorisation(build_model("M2", 1), ["Yj", "Yk"], Z)
        assert rec.steps[0].holds is False

    def test_functional_text(self):
        rec = ordered_factorisation(build_model("M1", 1), ["Yj", "Yk"], Z)
        assert rec.functional == (
            "P(Yk | S, T, W) = sum over Yj of P(Yj | S, T, W, R_Yj = 0) * P(Yk | Yj, S, T, W, R_Yj = 0, R_Yk = 0)"
        )


class TestSearch:
    def test_finds_a_recovery_in_m1(self):
        found = find_recovery(build_model("M1", 1), "Yk", max_covariates=3)
        assert found and all(r.recoverable for r in found)
        assert all("Yj" in r.order for r in found), "the upstream result is needed"

    def test_respects_supplied_covariates(self):
        found = find_recovery(build_model("M1", 1), "Yk", covariates=Z)
        assert found and set(found[0].covariates) <= set(Z)

    def test_none_in_m3(self):
        assert find_recovery(build_model("M3", 1), "Yk", max_covariates=3) == []

    def test_target_must_be_partially_observed(self):
        with pytest.raises(ValueError):
            find_recovery(build_model("M1", 1), "S")


class TestUpstreamCascades:
    """Edges the ARMD data support: one upstream drug released on another's result."""

    def test_one_direction_still_recoverable_in_cascade_order(self):
        g = build_model("M1", 4).with_changes(add=[("Yj1", "R_Yj2")])
        assert ordered_factorisation(g, UP + ["Yk"], Z).recoverable
        assert not ordered_factorisation(g, ["Yj2", "Yj1", "Yj3", "Yj4", "Yk"], Z).recoverable

    def test_both_directions_break_ordered_and_r_factorisation(self):
        g = build_model("M1", 4).with_changes(add=[("Yj1", "R_Yj2"), ("Yj2", "R_Yj1")])
        assert find_recovery(g, "Yk", helpers=UP, covariates=Z) == []
        assert any("unrecorded common cause of R_Yj1 and R_Yj2" in p for p in r_factorisation_problems(g, UP))


def test_r_factorisation_reports_self_masking_in_m3():
    assert any("self-masking" in p for p in r_factorisation_problems(build_model("M3", 1)))


def test_order_must_use_partially_observed_variables():
    with pytest.raises(ValueError):
        ordered_factorisation(build_model("M1", 1), ["S", "Yk"])
    with pytest.raises(ValueError):
        ordered_factorisation(build_model("M1", 1), ["Yj", "Yk"], ["Yj"])


class TestCli:
    def test_compare(self, capsys):
        assert main(["compare", "Yk _||_ R_Yk | Yj, S, W, T", "--upstream", "1"]) == 0
        verdicts = {line[:24].strip(): line[24:].strip() for line in capsys.readouterr().out.splitlines()}
        assert verdicts == {
            "M1 (single upstream)": "implied",
            "M2 (single upstream)": "NOT implied",
            "M3 (single upstream)": "NOT implied",
        }

    def test_query_reports_testable_form(self, capsys):
        main(["query", "Yj1 _||_ R_Yj2 | S, W, T, R_Yj1"])
        assert "Yj1_star _||_ R_Yj2 | S, T, W, R_Yj1 = 0" in capsys.readouterr().out

    def test_recover_with_order(self, capsys):
        assert main(["recover", "--upstream", "1", "--order", "Yj", "Yk", "--covariates", "S", "W", "T"]) == 0
        assert "RECOVERABLE" in capsys.readouterr().out

    def test_bad_node_is_an_error_not_a_crash(self, capsys):
        assert main(["query", "nope _||_ Yk"]) == 2
        assert "error" in capsys.readouterr().err

    @pytest.mark.parametrize("command", [["show"], ["implications"], ["export"], ["paths", "Yk", "R_Yk", "--open"]])
    def test_other_commands_run(self, command, capsys):
        assert main(command) == 0
        assert capsys.readouterr().out
