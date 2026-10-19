/* Missing data tab (Mohan & Pearl 2021): the mechanism, recovering any distribution with its
 * derivation, and what the graph lets data test. */
(function (MG) {
  "use strict";
  const { h, icon } = MG.ui;
  const M = () => MG.ui.math;

  const METHOD = {
    direct: { label: "directly estimable", cite: "every variable is fully observed" },
    "Corollary 2(a)": { label: "complete cases", cite: "Corollary 2(a)" },
    "Corollary 2(b)": { label: "available cases", cite: "Corollary 2(b)" },
    "Theorem 1": { label: "ordered factorisation", cite: "Theorem 1, Definition 2" },
    "R-factorisation": { label: "R-factorisation", cite: "Section 3.2, Theorem 2" },
    intervention: { label: "intervention on the indicators", cite: "Section 3.3, ID algorithm" },
    ratio: { label: "ratio of recoverable distributions", cite: "P(T | S) = P(T, S) / P(S)" },
    "Theorem 3": { label: "not recoverable", cite: "Theorem 3" },
  };

  class MissingPanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.query = { target: [], given: [] };
      this._key = null;
    }

    get title() {
      return "Missing data";
    }

    shouldRender(changed) {
      return ["modelKey", "edits", "statement"].some((k) => changed.has(k));
    }

    render(body) {
      const graph = this.store.graph();
      if (this._key !== this.store.state.modelKey + graph.ids.join()) {
        this._key = this.store.state.modelKey + graph.ids.join();
        const Vm = MG.sorted(graph.partiallyObserved);
        const q = this.store.state.missingQuery;
        const ok = q && [...q.target, ...q.given].every((v) => graph.has(v));
        this.query = ok ? { target: q.target.slice(), given: q.given.slice() } : { target: Vm.length ? [Vm[Vm.length - 1]] : [], given: [] };
      }
      if (!graph.indicators.size) {
        body.replaceChildren(h("div", { class: "empty" },
          h("p", null, h("b", null, "No partially observed variables. "), "Every variable in this graph is either fully observed or latent, so there is no missing data to analyse."),
          h("p", null, "To model missingness, select a variable in the Node tab and switch on ", h("b", null, "Partially observed"), ": its indicator R_X (1 = missing) and recorded proxy X* are added. Then draw arrows into R_X from whatever causes the missingness."),
          h("button", { class: "btn small", onClick: () => this.app.openGallery("mp-fig1c") }, "See an example: Fig. 1(c)")));
        return;
      }
      body.replaceChildren(this._mechanism(graph), this._recover(graph), this._joint(graph), this._testability(graph), this._learn());
    }

    // ---------------------------------------------------------------- mechanism

    _mechanism(graph) {
      const c = MG.missing.classify(graph);
      const tone = c.mechanism === "MNAR" ? "no" : "yes";
      const witness = c.mechanism === "MCAR" ? null : c.mechanism === "v-MAR" ? c.mcarWitness : c.vmarWitness;
      return h("div", { class: "panel-section" },
        h("h3", null, "Missingness mechanism", h("span", { class: "aside" }, "Section 2.2")),
        h("div", { class: ["verdict", tone] },
          h("span", { class: "mark" }, icon(tone === "yes" ? "check" : "cross")),
          h("b", null, c.mechanism),
          h("span", { class: "why" }, c.text)),
        h("div", { class: "kv", style: { marginTop: "10px" } },
          h("dt", null, "MCAR"), h("dd", null, this._stmt(c.mcarStatement, c.mcar)),
          h("dt", null, "v-MAR"), h("dd", null, this._stmt(c.vmarStatement, c.vmar))),
        witness ? h("div", { class: "path-row open", onMouseenter: () => this.store.setTransient({ focusPath: witness }), onMouseleave: () => this.store.setTransient({ focusPath: null }) },
          h("span", { class: "p" }, MG.dsep.formatPath(witness)), h("span", { class: "r" }, c.mechanism === "v-MAR" ? "why not MCAR" : "why not v-MAR")) : null);
    }

    _stmt(st, holds) {
      return h("span", { class: "chip-row", style: { alignItems: "center" } },
        h("span", { class: ["tag", holds ? "testable" : "never"] }, holds ? "holds" : "fails"),
        h("button", { class: "linkish mono", title: "Show on the graph", onClick: () => this.app.showStatement(st.toString(), { stay: true }) }, st.pretty()));
    }

    // ---------------------------------------------------------------- recover a query

    _recover(graph) {
      const V = MG.sorted([...graph.fullyObserved, ...graph.partiallyObserved]);
      const Vm = MG.sorted(graph.partiallyObserved);
      const q = this.query;
      const set = (patch) => {
        this.query = { ...this.query, ...patch };
        this.store.state.missingQuery = this.query;
        this.render(this.app.body);
      };
      const toggle = (slot, v) => {
        const other = slot === "target" ? "given" : "target";
        const list = q[slot].includes(v) ? q[slot].filter((x) => x !== v) : [...q[slot], v];
        set({ [slot]: MG.sorted(list), [other]: q[other].filter((x) => x !== v) });
      };
      const chips = (slot) => h("div", { class: "chip-row" }, V.map((v) =>
        h("button", { class: ["chip", q[slot].includes(v) ? "on" : null], "aria-pressed": String(q[slot].includes(v)), onClick: () => toggle(slot, v) },
          h("span", { class: "dot", style: { background: `var(--r-${MG.ui.ROLE_CLASS[graph.role(v)]})` } }), v)));
      const presets = h("div", { class: "filters" },
        h("button", { class: "btn small", onClick: () => set({ target: V, given: [] }) }, "Joint P(V)"),
        ...Vm.slice(0, 6).map((v) => h("button", { class: "btn small", onClick: () => set({ target: [v], given: [] }) }, `P(${v})`)));
      let result;
      if (!q.target.length) result = h("p", { class: "muted" }, "Choose at least one variable to recover.");
      else {
        result = MG.ui.deferred.slot(graph, `recover:${JSON.stringify([q.target, q.given])}`, () => MG.missing.recover(graph, q.target, q.given), (entry, retry) =>
          entry.timeUp ? MG.ui.deferred.timeUp(entry, retry, "this distribution")
          : entry.error ? h("div", { class: "verdict err" }, h("b", null, "Can't ask this"), h("span", { class: "why" }, entry.error.message))
          : this._result(graph, entry.value), { label: "Looking for a recovery formula…" });
      }
      return h("div", { class: "panel-section" },
        h("h3", null, "Recover a distribution", h("span", { class: "aside" }, "Section 3")),
        h("p", { class: "muted small" }, "Can this distribution be estimated consistently from the incomplete data, as if nothing were missing?"),
        h("div", { class: "slot-label-row" }, "Distribution of"), chips("target"),
        h("div", { class: "slot-label-row" }, "given"), chips("given"),
        presets,
        h("div", { style: { marginTop: "12px" } }, result));
    }

    _result(graph, r) {
      const meta = METHOD[r.method] || { label: r.method, cite: "" };
      const q = () => M().query(r.target, r.given); // a fresh node for each place it appears
      if (r.recoverable === false) {
        return h("div", null,
          h("div", { class: "verdict no" }, h("span", { class: "mark" }, icon("cross")), h("b", null, ["Not recoverable: ", q()]), h("span", { class: "why" }, r.reason)),
          this._proofPath(graph, r));
      }
      if (r.recoverable !== true) {
        return h("div", { class: "verdict err" }, h("b", null, ["Undetermined: ", q()]), h("span", { class: "why" }, r.reason));
      }
      return h("div", null,
        h("div", { class: "verdict yes" }, h("span", { class: "mark" }, icon("check")), h("b", null, ["Recoverable: ", q()]), h("span", { class: "why" }, `By ${meta.label} (${meta.cite}). ${r.reason}`)),
        M().formula(r.expr, { lhs: q() }),
        this._derivation(graph, r));
    }

    _proofPath(graph, r) {
      if (!r.proof || !r.proof.path) return null;
      return h("p", { class: "muted small" }, "The path ", h("span", { class: "mono" }, r.proof.path.join(" ⋯ ")), " joins the variable to its own indicator through colliders that the query conditions on.");
    }

    /** The steps behind the answer, each independence clickable. */
    _derivation(graph, r) {
      const steps = [];
      const add = (title, statements, note) => steps.push({ title, statements: statements.filter(Boolean), note });
      if (r.method === "Corollary 2(a)") add("All records that are complete", [r.corollary2.complete.statement], "The target is independent of every missingness indicator given the conditioning set.");
      if (r.method === "Corollary 2(b)") add("Records where the query's variables are observed", [r.corollary2.available.statement], "The target is independent of the indicators of the query's variables given the conditioning set.");
      if (r.factorisation) {
        const f = r.factorisation;
        if (f.helpers.length) add(`Sum over ${f.helpers.join(", ")}`, [], "Theorem 1 allows a sum of ordered factorisations.");
        for (const s of f.steps) {
          const given = s.given.length ? ` | ${s.given.join(", ")}` : "";
          add(`Factor P(${s.variable}${given})`, [s.validity, s.recoverability],
            s.sub ? `Recovered on its own by ${METHOD[s.sub.method] ? METHOD[s.sub.method].label : s.sub.method}.` : s.recoverability ? "The first independence makes it the right factor; the second lets it be computed where the needed variables are observed." : "The first independence makes it the right factor; its variables are fully observed.");
        }
      }
      if (r.rfactorisation) {
        add("P(V) = P(V*, R = 0) / P(R = 0 | V)", [], "Then P(R = 0 | V) is a product over the indicators, each simplified as follows.");
        for (const f of r.rfactorisation.factors) add(`P(${f.indicator} = 0 | ${[...f.given, ...f.zeros.map((z) => z + " = 0")].join(", ") || "∅"})`, [f.drop, f.add], null);
      }
      if (r.trace && r.trace.length) for (const t of r.trace) add(`ID line ${t.line}`, [], t.text);
      if (r.parts) add("Parts", [], r.parts.map((p) => `${p.query}: ${p.method}`).join("; "));
      if (!steps.length) return null;
      return h("details", { class: "derivation", open: steps.length <= 6 },
        h("summary", null, `Derivation (${steps.length} step${steps.length === 1 ? "" : "s"})`),
        h("ol", { class: "steps" }, steps.map((s) => h("li", null,
          h("div", { class: "step-title" }, s.title),
          s.statements.map((st) => h("button", { class: "linkish mono", title: "Show this independence on the graph", onClick: () => this.app.showStatement(st.toString(), { stay: true }) }, "uses ", st.pretty())),
          s.note ? h("div", { class: "muted small" }, s.note) : null))));
    }

    // ---------------------------------------------------------------- Theorem 2

    _joint(graph) {
      const t2 = MG.missing.theorem2(graph);
      let body;
      if (!t2.applies)
        body = h("p", { class: "muted small", style: { margin: 0 } }, `Theorem 2 assumes no edges between indicators; this graph has ${t2.edgesBetweenIndicators.map(([a, b]) => `${a}–${b}`).join(", ")} (an arrow or a shared unrecorded cause). Its verdict does not apply here; the methods above still do.`);
      else if (!t2.violations.length) body = h("div", { class: "problem ok" }, "The joint distribution is recoverable: no variable is a neighbour of its own indicator or joined to it by a path of colliders.");
      else body = h("div", null, t2.violations.map((v) => h("div", { class: "problem" }, `Condition ${v.condition} fails: ${v.text}.`)), h("p", { class: "muted small" }, "So the joint distribution P(V) is not recoverable."));
      return h("div", { class: "panel-section" }, h("h3", null, "The joint distribution", h("span", { class: "aside" }, "Theorem 2")), body);
    }

    // ---------------------------------------------------------------- Section 4

    _testability(graph) {
      const t = MG.missing.testability(graph, this.store.catalogue(graph));
      const nTestable = this.store.catalogue(graph).summary().testable;
      const row = (st, tag) => h("div", { class: "stmt-row", onClick: () => this.app.showStatement(st.toString(), { stay: true }) },
        h("div", null, MG.ui.statementText(st), MG.Statement.testable(graph, st) ? h("div", { class: "sub" }, MG.Statement.recordedForm(graph, st)) : null), tag);
      return h("div", { class: "panel-section" },
        h("h3", null, "What data can test", h("span", { class: "aside" }, "Section 4")),
        h("p", { class: "muted small" }, `The graph implies ${nTestable} testable independences (Theorem 5); see Conditions with "Testable only".`),
        t.untestable.length ? [h("div", { class: "slot-label-row" }, "Claims no data can refute"), ...t.untestable.map((u) => row(u.statement, h("span", { class: "tag never" }, u.theorem4 ? "Theorem 4" : "untestable")))] : null,
        h("div", { class: "slot-label-row" }, "Is the mechanism itself testable?"),
        h("div", { class: ["problem", t.vmar.testable ? "ok" : ""].join(" ") }, t.vmar.text),
        h("div", { class: ["problem", t.mcar.testable ? "ok" : ""].join(" ") }, t.mcar.text),
        t.vmar.testable ? h("details", null, h("summary", null, "Tests implied by v-MAR (Example 13)"), t.vmar.tests.map((s) => row(s, MG.dsep.implies(graph, s) ? h("span", { class: "tag testable" }, "graph agrees") : h("span", { class: "tag never" }, "graph disagrees")))) : null);
    }

    _learn() {
      return h("div", { class: "panel-section" },
        h("h3", null, "How to read this"),
        h("details", null, h("summary", null, "m-graphs"), h("p", { class: "small" }, "Each partially observed variable X has an indicator R_X (1 = missing) and a recorded proxy X*, equal to X when R_X = 0 and missing otherwise (Equation 1). Arrows into R_X say what causes X to be missing.")),
        h("details", null, h("summary", null, "Recoverable"), h("p", { class: "small" }, "A quantity is recoverable if it can be estimated consistently from the incomplete data for every strictly positive observed-data distribution the graph allows (Definition 1). The answer depends on the graph, not on the data.")),
        h("details", null, h("summary", null, "Undetermined"), h("p", { class: "small" }, "No criterion of the paper recovers the query and none proves it impossible. That is not a proof either way; the paper's Section 3.4 describes recoveries that use features of the data beyond the graph.")),
        h("details", null, h("summary", null, "Checking these answers"), h("p", { class: "small" }, "Every formula here was produced from d-separations the graph implies. The test suite also evaluates such formulas on random models of each graph and compares them with the truth.")));
    }
  }

  MG.ui.MissingPanel = MissingPanel;
})(globalThis.MG);
