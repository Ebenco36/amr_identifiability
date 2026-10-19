/* Export: figures (SVG, PNG, PDF), a standalone HTML snapshot, and DAGitty text.
 *
 * Figures are built from a scene (MG.scene) of the current graph, layout and highlighted
 * statement, always on white so they drop into a paper. PDF is vector, written in the
 * browser with the built-in Helvetica fonts. The HTML snapshot is this page with the current
 * state (model, edits, layout, statement, filters) saved inside it.
 */
(function (MG) {
  "use strict";
  const { h, icon, download, toast, slug } = MG.ui;

  const FORMATS = {
    svg: { label: "SVG", note: "vector, editable" },
    png: { label: "PNG", note: "image" },
    pdf: { label: "PDF", note: "vector, for print" },
    html: { label: "HTML", note: "this explorer" },
  };

  class Exporter {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.dialog = document.getElementById("export-dialog");
      this.opts = { format: "svg", legend: true, caption: true, dim: true, scale: 2, title: "", spacing: "auto" };
      this.dialog.addEventListener("close", () => {
        if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
      });
    }

    // ---------------------------------------------------------------- figure scene

    scene({ legend = true, caption = true, dim = true, title = "", spacing = "auto" } = {}) {
      const store = this.store;
      const graph = store.graph();
      const hidden = new Set(store.state.hiddenRoles);
      if (store.state.filters.hideProxies) hidden.add("recorded proxy");
      const a = store.analysis();
      let highlight = null;
      const lines = [];
      if (a && a.statement) {
        const focus = store.transient.focusPath;
        highlight = { x: a.statement.x, y: a.statement.y, z: a.statement.z, openEdges: a.openEdges, focusEdges: focus ? MG.ui.edgeSet([focus]) : new Set(), blockers: focus && focus.blocker ? new Set([focus.blocker]) : new Set(), dim };
        if (caption) lines.push(...MG.scene.statementCaption(graph, a.statement, { implied: a.implied, openCount: a.open.paths.length, truncated: a.open.truncated }));
      }
      return MG.scene.buildScene({ graph, positions: store.positions(), hiddenRoles: hidden, highlight, legend, title: title || null, caption: lines, spacing });
    }

    baseName() {
      const graph = this.store.graph();
      const a = this.store.analysis();
      let name = slug(graph.name);
      if (a && a.statement) name += "-" + slug(a.statement.toString().replace("_||_", "indep").replace("|", "given")).slice(0, 60);
      return name;
    }

    // ---------------------------------------------------------------- save

    async save(format, opts = this.opts, filename = null) {
      const name = filename || `${this.baseName()}.${format}`;
      try {
        if (format === "html") return this.saveHtml(name);
        const scene = this.scene(opts);
        const title = opts.title || this.store.graph().name;
        if (format === "svg") download(name, MG.svgWriter.toSvg(scene, { title }), "image/svg+xml");
        else if (format === "pdf") download(name, MG.pdfWriter.toBytes(MG.pdfWriter.toPdf(scene, { title })), "application/pdf");
        else if (format === "png") download(name, await this.png(scene, opts.scale || 2), "image/png");
        toast(`Saved ${name}`);
      } catch (e) {
        console.error(e);
        toast(`Could not save: ${e.message}`, "error");
      }
    }

    png(scene, scale) {
      const svg = MG.svgWriter.toSvg(scene);
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(scene.width * scale);
          canvas.height = Math.round(scene.height * scale);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, scene.width, scene.height);
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the browser could not encode the PNG"))), "image/png");
        };
        img.onerror = () => reject(new Error("the browser could not draw the figure"));
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      });
    }

    snapshotHtml() {
      const pristine = MG.pristineHTML;
      if (!pristine) throw new Error("the page source is not available");
      const state = JSON.stringify(this.store.serialize()).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
      const open = '<script type="application/json" id="mg-state">';
      const i = pristine.indexOf(open);
      const j = pristine.indexOf("<\/script>", i);
      if (i < 0 || j < 0) throw new Error("the page source has no state block");
      return pristine.slice(0, i + open.length) + state + pristine.slice(j);
    }

    saveHtml(name) {
      download(name, this.snapshotHtml(), "text/html");
      toast(`Saved ${name} with the current view`);
    }

    dagitty() {
      const graph = this.store.graph();
      const pos = this.store.positions();
      const scale = this.store.data.scale || 90;
      const lines = ["dag {"];
      for (const n of MG.sorted(graph.ids)) {
        const attrs = [];
        if (graph.latent.has(n)) attrs.push("latent");
        const p = pos.get(n);
        if (p) attrs.push(`pos="${(p.x / scale).toFixed(3)},${(p.y / scale).toFixed(3)}"`);
        lines.push(attrs.length ? `${n} [${attrs.join(",")}]` : n);
      }
      lines.push("");
      for (const [a, b] of graph.edges.slice().sort((e, f) => (e[0] + "\u0001" + e[1] < f[0] + "\u0001" + f[1] ? -1 : 1))) lines.push(`${a} -> ${b}`);
      lines.push("}");
      return lines.join("\n") + "\n";
    }

    // ---------------------------------------------------------------- dialog

    open(format = "svg") {
      this.opts.format = format;
      this.opts.title = this.opts.title || "";
      this._render();
      if (!this.dialog.open) this.dialog.showModal();
    }

    _render() {
      const o = this.opts;
      const a = this.store.analysis();
      const hasStatement = !!(a && a.statement);
      const isFigure = o.format !== "html";
      const fmtButtons = h("div", { class: "format-grid", role: "group", "aria-label": "Format" }, Object.entries(FORMATS).map(([k, f]) =>
        h("button", { type: "button", "aria-pressed": String(o.format === k), onClick: () => { o.format = k; this._render(); } }, h("b", null, f.label), h("span", null, f.note))));
      const name = h("input", { class: "input mono", value: `${this.baseName()}.${o.format}`, "aria-label": "File name" });
      const title = h("input", { class: "input", value: o.title, placeholder: "No title", "aria-label": "Figure title" });
      title.addEventListener("input", MG.ui.debounce(() => { o.title = title.value; this._preview(); }, 200));
      const tog = (key, label, disabled = false) => h("label", { class: "toggle", style: disabled ? { opacity: 0.45 } : null }, h("input", { type: "checkbox", checked: !!o[key] && !disabled, disabled, onChange: (e) => { o[key] = e.target.checked; this._preview(); } }), label);
      const spacingSel = h("select", { class: "select", "aria-label": "Spacing" },
        [["auto", "Compact"], ["1", "As on screen"], ["0.8", "80%"], ["0.6", "60%"]].map(([v, l]) => h("option", { value: v, selected: String(o.spacing) === v }, l)));
      spacingSel.addEventListener("change", (e) => { o.spacing = e.target.value === "auto" ? "auto" : +e.target.value; this._preview(); });
      const scaleSel = h("select", { class: "select", "aria-label": "PNG scale" }, [1, 2, 3, 4].map((s) => h("option", { value: s, selected: o.scale === s }, `${s}×`)));
      scaleSel.addEventListener("change", (e) => { o.scale = +e.target.value; this._preview(); });
      this._meta = h("div", { class: "preview-meta" });
      this._img = h("div", { class: "preview" });
      const body = h("div", { class: "dialog-body" },
        fmtButtons,
        isFigure ? [
          this._img, this._meta,
          h("label", { class: "block" }, "Title", title),
          h("div", { class: "filters" }, tog("legend", "Legend"), tog("caption", "Caption", !hasStatement), tog("dim", "Fade unrelated nodes", !hasStatement), h("span", { class: "field" }, h("span", { class: "muted" }, "Spacing"), spacingSel), o.format === "png" ? h("span", { class: "field" }, h("span", { class: "muted" }, "Scale"), scaleSel) : null),
          !hasStatement ? h("p", { class: "faint", style: { margin: 0, fontSize: "12px" } }, "Select a statement first to include its highlight and caption.") : null,
        ] : h("p", { class: "muted", style: { margin: 0 } }, "A single offline file with this explorer and its current state: model, edits, node layout, the selected statement and filters. Open it in any browser."),
        h("label", { class: "block" }, "File name", name));
      const save = h("button", { class: "btn primary", type: "button", onClick: async () => { this.dialog.close(); await this.save(o.format, o, name.value.trim() || null); } }, icon("download"), "Save");
      this.dialog.replaceChildren(
        h("header", null, h("h2", null, "Export"), MG.ui.iconButton("close", "Close", { onClick: () => this.dialog.close() })),
        body,
        h("footer", null, h("button", { class: "btn", type: "button", onClick: () => this.dialog.close() }, "Cancel"), save));
      if (isFigure) this._preview();
      setTimeout(() => save.focus(), 0);
    }

    _preview() {
      if (!this._img) return;
      const scene = this.scene(this.opts);
      const svg = MG.svgWriter.toSvg(scene);
      if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
      this._previewUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      this._img.replaceChildren(h("img", { src: this._previewUrl, alt: "Figure preview" }));
      const s = this.opts.format === "png" ? this.opts.scale : 1;
      this._meta.textContent = this.opts.format === "png" ? `${Math.round(scene.width * s)} × ${Math.round(scene.height * s)} px` : `${scene.width} × ${scene.height} pt`;
    }
  }

  MG.ui.Exporter = Exporter;
})(globalThis.MG);
