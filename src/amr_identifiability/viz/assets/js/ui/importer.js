/* Import dialog: paste, open or drop a DAG (DAGitty, Graphviz digraph, JSON or an edge list),
 * see a live preview with any warnings, and open it as a new graph. */
(function (MG) {
  "use strict";
  const { h, icon, debounce } = MG.ui;

  const EXAMPLES = {
    DAGitty: `dag {
  Z [pos="1,0"]
  X [exposure,pos="0,1"]
  Y [outcome,pos="2,1"]
  Z -> X
  Z -> Y
  X -> Y
  X -> R_Y
}`,
    "edge list": `# one edge per line; <-> is an unrecorded common cause
A -> B
B -> C
A <-> C
C -> R_C`,
    JSON: `{
  "nodes": ["X", "M", "Y"],
  "edges": [["X", "M"], ["M", "Y"], {"from": "X", "to": "Y", "type": "<->"}]
}`,
    Graphviz: `digraph G {
  age -> obesity;
  gender -> obesity;
  age -> R_obesity;
}`,
  };

  class Importer {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.dialog = document.getElementById("import-dialog");
      this.result = null;
    }

    open(text = "") {
      const area = h("textarea", { class: "input mono import-text", spellcheck: false, placeholder: "Paste DAGitty text, an edge list such as  A -> B, JSON, or a Graphviz digraph. You can also drop a file here.", "aria-label": "Graph text" });
      area.value = text;
      const name = h("input", { class: "input", placeholder: "Name of the graph", "aria-label": "Graph name" });
      const file = h("input", { type: "file", accept: ".txt,.dag,.dagitty,.dot,.gv,.json,.csv,text/plain,application/json", style: { display: "none" } });
      this.status = h("div", { class: "import-status", role: "status" });
      this.preview = h("div", { class: "preview import-preview" }, h("span", { class: "faint" }, "Preview"));
      const openBtn = h("button", { class: "btn primary", type: "button", disabled: true, onClick: () => this._open(name.value.trim()) }, "Open graph");
      this.openBtn = openBtn;
      const update = () => this._check(area.value, name.value.trim());
      area.addEventListener("input", debounce(update, 180));
      name.addEventListener("input", debounce(update, 180));
      file.addEventListener("change", async () => {
        const f = file.files[0];
        if (!f) return;
        area.value = await f.text();
        if (!name.value) name.value = f.name.replace(/\.[^.]+$/, "");
        update();
      });
      for (const ev of ["dragenter", "dragover"]) area.addEventListener(ev, (e) => { e.preventDefault(); area.classList.add("is-drop"); });
      for (const ev of ["dragleave", "drop"]) area.addEventListener(ev, () => area.classList.remove("is-drop"));
      area.addEventListener("drop", async (e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) {
          area.value = await f.text();
          if (!name.value) name.value = f.name.replace(/\.[^.]+$/, "");
        } else area.value = e.dataTransfer.getData("text");
        update();
      });
      const examples = h("div", { class: "filters" }, h("span", { class: "muted", style: { fontSize: "12px" } }, "Examples:"),
        Object.keys(EXAMPLES).map((k) => h("button", { type: "button", class: "btn small", onClick: () => { area.value = EXAMPLES[k]; update(); } }, k)));
      this.dialog.replaceChildren(
        h("header", null, h("h2", null, "Import a DAG"), MG.ui.iconButton("close", "Close", { onClick: () => this.dialog.close() })),
        h("div", { class: "dialog-body" },
          h("div", { class: "import-grid" },
            h("div", { class: "import-col" }, area, h("div", { class: "filters" }, h("button", { type: "button", class: "btn small", onClick: () => file.click() }, icon("download"), "Open a file"), file), examples),
            h("div", { class: "import-col" }, this.preview, this.status)),
          h("label", { class: "block" }, "Name", name),
          h("p", { class: "faint", style: { margin: 0, fontSize: "12px" } },
            "Missing data: name a variable's missingness indicator R_X (1 = missing). Its recorded proxy X_star is added for you. Mark unmeasured variables [latent] in DAGitty, or use A <-> B for an unrecorded common cause.")),
        h("footer", null, h("button", { class: "btn", type: "button", onClick: () => this.dialog.close() }, "Cancel"), openBtn));
      this.dialog.classList.add("wide");
      if (!this.dialog.open) this.dialog.showModal();
      area.focus();
      if (text) update();
    }

    _check(text, name) {
      this.result = null;
      this.openBtn.disabled = true;
      if (!text.trim()) {
        this.status.replaceChildren();
        this.preview.replaceChildren(h("span", { class: "faint" }, "Preview"));
        return;
      }
      try {
        const res = MG.parse.graphText(text, { name: name || "Imported graph" });
        this.result = res;
        const g = new MG.Graph({ nodes: res.spec.nodes, edges: res.spec.edges, latent: res.spec.nodes.filter((n) => n.latent).map((n) => n.id) });
        const scene = MG.scene.buildScene({ graph: g, positions: new Map(res.spec.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), legend: false, spacing: "auto" });
        const url = URL.createObjectURL(new Blob([MG.svgWriter.toSvg(scene)], { type: "image/svg+xml" }));
        if (this._url) URL.revokeObjectURL(this._url);
        this._url = url;
        this.preview.replaceChildren(h("img", { src: url, alt: "Preview of the graph" }));
        const counts = MG.ROLES.map((r) => [r, g.ids.filter((id) => g.role(id) === r).length]).filter(([, n]) => n);
        this.status.replaceChildren(
          h("div", { class: "problem ok" }, h("b", null, `${res.format}: `), `${g.ids.length} nodes, ${g.edgeCount} edges. `, counts.map(([r, n]) => `${n} ${r}`).join(", "), "."),
          ...res.warnings.map((w) => h("div", { class: "problem" }, w)),
          ...g.validate().map((w) => h("div", { class: "problem" }, w)));
        this.openBtn.disabled = false;
      } catch (e) {
        this.preview.replaceChildren(h("span", { class: "faint" }, "No preview"));
        this.status.replaceChildren(h("div", { class: "problem error" }, h("b", null, "Can't read this graph: "), e.message));
      }
    }

    _open(name) {
      if (!this.result) return;
      const spec = { ...this.result.spec, name: name || this.result.spec.name, source: "user" };
      this.dialog.close();
      this.app.openSpec(spec);
    }
  }

  MG.ui.Importer = Importer;
})(globalThis.MG);
