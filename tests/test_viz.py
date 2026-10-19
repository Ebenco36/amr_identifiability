"""The explorer page, the browser code's agreement with Python, and figure export.

Tests that run the browser modules need Node.js and are skipped without it.
"""

import json
import re
import shutil

import pytest

from amr_identifiability import (
    ConditionCatalogue,
    build_model,
    find_recovery,
    r_factorisation_problems,
)
from amr_identifiability.cli import main
from amr_identifiability.viz import Explorer, FigureExportError, run_node
from amr_identifiability.viz.page import CORE_MODULES, UI_MODULES, asset_path, build_page
from amr_identifiability.viz.payload import default_models, describe, model_payload

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")

STATEMENTS = [
    "Yk _||_ R_Yk | Yj1, Yj2, Yj3, Yj4, S, W, T",
    "Yk _||_ R_Yk | S, W, T",
    "Yj1 _||_ R_Yj1 | S, W, T",
    "Yj1 _||_ R_Yj2 | S, W, T, R_Yj1",
    "Yj _||_ R_Yj | C, T",
    "A, B _||_ R_Yk | Yj, S, W, T",
    "B_star _||_ Yk_star | A, C, R_B, R_Yk",
    "R_B _||_ R_G",
    "Yk _||_ T",
]


class TestPage:
    def test_assets_exist(self):
        for name in CORE_MODULES + UI_MODULES + ("template.html", "css/app.css"):
            assert asset_path(name).is_file(), name

    def test_page_is_self_contained(self):
        page = Explorer().html()
        assert page.startswith("<!doctype html>")
        assert "/*__JS__*/" not in page and "__DATA__" not in page
        assert not re.search(r'<script[^>]+src=|<link[^>]+href="http', page), "page must work offline"
        assert page.lower().count("</script>") == 4  # data, state, engine, interface

    def test_data_round_trips(self):
        page = Explorer().html()
        data = json.loads(re.search(r'id="mg-data">(.*?)</script>', page, re.S).group(1))
        assert [m["key"] for m in data["models"]] == ["M1-4", "M2-4", "M3-4", "M1-1", "M2-1", "M3-1"]
        m1 = data["models"][0]
        assert len(m1["nodes"]) == 32 and len(m1["edges"]) == 56

    def test_state_is_escaped(self):
        page = build_page({"models": []}, {"statement": "</script><b>"})
        assert "</script><b>" not in page

    def test_explorer_options(self):
        ex = Explorer(select="M3-1", statement="Yk _||_ R_Yk | Yj, S, W, T", node="Yk", tab="query")
        assert ex.state == {"modelKey": "M3-1", "statement": "Yk _||_ R_Yk | S, T, W, Yj", "tab": "query", "node": "Yk"}
        with pytest.raises(KeyError):
            Explorer(statement="nope _||_ Yk")
        with pytest.raises(KeyError):
            Explorer(select="M9")

    def test_single_graph(self):
        ex = Explorer(build_model("M2", 2))
        assert [m["key"] for m in ex.models] == ["M2-2"]
        assert all("x" in n for n in ex.models[0]["nodes"])  # fallback layout for Yj1, Yj2

    def test_descriptions(self):
        assert describe("R_Yj3") == "missingness of the result for upstream antibiotic 3"
        assert describe("Yj_star") == "recorded resistance to the upstream antibiotic"

    def test_notebook_repr(self):
        assert Explorer(build_model("M1", 1))._repr_html_().startswith("<iframe srcdoc=")

    def test_save_html(self, tmp_path):
        path = Explorer().save(tmp_path / "x.html")
        assert path.stat().st_size > 50_000

    def test_png_needs_the_browser(self, tmp_path):
        with pytest.raises(FigureExportError):
            Explorer().save(tmp_path / "x.png")


@needs_node
class TestBrowserCodeAgreesWithPython:
    """The page computes everything in JavaScript; it must give the Python answers."""

    @pytest.fixture(scope="class")
    def results(self):
        models = default_models() + [(build_model("M1", 2).with_changes(add=[("Yj1", "R_Yj2")], name="M1 cascade"), "cascade", "M1", 2)]
        job = {"action": "analyse", "models": [model_payload(g, k, f, n) for g, k, f, n in models], "statements": STATEMENTS}
        out = json.loads(run_node(job))
        return list(zip(models, out))

    def test_catalogue(self, results):
        for (g, key, _, _), r in results:
            cat = ConditionCatalogue(g)
            py = {(p.x, p.y): ([sorted(z) for z in p.separators], [sorted(z) for z in p.testable], p.adjacent) for p in cat.pairs}
            js = {(p["x"], p["y"]): (p["separators"], p["testable"], p["adjacent"]) for p in r["pairs"]}
            assert py == js, key

    def test_local_markov(self, results):
        for (g, key, _, _), r in results:
            cat = ConditionCatalogue(g)
            for n in cat.nodes:
                lm = cat.local_markov(n)
                assert (str(lm) if lm else None) == r["localMarkov"][n], (key, n)

    def test_structure(self, results):
        for (g, key, _, _), r in results:
            assert g.self_masking() == r["selfMasking"], key
            assert g.validate() == r["validate"], key
            assert r_factorisation_problems(g) == r["rFactorisation"], key

    def test_recovery(self, results):
        for (g, key, _, _), r in results:
            py = [[list(x.order), list(x.covariates), x.functional] for x in find_recovery(g, "Yk", max_covariates=3, limit=5)]
            js = [[x["order"], x["covariates"], x["functional"]] for x in r["recovery"]]
            assert py == js, key

    def test_statements(self, results):
        from amr_identifiability import Independence

        for (g, key, _, _), r in results:
            for text, js in zip(STATEMENTS, r["statements"]):
                ind = Independence.parse(text)
                if not ind.x | ind.y | ind.z <= g.nodes:
                    assert js is None
                    continue
                assert js["implied"] == g.implies(ind), (key, text)
                assert js["testable"] == g.is_testable(ind), (key, text)
                assert js["recorded"] == (g.recorded_form(ind) if g.is_testable(ind) else None), (key, text)
                if js["open"] is not None:  # an open path exists exactly when not implied
                    assert (js["open"] > 0) == (not js["implied"]), (key, text)


@needs_node
class TestFigures:
    def test_svg(self, tmp_path):
        path = Explorer(statement="Yk _||_ R_Yk | S, W, T").save(tmp_path / "f.svg", title="Test")
        text = path.read_text()
        assert text.startswith("<svg") and text.rstrip().endswith("</svg>")
        assert "Yk independent of R_Yk given S, T, W: NOT implied" in text
        assert "#C8510A" in text  # open paths drawn

    def test_pdf(self, tmp_path):
        path = Explorer().save(tmp_path / "f.pdf", title="M1")
        data = path.read_bytes()
        assert data.startswith(b"%PDF-1.4") and data.rstrip().endswith(b"%%EOF")
        # the cross-reference table points at each object
        xref = int(data[data.rindex(b"startxref") + 9:].split()[0])
        assert data[xref:xref + 4] == b"xref"
        offsets = [int(line.split()[0]) for line in data[xref:].split(b"\n")[3:10]]
        for i, off in enumerate(offsets, start=1):
            assert data[off:].startswith(f"{i} 0 obj".encode())
        length = int(re.search(rb"/Length (\d+) >>\nstream\n", data).group(1))
        start = data.index(b"stream\n") + 7
        assert data[start + length:start + length + 10] == b"\nendstream"

    def test_spacing(self, tmp_path):
        tight = Explorer().save(tmp_path / "a.svg")
        loose = Explorer().save(tmp_path / "b.svg", spacing=1)
        width = lambda p: int(re.search(r'width="(\d+)"', p.read_text()).group(1))
        assert width(tight) < width(loose)

    def test_cli(self, tmp_path, capsys):
        out = tmp_path / "f.pdf"
        assert main(["figure", str(out), "--statement", "Yj1 _||_ R_Yj1 | S, W, T", "--model", "M2"]) == 0
        assert out.read_bytes().startswith(b"%PDF")


def test_cli_conditions_and_viz(tmp_path, capsys):
    assert main(["conditions", "--node", "Yk", "--upstream", "1"]) == 0
    assert "R_Yk       given C, T, Yj" in capsys.readouterr().out
    assert main(["conditions", "--csv", str(tmp_path / "c.csv")]) == 0
    assert (tmp_path / "c.csv").exists()
    assert main(["viz", "--out", str(tmp_path / "e.html"), "--statement", "Yk _||_ R_Yk | S, W, T"]) == 0
    assert "Yk _||_ R_Yk | S, T, W" in (tmp_path / "e.html").read_text()
