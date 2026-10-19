import pytest

from amr_identifiability import build_model, load_dagitty, parse_dagitty, to_dagitty


def test_file_reads_every_arrow(dagitty_file):
    path, _ = dagitty_file
    text = path.read_text()
    assert load_dagitty(path).graph.number_of_edges() == text.count("->")


def test_built_model_equals_file(dagitty_file):
    """The models in code and the DAGitty files must not drift apart."""
    path, (name, n_upstream) = dagitty_file
    from_file, built = load_dagitty(path), build_model(name, n_upstream)
    assert from_file.edges == built.edges
    assert from_file.latent == built.latent
    assert from_file.nodes == built.nodes


def test_round_trip(dagitty_file):
    path, _ = dagitty_file
    g = load_dagitty(path)
    again = parse_dagitty(to_dagitty(g))
    assert again.edges == g.edges and again.latent == g.latent
    assert again.positions.keys() == g.positions.keys()


@pytest.mark.parametrize("name", ["M1", "M2", "M3"])
@pytest.mark.parametrize("n_upstream", [1, 2, 4])
def test_models_are_valid_m_graphs(name, n_upstream):
    g = build_model(name, n_upstream)
    assert g.validate() == []
    masking = g.self_masking()
    results = g.partially_observed - {"B", "G"}
    if name == "M1":
        assert masking == {}
    elif name == "M2":
        # U_C -> U_B -> Y and U_C -> U_W -> R_Y for every culture result
        assert set(masking) == results
        assert all("unrecorded cause" in reason for reason in masking.values())
    else:
        assert masking == {"Yk": "direct edge Yk -> R_Yk"}


def test_m2_adds_only_u_c():
    m1, m2 = build_model("M1"), build_model("M2")
    assert m2.edges - m1.edges == {("U_C", "U_B"), ("U_C", "U_W")}
    assert m2.latent - m1.latent == {"U_C"}


def test_m3_adds_only_self_masking():
    assert build_model("M3").edges - build_model("M1").edges == {("Yk", "R_Yk")}


def test_unknown_model():
    with pytest.raises(ValueError):
        build_model("M4")


def test_parser_handles_quoted_labels_and_bidirected():
    g = parse_dagitty('dag {\n"A: long label" [latent,pos="1,2"]\nB\n"A: long label" -> B\nB <-> C\n}')
    assert ("A", "B") in g.edges and "A" in g.latent and g.positions["A"] == (1.0, 2.0)
    assert {"L_B_C"} <= g.latent and ("L_B_C", "C") in g.edges


def test_parser_rejects_non_dagitty():
    with pytest.raises(ValueError):
        parse_dagitty("graph { a -> b }")
