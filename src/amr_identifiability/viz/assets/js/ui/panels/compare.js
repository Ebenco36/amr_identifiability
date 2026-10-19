/* Compare two graphs (Section 4.3 of Mohan & Pearl 2021): what each lets data test, and whether
 * a distribution is recoverable in each. Two graphs with the same testable claims cannot be told
 * apart by those tests, yet may disagree on recoverability. */
(function (MG) {
  "use strict";
  const { h } = MG.ui;

  class ComparePanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.other = null;
      this.target = null;
    }

    get title() {
      return "Compare";
    }

    shouldRender(changed) {
      return ["modelKey", "edits", "userOrder"].some((k) => changed.has(k));
    }

    render(body) {
      const store = this.store;
      const models = store.listModels();
      const cur = store.state.modelKey;
      const options = models.filter((m) => m.key !== cur);
      if (!this.other || !options.some((m) => m.key === this.other)) {
        const guess = cur === "mp-fig8b" ? "mp-fig8c" : cur === "mp-fig8c" ? "mp-fig8b" : null;
        this.other = guess && options.some((m) => m.key === guess) ? guess : options.length ? options[0].key : null;
      }
      const sel = h("select", { class: "select", "aria-label": "Graph to compare with" }, options.map((m) => h("option", { value: m.key, selected: m.key === this.other }, store.graph(m.key).name)));
      sel.addEventListener("change", (e) => { this.other = e.target.value; this.render(body); });
      const intro = h("div", { class: "panel-section" },
        h("h3", null, "Compare two graphs", h("span", { class: "aside" }, "Section 4.3")),
        h("p", { class: "muted small", style: { marginTop: 0 } }, "Data can only refute a graph through its testable claims. Two graphs with the same testable claims cannot be told apart by those tests, yet one may let you recover a distribution that the other does not: recoverability depends on the graph, not only on the data."),
        h("div", { class: "form-row", style: { marginTop: 0 } }, h("span", { class: "muted" }, "Compare with"), sel),
        cur.startsWith("mp-fig8") ? null : h("button", { class: "btn small", style: { marginTop: "8px" }, onClick: () => { this.app.openGallery("mp-fig8b"); this.store.openGallery("mp-fig8c"); this.store.switchModel("mp-fig8b"); this.other = "mp-fig8c"; this.app.showTab("compare"); } }, "Open the paper's example: Fig. 8(b) and 8(c)"));
      if (!this.other) return body.replaceChildren(intro, h("div", { class: "empty" }, h("p", null, "Open a second graph (graph menu) to compare.")));
      const g1 = store.graph(cur), g2 = store.graph(this.other);
      body.replaceChildren(intro, this._claims(g1, g2), this._recovery(g1, g2));
    }

    /** Testable claims written in recorded variables, so graphs can be compared. */
    _testable(g) {
      const cat = this.store.catalogue(g);
      const out = new Map();
      for (const r of cat.rows({ testableOnly: true })) out.set(r.recorded, r.statement);
      return out;
    }

    _claims(g1, g2) {
      const t1 = this._testable(g1), t2 = this._testable(g2);
      const both = [...t1.keys()].filter((k) => t2.has(k));
      const only1 = [...t1.keys()].filter((k) => !t2.has(k));
      const only2 = [...t2.keys()].filter((k) => !t1.has(k));
      const same = !only1.length && !only2.length;
      const list = (keys, label) => keys.length ? [h("div", { class: "slot-label-row" }, `${label} (${keys.length})`), ...keys.slice(0, 30).map((k) => h("div", { class: "mono small", style: { padding: "2px 0" } }, k))] : null;
      return h("div", { class: "panel-section" },
        h("h3", null, "Testable claims", h("span", { class: "aside" }, "Theorem 5")),
        h("div", { class: ["problem", same ? "ok" : ""].join(" ") }, same
          ? (t1.size ? `Both graphs make the same ${t1.size} testable claims: no test of this kind can tell them apart.` : "Neither graph makes a testable claim: no test of this kind can tell them apart.")
          : `The graphs differ in ${only1.length + only2.length} testable claims: data can separate them.`),
        list(only1, `Only in ${g1.name}`), list(only2, `Only in ${g2.name}`), list(both, "In both"),
        h("p", { class: "faint small" }, "These are the claims Theorem 5 certifies as testable. Graphs can also differ in other constraints (Verma constraints), so equal lists are necessary, not sufficient, for the graphs to be indistinguishable."));
    }

    _recovery(g1, g2) {
      const shared = MG.sorted([...g1.partiallyObserved, ...g1.fullyObserved].filter((v) => g2.has(v) && (g2.partiallyObserved.has(v) || g2.fullyObserved.has(v))));
      if (!shared.length) return h("div");
      const options = [shared, ...shared.filter((v) => g1.partiallyObserved.has(v) || g2.partiallyObserved.has(v)).map((v) => [v])];
      if (!this.target || !options.some((o) => o.join() === this.target.join())) this.target = options[0];
      const sel = h("select", { class: "select", "aria-label": "Distribution to recover" }, options.map((o) => h("option", { value: o.join(","), selected: o.join() === this.target.join() }, `P(${o.join(", ")})`)));
      sel.addEventListener("change", (e) => { this.target = e.target.value.split(","); this.render(this.app.body); });
      const target = this.target;
      const cell = (g, entry) => {
        if (entry.timeUp) return h("div", { class: "compare-cell" }, h("b", null, g.name), h("span", { class: "tag never" }, "no verdict yet"), h("div", { class: "muted small" }, `The search stopped after ${Math.round(entry.timeUp / 1000)} s.`));
        if (entry.error) return h("div", { class: "compare-cell" }, h("b", null, g.name), h("span", { class: "muted small" }, entry.error.message));
        const r = entry.value;
        const txt = r.recoverable === true ? "recoverable" : r.recoverable === false ? "not recoverable" : "undetermined";
        return h("div", { class: "compare-cell" }, h("b", null, g.name), h("span", { class: ["tag", r.recoverable === true ? "testable" : "never"] }, txt), h("div", { class: "muted small" }, r.method ? `by ${r.method}` : r.reason || ""),
          r.expr ? h("div", { class: "mono small", style: { overflowWrap: "anywhere" } }, MG.expr.toText(r.expr)) : null);
      };
      const both = () => [g1, g2].map((g) => MG.ui.deferred.run(g, `recover:${JSON.stringify([target, []])}`, () => MG.missing.recover(g, target, []), MG.ui.deferred.QUICK_MS));
      const key = `compare:${g2.key}:${g2.edges.join(";")}:${target.join()}`;
      return h("div", { class: "panel-section" },
        h("h3", null, "Recoverability"),
        h("div", { class: "form-row", style: { marginTop: 0 } }, sel),
        MG.ui.deferred.slot(g1, key, both, (entry) => {
          if (entry.error) return h("p", { class: "muted small" }, entry.error.message);
          const [e1, e2] = entry.value;
          const v = (e) => (e.value ? e.value.recoverable : undefined);
          return h("div", null, h("div", { class: "compare-grid" }, cell(g1, e1), cell(g2, e2)),
            v(e1) !== undefined && v(e2) !== undefined && v(e1) !== v(e2) ? h("div", { class: "problem", style: { marginTop: "8px" } }, "The graphs disagree on whether this distribution can be recovered. If their testable claims agree, no data can settle which answer is right: the choice of graph is a substantive assumption.") : null);
        }, { label: "Checking recoverability in both graphs…", ms: 2 * MG.ui.deferred.QUICK_MS }));
    }
  }

  MG.ui.ComparePanel = ComparePanel;
})(globalThis.MG);
