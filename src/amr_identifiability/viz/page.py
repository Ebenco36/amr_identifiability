"""Assemble the explorer page: one self-contained HTML file that works offline.

The browser code lives in assets/ as separate modules; they are inlined here in dependency
order. CORE_MODULES have no DOM dependency and are also loaded by Node (node/runner.js) for
the parity tests and for figure export from Python.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from html import escape
from importlib import resources

CORE_MODULES = (
    "js/core/base.js",
    "js/core/graph.js",
    "js/core/statement.js",
    "js/core/dsep.js",
    "js/core/separators.js",
    "js/core/catalogue.js",
    "js/core/recovery.js",
    "js/core/admg.js",
    "js/core/expr.js",
    "js/core/missing.js",
    "js/core/causal.js",
    "js/core/hybrid.js",
    "js/render/metrics.js",
    "js/render/geometry.js",
    "js/core/layout.js",
    "js/core/parse.js",
    "js/core/gallery.js",
    "js/render/palette.js",
    "js/render/scene.js",
    "js/render/svg_writer.js",
    "js/render/pdf_writer.js",
)

UI_MODULES = (
    "js/ui/dom.js",
    "js/ui/store.js",
    "js/ui/math.js",
    "js/ui/deferred.js",
    "js/ui/graph_view.js",
    "js/ui/panels/inspector.js",
    "js/ui/panels/conditions.js",
    "js/ui/panels/query.js",
    "js/ui/panels/missing.js",
    "js/ui/panels/causal.js",
    "js/ui/panels/docalc.js",
    "js/ui/panels/compare.js",
    "js/ui/exporter.js",
    "js/ui/importer.js",
    "js/ui/palette.js",
    "js/ui/build_panel.js",
    "js/ui/toolbar.js",
    "js/ui/keyboard.js",
    "js/app.js",
)

STYLES = ("css/app.css",)


def asset_path(name: str):
    return resources.files("amr_identifiability.viz") / "assets" / name


def read_asset(name: str) -> str:
    return asset_path(name).read_text(encoding="utf-8")


def _json_for_script(data) -> str:
    """JSON safe to place inside a <script> element."""
    return (json.dumps(data, separators=(",", ":"), ensure_ascii=False)
            .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def build_page(data: dict, state: dict | None = None, title: str = "m-graph explorer") -> str:
    """The complete HTML document."""
    data = {**data, "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}
    template = read_asset("template.html")
    css = "\n".join(read_asset(s) for s in STYLES)
    # the core runs in its own <script id="mg-core"> so the page can start a background worker from
    # the same text (long searches run there without freezing the page)
    core = "\n;\n".join(f"/* ---- {m} ---- */\n" + read_asset(m) for m in CORE_MODULES)
    ui = "\n;\n".join(f"/* ---- {m} ---- */\n" + read_asset(m) for m in UI_MODULES)
    if "</script" in (core + ui).lower():
        raise ValueError("an asset contains '</script', which would end the inline script early")
    return (template
            .replace("__TITLE__", escape(title))
            .replace("/*__CSS__*/", css)
            .replace("__DATA__", _json_for_script(data))
            .replace("__STATE__", _json_for_script(state or {}))
            .replace("/*__CORE__*/", core)
            .replace("/*__JS__*/", ui))
