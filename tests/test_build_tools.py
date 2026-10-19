"""The Build panel's editing rules, run in Node against the page's own modules.

Checks MG.Graph.edgeProblem (the m-graph rules of Mohan & Pearl 2021, Sec. 2.1), the typed-link
parser MG.parse.links, and Store.addLinks (one undoable step; new nodes; indicator names make a
variable partially observed; links that break a rule are skipped with a reason).
"""

import json
import shutil
import subprocess

import pytest

from amr_identifiability.viz import CORE_MODULES, asset_path

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")

SCRIPT = r"""
const fs = require("fs"), vm = require("vm");
for (const f of process.argv.slice(1)) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const MG = globalThis.MG;
MG.ui.toast = () => {};
const out = {};

const g = new MG.Graph({ nodes: ["X", "Y", "W", "R_Y", "Y_star", "U"],
  edges: [["X", "Y"], ["Y", "Y_star"], ["R_Y", "Y_star"], ["W", "R_Y"], ["U", "X"], ["U", "Y"]], latent: ["U"] });
out.problems = {};
for (const [a, b, k] of [["Y", "X"], ["X", "Y"], ["R_Y", "X"], ["X", "Y_star"], ["Y_star", "W"], ["X", "R_Y"],
                         ["Y", "R_Y"], ["X", "X"], ["Q", "X"], ["X", "Y", "bidirected"], ["W", "Y", "bidirected"], ["W", "Y_star", "bidirected"]])
  out.problems[`${a} ${k || "directed"} ${b}`] = g.edgeProblem(a, b, k);

out.parse = {};
for (const t of ["X -> R_Y -> R_Z", "U <-> Y; W", "X -> {R_Y W}, A <- B", "pre-op -> post-op"]) out.parse[t] = MG.parse.links(t);
out.parseErrors = {};
for (const t of ["", "A -- B", "A ->"]) {
  try { MG.parse.links(t); out.parseErrors[t] = null; } catch (e) { out.parseErrors[t] = e.message; }
}

const store = new MG.ui.Store({ models: [], defaultModel: null }, {});
store.addUserGraph({ name: "t", nodes: [], edges: [], source: "user" });
const rep = store.addLinks(MG.parse.links("X -> Y; W -> R_Y; Y -> R_Y; U <-> X; R_Y -> X; Y_star -> W; R_Y -> R_W"));
const sg = store.graph();
out.report = rep;
out.graph = { nodes: MG.sorted(sg.ids), edges: sg.edges.map((e) => e.join("->")).sort(), partial: MG.sorted(sg.partiallyObserved),
              validate: sg.validate(), selfMasking: sg.selfMasking() };
out.history = store.history.past.length;
store.addLinks(MG.parse.links("Q <-> X"));
const withQ = store.graph().ids.length;
store.deleteNode("Q");
out.deleteDropsCommonCause = { withQ, after: store.graph().ids.length, latent: MG.sorted(store.graph().latent) };
store.undo();
store.undo();
store.undo();
out.afterUndo = store.graph().ids.length;
console.log(JSON.stringify(out));
"""


@pytest.fixture(scope="module")
def result():
    files = [str(asset_path(m)) for m in CORE_MODULES] + [str(asset_path("js/ui/dom.js")), str(asset_path("js/ui/store.js"))]
    proc = subprocess.run([shutil.which("node"), "-e", SCRIPT, *files], capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_edge_rules(result):
    p = result["problems"]
    assert "cycle" in p["Y directed X"]
    assert "already" in p["X directed Y"]
    assert "missingness indicator" in p["R_Y directed X"]          # R -> V is not an m-graph edge
    assert "proxy" in p["X directed Y_star"] and "proxy" in p["Y_star directed W"]
    assert p["X directed R_Y"] is None and p["Y directed R_Y"] is None   # MAR and self-masking edges are allowed
    assert "itself" in p["X directed X"]
    assert "not in the graph" in p["Q directed X"]
    assert "already share" in p["X bidirected Y"]
    assert p["W bidirected Y"] is None
    assert "proxy" in p["W bidirected Y_star"]


def test_link_parser(result):
    p = result["parse"]
    assert p["X -> R_Y -> R_Z"]["edges"] == [["X", "R_Y"], ["R_Y", "R_Z"]]
    assert p["U <-> Y; W"] == {"nodes": ["U", "Y", "W"], "edges": [], "bidirected": [["U", "Y"]]}
    assert p["X -> {R_Y W}, A <- B"]["edges"] == [["X", "R_Y"], ["X", "W"], ["B", "A"]]
    assert p["pre-op -> post-op"]["edges"] == [["pre-op", "post-op"]]
    assert all(result["parseErrors"].values())


def test_add_links(result):
    rep, g = result["report"], result["graph"]
    assert rep["ok"] is True
    assert set(rep["added"]) == {"X → Y", "W → R_Y", "Y → R_Y", "U ↔ X", "R_Y → R_W"}
    assert {s[0] for s in rep["skipped"]} == {"R_Y → X", "Y_star → W"}
    assert set(rep["partial"]) == {"Y", "W"}                      # R_Y and R_W made Y and W partially observed
    assert g["partial"] == ["W", "Y"]
    assert g["validate"] == []                                     # still a valid m-graph
    assert "Y" in g["selfMasking"]
    assert "Y->Y_star" in g["edges"] and "R_Y->Y_star" in g["edges"]
    assert result["history"] == 1                                  # every link and new node in one step
    assert result["afterUndo"] == 0                                # one undo removes every link and node


def test_deleting_a_node_removes_its_common_cause(result):
    d = result["deleteDropsCommonCause"]
    assert d["after"] == d["withQ"] - 2                             # Q and the latent node behind Q <-> X
    assert d["latent"] == ["L_U_X"]


DEADLINE = r"""
const fs = require("fs"), vm = require("vm");
for (const f of process.argv.slice(1)) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const MG = globalThis.MG;
const g = MG.Graph.fromPayload(MG.gallery.load("mp-fig5c"));
const out = {};
try { MG.withDeadline(1, () => MG.causal.effect(g, ["X"], ["W"], [])); out.first = "finished"; }
catch (e) { out.first = e.name; }
out.deadlineCleared = MG.deadline === null;
const r = MG.causal.effect(g, ["X"], ["W"], []);
out.recoverable = r.recoverable;
console.log(JSON.stringify(out));
"""


def test_time_limit_is_never_a_verdict():
    """A search cut short throws TimeUp, leaves no cached failure, and the full search still succeeds."""
    files = [str(asset_path(m)) for m in CORE_MODULES]
    proc = subprocess.run([shutil.which("node"), "-e", DEADLINE, *files], capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out == {"first": "TimeUp", "deadlineCleared": True, "recoverable": True}


def test_page_runs_the_engine_in_its_own_script():
    """The worker for long searches is built from <script id="mg-core">; the page stays one offline file."""
    from amr_identifiability.viz import Explorer

    page = Explorer().html()
    assert page.count('<script id="mg-core">') == 1
    assert "/*__CORE__*/" not in page


EVERY = r"""
const fs = require("fs"), vm = require("vm");
for (const f of process.argv.slice(1)) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
const MG = globalThis.MG;
const out = [];
for (const key of ["mp-fig1d", "mp-fig3", "mp-fig4a", "mp-fig6a"]) {
  const spec = MG.gallery.load(key);
  const g = MG.Graph.fromPayload(spec);
  const cat = new MG.Catalogue(g);
  for (const p of cat.pairs) {
    if (p.adjacent) continue;
    const r = MG.separators.allDSeparators(g, p.x, p.y, { allowed: g.recorded, maxSets: 1e6, maxChecks: 1e6 });
    out.push({ key, x: p.x, y: p.y, complete: r.complete, pool: r.pool,
               sets: r.sets.map((s) => MG.sorted(s)), minimal: p.separators.map((s) => MG.sorted(s)) });
  }
}
console.log(JSON.stringify({ out, specs: Object.fromEntries(["mp-fig1d", "mp-fig3", "mp-fig4a", "mp-fig6a"].map((k) => [k, MG.gallery.load(k)])) }));
"""


def test_every_separating_set_agrees_with_python():
    """'Every set' in the Conditions tab: complete, and each set checked by the Python d-separation."""
    import itertools

    from amr_identifiability import MGraph

    files = [str(asset_path(m)) for m in CORE_MODULES]
    proc = subprocess.run([shutil.which("node"), "-e", EVERY, *files], capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    graphs = {k: MGraph([tuple(e) for e in s["edges"]], latent=[n["id"] for n in s["nodes"] if n.get("latent")],
                        nodes=[n["id"] for n in s["nodes"]]) for k, s in data["specs"].items()}
    checked = 0
    for r in data["out"]:
        g = graphs[r["key"]]
        assert r["complete"], r
        pool = sorted(n for n in g.nodes - g.latent if n not in (r["x"], r["y"]))
        assert len(pool) == r["pool"]
        listed = {tuple(s) for s in r["sets"]}
        for k in range(len(pool) + 1):
            for z in itertools.combinations(pool, k):
                assert (z in listed) == g.is_d_separated(r["x"], r["y"], z), (r["key"], r["x"], r["y"], z)
                checked += 1
        assert {tuple(m) for m in r["minimal"]} <= listed           # every minimal set is among them
    assert checked > 500


def test_every_method_called_on_this_is_defined():
    """Catches calls such as this._find(...) to a method no class defines (the M1/M2/M3 buttons broke this way)."""
    import re

    root = asset_path("js")
    assigned_from_outside = {"onViewChange"}   # GraphView: set by the app, called only when present
    problems = []
    for f in sorted(list(root.glob("ui/**/*.js")) + [root / "app.js"]):
        text = f.read_text()
        called = set(re.findall(r"this\.(\w+)\(", text))
        defined = set(re.findall(r"^\s+(?:async\s+)?(?:static\s+)?(?:get\s+)?(\w+)\s*\(.*\)\s*\{\s*$", text, re.M))
        defined |= set(re.findall(r"this\.(\w+)\s*=", text))
        missing = called - defined - assigned_from_outside
        if missing:
            problems.append(f"{f.name}: {sorted(missing)}")
    assert not problems, problems
