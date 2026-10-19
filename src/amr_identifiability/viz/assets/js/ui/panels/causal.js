/* Causal effect tab: P(Y | do(X)) or P(Y | do(X), Z). Identification by the ID algorithm with its
 * derivation, adjustment sets, front-door and instruments, causal and back-door paths, and
 * Section 3.5 of Mohan & Pearl (2021) when variables are partially observed. */
(function (MG) {
  "use strict";
  const { h, icon } = MG.ui;
  const M = () => MG.ui.math;

  class CausalPanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.q = { X: [], Y: [], Z: [] };
      this._key = null;
    }

    get title() {
      return "Causal effect";
    }

    shouldRender(changed) {
      return ["modelKey", "edits"].some((k) => changed.has(k)) || changed.has("t:pick");
    }

    _defaults(graph) {
      const ids = graph.ids.filter((v) => !graph.latent.has(v) && !graph.indicators.has(v) && !graph.proxies.has(v));
      const meta = (v) => graph.meta.get(v) || {};
      let X = ids.filter((v) => meta(v).exposure), Y = ids.filter((v) => meta(v).outcome);
      if (!X.length || !Y.length) {
        // a pair with a directed path, preferring a root and a sink
        const order = MG.ADMG.project(graph).topological().filter((v) => ids.includes(v));
        for (const a of order) {
          const b = [...order].reverse().find((c) => c !== a && graph.descendants(a).has(c));
          if (b) {
            if (!X.length) X = [a];
            if (!Y.length) Y = [b];
            break;
          }
        }
      }
      return { X, Y: Y.filter((v) => !X.includes(v)), Z: [] };
    }

    render(body) {
      const graph = this.store.graph();
      const k = this.store.state.modelKey + graph.ids.join();
      if (this._key !== k) {
        this._key = k;
        const saved = this.store.state.causalQuery;
        this.q = saved && [...saved.X, ...saved.Y, ...saved.Z].every((v) => graph.has(v)) ? saved : this._defaults(graph);
      }
      body.replaceChildren(this._builder(graph), ...this._results(graph));
      this._emphasise();
    }

    _emphasise() {
      const { X, Y, Z } = this.q;
      const z = this._shown || new Set(Z);
      this.store.setTransient({ emphasis: X.length || Y.length ? { x: new Set(X), y: new Set(Y), z } : null });
    }

    _set(patch) {
      this._shown = null;
      this.q = { ...this.q, ...patch };
      this.store.state.causalQuery = this.q;
      this.render(this.app.body);
    }

    _builder(graph) {
      const ids = MG.sorted(graph.ids.filter((v) => !graph.latent.has(v) && !graph.indicators.has(v) && !graph.proxies.has(v)));
      const pick = this.store.transient.pick;
      const slot = (key, label, cls) => {
        const members = this.q[key];
        return h("div", { class: "slot" },
          h("span", { class: ["slot-label", cls] }, label),
          h("div", { class: "chip-row" }, members.length ? members.map((n) => h("button", { class: "chip", onClick: () => this._set({ [key]: members.filter((m) => m !== n) }) }, n, h("span", { class: "x" }, "×"))) : h("span", { class: "placeholder" }, key === "Z" ? "nothing (optional)" : "choose")),
          h("select", { class: "select", "aria-label": `Add to ${label}`, onChange: (e) => {
              const v = e.target.value;
              if (!v) return;
              const others = Object.fromEntries(["X", "Y", "Z"].filter((s) => s !== key).map((s) => [s, this.q[s].filter((m) => m !== v)]));
              this._set({ ...others, [key]: MG.sorted([...members, v]) });
            } }, h("option", { value: "" }, "add…"), ids.filter((v) => !members.includes(v)).map((v) => h("option", { value: v }, v))));
      };
      return h("div", { class: "panel-section" },
        h("h3", null, "Causal question", h("span", { class: "aside" }, "do-calculus, ID algorithm")),
        h("div", { class: "slots" }, slot("X", "do", "do"), slot("Y", "Y", ""), slot("Z", "Z", "z")),
        h("p", { class: "muted small", style: { margin: "8px 0 0" } }, "do = treatments set by intervention, Y = outcomes, Z = optional observed conditions. Mark Exposure and Outcome on nodes in the Node tab to make them the default."));
    }

    /** The answer runs after the tab has painted, under a time limit, and is cached per graph and question. */
    _results(graph) {
      const { X, Y, Z } = this.q;
      if (!X.length || !Y.length) return [h("div", { class: "empty" }, h("p", null, "Choose a treatment and an outcome."))];
      const key = `effect:${JSON.stringify([X, Y, Z])}`;
      const render = (entry, retry) => {
        if (entry.timeUp) return h("div", { class: "panel-section" }, MG.ui.deferred.timeUp(entry, retry, "this effect"));
        if (entry.error) return h("div", { class: "panel-section" }, h("div", { class: "verdict err" }, h("b", null, "Can't ask this"), h("span", { class: "why" }, entry.error.message)));
        return h("div", { class: "deferred-body" }, this._sections(graph, entry.value));
      };
      const compute = () => MG.causal.effect(graph, X, Y, Z);
      // a partially observed treatment needs the long do-calculus search: run it in the background
      if (X.some((x) => graph.partiallyObserved.has(x)))
        return [MG.ui.deferred.slotInWorker(graph, key, { kind: "effect", args: [X, Y, Z] }, compute, render, { label: "Searching for a formula (do-calculus with missing data)…" })];
      return [MG.ui.deferred.slot(graph, key, compute, render, { label: "Identifying the effect…" })];
    }

    _sections(graph, r) {
      const { X, Y, Z } = this.q;
      const q = () => M().query(Y, Z, X); // a fresh node for each place it appears
      const out = [];
      // verdict
      if (r.recoverable === true) {
        const how = r.missing ? `Identifiable, and recoverable from the incomplete data by ${r.method} (Mohan & Pearl 2021, Section 3.5).` : "Identifiable: the ID algorithm expresses it in observational probabilities.";
        out.push(h("div", { class: "panel-section" }, h("div", { class: "verdict yes" }, h("span", { class: "mark" }, icon("check")), h("b", null, ["Identifiable: ", q()]), h("span", { class: "why" }, how)), M().formula(r.expr, { lhs: q() })));
      } else if (r.identifiable === false) {
        out.push(h("div", { class: "panel-section" }, h("div", { class: "verdict no" }, h("span", { class: "mark" }, icon("cross")), h("b", null, ["Not identifiable: ", q()]),
          h("span", { class: "why" }, `No formula in observational probabilities exists. The ID algorithm found a hedge: {${MG.sorted(r.hedge.F).join(", ")}} and {${MG.sorted(r.hedge.Fprime).join(", ")}} are each joined by unrecorded common causes${r.missing ? "; so it cannot be recovered under missingness either (Section 3.5)" : ""}.`)),
          h("button", { class: "btn small", style: { marginTop: "8px" }, onClick: () => this.app.view.fit(true, [...r.hedge.F]) }, "Show the hedge")));
      } else {
        out.push(h("div", { class: "panel-section" }, h("div", { class: "verdict err" }, h("b", null, ["Identifiable, recovery undetermined: ", q()]), h("span", { class: "why" }, r.reason || "")),
          r.idExpr ? [h("p", { class: "muted small" }, "Without missing data it would be:"), M().formula(r.idExpr, { lhs: q() })] : null));
      }
      // ID derivation
      if (r.trace && r.trace.length)
        out.push(h("div", { class: "panel-section" }, h("details", { class: "derivation" }, h("summary", null, `How the ID algorithm decides (${r.trace.length} step${r.trace.length === 1 ? "" : "s"})`),
          h("ol", { class: "steps" }, r.trace.map((t) => h("li", { style: { marginLeft: `${Math.min(t.depth, 6) * 10}px` } }, h("div", { class: "step-title" }, typeof t.line === "number" ? `Line ${t.line}` : t.line), h("div", { class: "small" }, t.text)))))));
      if (r.missing && r.factorResults)
        out.push(h("div", { class: "panel-section" }, h("h3", null, "Each factor, recovered"), r.factorResults.map((p) => h("div", { class: "stmt-row", style: { cursor: "default" } }, h("div", null, h("span", { class: "mono" }, p.query), h("div", { class: "muted small" }, p.method))))));
      // adjustment, front-door, instruments
      if (r.adjustment) out.push(this._adjustment(graph, r));
      if (r.frontDoor && r.frontDoor.length) out.push(this._frontDoor(r));
      if (r.instruments && r.instruments.length) out.push(this._instruments(r));
      if (r.paths) out.push(this._paths(r));
      if (r.missing) out.push(h("div", { class: "panel-section" }, h("p", { class: "muted small", style: { margin: 0 } }, "Adjustment sets and paths are listed for graphs without partially observed variables. Here the effect is first identified in the substantive model (indicators and proxies removed), then recovered from the incomplete data.")));
      return out;
    }

    _adjustment(graph, r) {
      const a = r.adjustment;
      const { X, Y } = this.q;
      const body = [];
      if (!a.exists) body.push(h("p", { class: "muted small", style: { margin: 0 } }, "No set of observed variables satisfies the adjustment criterion: some non-causal path cannot be blocked without blocking or distorting the effect."));
      else {
        body.push(h("p", { class: "muted small", style: { marginTop: 0 } }, "Each set blocks every non-causal path and contains no descendant of a mediator (generalised adjustment criterion). Click one to see the formula."));
        body.push(h("div", { class: "chip-row" }, a.minimal.map((Z) => h("button", { class: "chip", onClick: () => this._showSet(Z) }, Z.size ? MG.sorted(Z).join(", ") : "∅ (no adjustment needed)"))));
        if (a.optimal) body.push(h("div", { class: "problem ok" }, h("b", null, "Optimal set: "), MG.sorted(a.optimal).join(", ") || "∅", " — the valid set with the smallest asymptotic variance (Henckel et al. 2022)."));
        if (this._shown) body.push(h("div", { style: { marginTop: "10px" } }, M().formula(MG.causal.adjustmentFormula(X, Y, this._shown), { lhs: M().query(Y, [], X) })));
      }
      const custom = h("input", { class: "input mono grow", placeholder: "Check your own set, e.g. A, B", "aria-label": "Adjustment set to check" });
      const verdict = h("span", { class: "small" });
      custom.addEventListener("input", () => {
        const Z = custom.value.split(/[,\s]+/).filter(Boolean);
        if (!Z.length) return (verdict.textContent = "");
        const unknown = Z.filter((z) => !graph.has(z));
        if (unknown.length) return (verdict.textContent = `unknown: ${unknown.join(", ")}`);
        const bad = Z.filter((z) => a.forbidden.has(z) || graph.latent.has(z));
        verdict.textContent = bad.length ? `not valid: ${bad.join(", ")} ${bad.some((b) => graph.latent.has(b)) ? "is latent or " : ""}is a descendant of a mediator or a treatment` : a.isValid(new Set(Z)) ? "valid adjustment set" : "not valid: a non-causal path stays open";
        verdict.style.color = a.isValid(new Set(Z)) ? "var(--implied)" : "var(--not)";
      });
      return h("div", { class: "panel-section" }, h("h3", null, "Adjustment sets", h("span", { class: "aside" }, a.exists ? `${a.minimal.length} minimal` : "none")), body, h("div", { class: "form-row" }, custom, verdict));
    }

    /** Show an adjustment set's formula, with the set drawn as conditioned on the graph. */
    _showSet(Z) {
      this._shown = new Set(Z);
      this.render(this.app.body);
    }

    _frontDoor(r) {
      return h("div", { class: "panel-section" }, h("h3", null, "Front-door", h("span", { class: "aside" }, "Pearl 1995")),
        h("p", { class: "muted small", style: { marginTop: 0 } }, "These sets carry the whole effect, have no open back-door path from the treatment, and their back-door paths to the outcome are blocked by the treatment."),
        r.frontDoor.map((Mset) => M().formula(MG.expr.present(MG.causal.frontDoorFormula(r.X[0], r.Y[0], Mset)), { lhs: `via {${MG.sorted(Mset).join(", ")}}` })));
    }

    _instruments(r) {
      return h("div", { class: "panel-section" }, h("h3", null, "Instrumental variables"),
        h("p", { class: "muted small", style: { marginTop: 0 } }, "An instrument affects the outcome only through the treatment. Instruments identify the effect only with extra assumptions (for example linear effects, or bounds); the graph alone does not."),
        h("div", { class: "chip-row" }, r.instruments.map((iv) => h("span", { class: "chip static" }, iv.z, iv.given.length ? ` given ${iv.given.join(", ")}` : ""))));
    }

    _paths(r) {
      const row = (p, kind) => h("div", { class: ["path-row", kind === "causal" ? "open" : null], onMouseenter: () => this.store.setTransient({ focusPath: p }), onMouseleave: () => this.store.setTransient({ focusPath: null }) },
        h("span", { class: "len" }, String(p.path.length - 1)), h("span", { class: "p" }, MG.dsep.formatPath(p)), h("span", { class: "r" }, kind));
      const { causal, backdoor } = r.paths;
      return h("div", { class: "panel-section" }, h("h3", null, "Paths", h("span", { class: "aside" }, "hover to trace")),
        causal.length ? causal.slice(0, 40).map((p) => row(p, "causal")) : h("p", { class: "muted small" }, "No causal path: the treatment cannot affect the outcome."),
        backdoor.slice(0, 40).map((p) => row(p, "back-door")));
    }
  }

  MG.ui.CausalPanel = CausalPanel;
})(globalThis.MG);
