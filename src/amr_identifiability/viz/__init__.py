"""Interactive explorer for m-graphs: one offline HTML file, plus figure export.

    from amr_identifiability.viz import Explorer

    ex = Explorer()                                   # M1, M2, M3 with 4 and 1 upstream
    ex = Explorer(build_model("M1"), statement="Yk _||_ R_Yk | S, W, T")
    ex                                                # shows inline in Jupyter
    ex.save("m1.html")                                # the explorer, offline
    ex.save("m1.svg"); ex.save("m1.pdf")              # figures (need Node.js)
    ex.open()                                         # open in the default browser

In the page itself, Export saves SVG, PNG, PDF or HTML. Every independence in the page is
computed in the browser with the same algorithms as the Python package; the test suite
checks that the two agree on every model.
"""

from __future__ import annotations

import html as _html
import json
import shutil
import subprocess
import tempfile
import webbrowser
from pathlib import Path
from typing import Iterable

from amr_identifiability.mgraph import Independence, MGraph
from amr_identifiability.viz.page import CORE_MODULES, asset_path, build_page
from amr_identifiability.viz.payload import SCALE, default_models, model_payload

__all__ = ["Explorer", "FigureExportError"]

FIGURE_FORMATS = ("svg", "pdf")


class FigureExportError(RuntimeError):
    """Figure export from Python needs Node.js; the page's own Export menu does not."""


class Explorer:
    """The interactive m-graph explorer for one or more graphs.

    Parameters
    ----------
    graphs:     an MGraph, a list of MGraphs, or None for M1, M2 and M3 (4 and 1 upstream)
    select:     key or name of the graph shown first
    statement:  an independence to show on opening, e.g. "Yk _||_ R_Yk | S, W, T"
    node:       a node to select on opening
    tab:        "node", "conditions", "query" or "recovery"
    title:      page title
    texts:      extra graphs as text (DAGitty, edge list, JSON or Graphviz) or paths to such
                files; the page reads them with the same reader as its Import dialog
    builtins:   include M1, M2 and M3 when no graphs are given (default True)
    """

    def __init__(
        self,
        graphs: MGraph | Iterable[MGraph] | None = None,
        *,
        select: str | None = None,
        statement: str | Independence | None = None,
        node: str | None = None,
        tab: str | None = None,
        title: str = "m-graph explorer",
        texts: Iterable[str | Path] = (),
        builtins: bool = True,
    ) -> None:
        self.imports = []
        for i, t in enumerate(texts):
            path = Path(t) if not isinstance(t, str) or ("\n" not in t and len(t) < 400 and Path(t).exists()) else None
            if path is not None:
                self.imports.append({"key": f"import-{i + 1}", "name": path.stem, "text": path.read_text(encoding="utf-8")})
            else:
                self.imports.append({"key": f"import-{i + 1}", "name": f"Graph {i + 1}", "text": str(t)})
        if graphs is None and not builtins:
            entries = []
        elif graphs is None:
            entries = default_models()
        else:
            graphs = [graphs] if isinstance(graphs, MGraph) else list(graphs)
            if not graphs:
                raise ValueError("no graphs given")
            entries = []
            for i, g in enumerate(graphs):
                family = g.name.split(" ")[0] if g.name else f"G{i + 1}"
                upstream = sum(1 for n in g.nodes if n.startswith("Yj") and not n.endswith("_star"))
                key = f"{family}-{upstream}" if g.name else f"graph-{i + 1}"
                entries.append((g, key, family, upstream or None))
            keys = [k for _, k, _, _ in entries]
            if len(set(keys)) != len(keys):  # fall back to unique positional keys
                entries = [(g, f"graph-{i + 1}", g.name or f"Graph {i + 1}", None) for i, (g, _, _, _) in enumerate(entries)]
        self.models = [model_payload(g, k, f, n) for g, k, f, n in entries]
        self._graphs = {k: g for g, k, _, _ in entries}
        self.title = title
        self.state: dict = {}
        if select is not None:
            match = [m["key"] for m in self.models if select in (m["key"], m["name"])]
            if not match:
                raise KeyError(f"no graph {select!r}; choose from {[m['key'] for m in self.models]}")
            self.state["modelKey"] = match[0]
        if statement is not None:
            ind = Independence.parse(statement) if isinstance(statement, str) else statement
            self._graph().implies(ind)  # raises on unknown nodes
            self.state["statement"] = str(ind)
            self.state["tab"] = "query"
        if node is not None:
            if node not in self._graph().nodes:
                raise KeyError(f"{node} is not in {self._graph().name}")
            self.state["node"] = node
        if tab is not None:
            if tab not in ("node", "conditions", "query", "recovery"):
                raise ValueError("tab must be node, conditions, query or recovery")
            self.state["tab"] = tab

    def _graph(self) -> MGraph:
        if not self.models:
            raise ValueError("this explorer has only text graphs; select, statement and node need an MGraph")
        key = self.state.get("modelKey", self.models[0]["key"])
        return self._graphs[key]

    def data(self) -> dict:
        from amr_identifiability import __version__

        return {"models": self.models, "defaultModel": self.models[0]["key"] if self.models else None,
                "imports": self.imports, "scale": SCALE, "version": __version__}

    def html(self) -> str:
        """The complete, self-contained page."""
        return build_page(self.data(), self.state, title=self.title)

    def save(self, path: str | Path, *, statement: str | Independence | None = None, legend: bool = True,
             caption: bool = True, title: str | None = None, hidden_roles: Iterable[str] = (),
             spacing: float | str = "auto") -> Path:
        """Save the explorer (.html) or a figure (.svg, .pdf) of the selected graph.

        Figures show `statement` (or the explorer's statement) with its open paths, as the
        page's Export does. `spacing` scales the layout (not the nodes): "auto" packs it as
        tightly as it goes without overlaps, 1 keeps the explorer's spacing. Figure export runs
        the page's renderer in Node.js. For PNG, use the page's Export menu.
        """
        path = Path(path)
        ext = path.suffix.lower().lstrip(".")
        if ext in ("html", "htm"):
            path.write_text(self.html(), encoding="utf-8")
            return path
        if ext == "png":
            raise FigureExportError("PNG needs a browser to draw it: open the explorer and use Export > PNG, or save .svg or .pdf here")
        if ext not in FIGURE_FORMATS:
            raise ValueError(f"unsupported format .{ext}; use .html, .svg or .pdf")
        st = statement if statement is not None else self.state.get("statement")
        if self.models:
            source = {"model": next(m for m in self.models if m["key"] == self.state.get("modelKey", self.models[0]["key"]))}
        elif self.imports:
            source = {"text": self.imports[0]["text"], "name": self.imports[0]["name"]}
        else:
            raise ValueError("no graph to draw")
        job = {
            "action": "figure",
            "format": ext,
            **source,
            "statement": str(st) if st is not None else None,
            "legend": legend,
            "caption": caption,
            "title": title,
            "hiddenRoles": list(hidden_roles),
            "spacing": spacing,
        }
        path.write_bytes(run_node(job))
        return path

    def open(self) -> Path:
        """Write the page to a temporary file and open it in the default browser."""
        tmp = Path(tempfile.mkdtemp(prefix="mgraph-")) / "explorer.html"
        tmp.write_text(self.html(), encoding="utf-8")
        webbrowser.open(tmp.as_uri())
        return tmp

    def _repr_html_(self) -> str:
        page = _html.escape(self.html(), quote=True)
        return (f'<iframe srcdoc="{page}" style="width:100%;height:760px;border:1px solid #dde2e0;border-radius:8px" '
                f'sandbox="allow-scripts allow-downloads allow-modals allow-same-origin" title="{_html.escape(self.title)}"></iframe>')

    def __repr__(self) -> str:
        return f"Explorer({', '.join(m['name'] for m in self.models)})"


def run_node(job: dict) -> bytes:
    """Run one job through the page's core modules in Node.js and return its output."""
    node = shutil.which("node")
    if node is None:
        raise FigureExportError("Node.js is not installed; open the explorer and use its Export menu instead")
    args = [node, str(asset_path("js/node/runner.js"))] + [str(asset_path(m)) for m in CORE_MODULES]
    proc = subprocess.run(args, input=json.dumps(job).encode(), capture_output=True, timeout=1800)
    if proc.returncode != 0:
        raise FigureExportError(proc.stderr.decode(errors="replace").strip().splitlines()[-1] if proc.stderr else "node failed")
    return proc.stdout
