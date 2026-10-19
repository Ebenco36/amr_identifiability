"""Bringing your own DAG: the page's reader, automatic layout and the gallery.

These run the browser modules in Node and are skipped without it.
"""

import json
import shutil
from itertools import combinations
from pathlib import Path

import pytest

from amr_identifiability import MGraph, load_dagitty
from amr_identifiability.viz import Explorer, run_node

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
ROOT = Path(__file__).resolve().parents[1]


def parse(*texts):
    return json.loads(run_node({"action": "parse", "texts": list(texts)}))


def as_mgraph(spec):
    return MGraph([tuple(e) for e in spec["edges"]], latent=[n["id"] for n in spec["nodes"] if n.get("latent")],
                  nodes=[n["id"] for n in spec["nodes"]])


class TestReader:
    def test_formats(self):
        dagitty, edges, js, dot = parse(
            'dag { "A: age" -> X  X [exposure,pos="0,1"] Y [outcome] X -> Y  Y <- Z  U [latent] U -> {X Y} }',
            "# comment\nA -> B\nB <- C\nA <-> C\n",
            '{"nodes": ["P"], "edges": [["P", "Q"], {"from": "Q", "to": "S", "type": "<->"}]}',
            'digraph G { rankdir=LR; node [shape=box]; a -> b -> c; "my node" -> c [label="x"]; }',
        )
        assert dagitty["format"] == "DAGitty"
        g = as_mgraph(dagitty["spec"])
        assert g.edges == {("A", "X"), ("X", "Y"), ("Z", "Y"), ("U", "X"), ("U", "Y")} and g.latent == {"U"}
        a = next(n for n in dagitty["spec"]["nodes"] if n["id"] == "A")
        assert a["description"] == "age"
        assert next(n for n in dagitty["spec"]["nodes"] if n["id"] == "X")["exposure"]
        assert as_mgraph(edges["spec"]).edges == {("A", "B"), ("C", "B"), ("L_A_C", "A"), ("L_A_C", "C")}
        assert as_mgraph(js["spec"]).latent == {"L_Q_S"}
        assert dot["format"] == "Graphviz" and ("my_node", "c") in as_mgraph(dot["spec"]).edges
        assert any("renamed" in w for w in dot["warnings"])

    def test_proxies_added_for_indicators(self):
        (r,) = parse("X -> Y\nX -> R_Y")
        g = as_mgraph(r["spec"])
        assert g.partially_observed == {"Y"} and ("R_Y", "Y_star") in g.edges and ("Y", "Y_star") in g.edges
        assert g.validate() == []

    @pytest.mark.parametrize("text, message", [
        ("dag { a -> b b -> a }", "cycle"),
        ("graph { a -- b }", "digraph"),
        ("A -- B", "undirected"),
        ("pag { a -> b }", "not DAGs"),
        ("", "empty"),
        ("{ not json", "JSON"),
    ])
    def test_errors_are_explained(self, text, message):
        (r,) = parse(text)
        assert message in r["error"]

    def test_same_graphs_as_the_python_reader(self):
        files = sorted((ROOT / "m_DAG").glob("M*.txt"))
        assert files
        results = parse(*[f.read_text() for f in files])
        for f, r in zip(files, results):
            py = load_dagitty(f)
            js = as_mgraph(r["spec"])
            assert js.edges == py.edges and js.latent == py.latent and js.nodes == py.nodes, f.name

    def test_layout_without_coordinates_has_no_overlaps(self):
        (r,) = parse("\n".join(f"V{i} -> V{j}" for i in range(9) for j in range(i + 1, 9) if (i * 7 + j) % 3 == 0))
        boxes = [(n["x"], n["y"]) for n in r["spec"]["nodes"]]
        for (x1, y1), (x2, y2) in combinations(boxes, 2):
            assert abs(x1 - x2) > 40 or abs(y1 - y2) > 30


class TestGallery:
    @pytest.fixture(scope="class")
    def gallery(self):
        return json.loads(run_node({"action": "gallery"}))

    def test_every_figure_of_the_paper_is_there(self, gallery):
        keys = {e["key"] for e in gallery}
        for k in ["mp-fig1b", "mp-fig1c", "mp-fig1d", "mp-fig3", "mp-fig4a", "mp-fig4b", "mp-fig4c", "mp-fig5a", "mp-fig5c",
                  "mp-fig6a", "mp-fig6b", "mp-fig7a", "mp-fig7c", "mp-fig8a", "mp-fig8b", "mp-fig8c", "mp-fig8d"]:
            assert k in keys

    def test_entries_are_valid_m_graphs(self, gallery):
        for e in gallery:
            g = as_mgraph(e["spec"])
            assert g.validate() == [], e["key"]
            assert all(isinstance(n["x"], (int, float)) for n in e["spec"]["nodes"]), e["key"]

    def test_nodes_do_not_overlap(self, gallery):
        for e in gallery:
            nodes = e["spec"]["nodes"]
            for a, b in combinations(nodes, 2):
                assert abs(a["x"] - b["x"]) > 30 or abs(a["y"] - b["y"]) > 24, (e["key"], a["id"], b["id"])

    def test_figure_3_structure(self, gallery):
        g = as_mgraph(next(e for e in gallery if e["key"] == "mp-fig3")["spec"])
        assert g.partially_observed == {"Z1", "Z2", "X", "Y"}
        assert g.self_masking() == {"X": "direct edge X -> R_X", "Z2": "direct edge Z2 -> R_Z2"}
        assert g.implies("Y _||_ R_X, R_Y, R_Z1, R_Z2 | X, Z1, Z2")  # Example 2
        assert g.implies("Z1 _||_ R_Z1") and not g.implies("Z1 _||_ R_X")  # Corollary 2 discussion

    def test_example_4_printed_graph_is_self_masking(self, gallery):
        printed = as_mgraph(next(e for e in gallery if e["key"] == "mp-ex4-g1-printed")["spec"])
        derived = as_mgraph(next(e for e in gallery if e["key"] == "mp-ex4-g1")["spec"])
        assert not printed.implies("X _||_ R_X, R_Y | Y")  # the paper's step fails as printed
        assert derived.implies("X _||_ R_X, R_Y | Y") and derived.implies("Y _||_ R_Y | R_X")


def test_explorer_accepts_text_graphs(tmp_path):
    f = tmp_path / "mine.txt"
    f.write_text("dag { A -> B B -> R_A }")
    ex = Explorer(texts=[f, "X -> Y"], builtins=False)
    assert [i["name"] for i in ex.imports] == ["mine", "Graph 2"]
    out = ex.save(tmp_path / "fig.svg")
    assert out.read_text().startswith("<svg")
    data = json.loads(ex.html().split('id="mg-data">', 1)[1].split("</script>", 1)[0])
    assert data["imports"][0]["text"] == "dag { A -> B B -> R_A }" and data["models"] == []
