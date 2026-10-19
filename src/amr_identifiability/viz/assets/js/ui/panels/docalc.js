/* do-calculus practice: build P(Y | do(X), Z), see which moves Rules 1-3 allow and why, apply
 * them, and keep the derivation. The graph shows the mutilated graph each rule checks. */
(function (MG) {
  "use strict";
  const { h, icon } = MG.ui;
  const M = () => MG.ui.math;

  class DoCalcPanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this._key = null;
      this.term = { Y: [], X: [], Z: [] };
      this.history = [];
    }

    get title() {
      return "do-calculus";
    }

    shouldRender(changed) {
      return ["modelKey", "edits"].some((k) => changed.has(k));
    }

    _nodes(graph) {
      return MG.sorted(graph.ids.filter((v) => !graph.latent.has(v)));
    }

    render(body) {
      const graph = this.store.graph();
      const k = this.store.state.modelKey + graph.ids.join() + graph.edgeCount;
      if (this._key !== k) {
        this._key = k;
        const meta = (v) => graph.meta.get(v) || {};
        const X = graph.ids.filter((v) => meta(v).exposure), Y = graph.ids.filter((v) => meta(v).outcome);
        this.term = { Y, X, Z: [] };
        this.history = [];
      }
      body.replaceChildren(this._intro(), this._builder(graph), this._current(graph), this._moves(graph), this._derivation(graph));
      this._emphasise();
    }

    _emphasise() {
      const { X, Y, Z } = this.term;
      this.store.setTransient({ emphasis: X.length || Y.length ? { x: new Set(X), y: new Set(Y), z: new Set(Z) } : null, cut: null });
    }

    _intro() {
      return h("div", { class: "panel-section" },
        h("h3", null, "Practice the do-calculus", h("span", { class: "aside" }, "Pearl 1995")),
        h("p", { class: "muted small", style: { margin: 0 } }, "Each rule rewrites a term when a d-separation holds in a mutilated graph. The goal is a term with no do(): then the effect is estimable from observational data. Hover a move to see, on the graph, the edges that rule removes."));
    }

    _builder(graph) {
      const ids = this._nodes(graph);
      const slot = (key, label, cls) => h("div", { class: "slot" },
        h("span", { class: ["slot-label", cls] }, label),
        h("div", { class: "chip-row" }, this.term[key].length ? this.term[key].map((n) => h("button", { class: "chip", onClick: () => this._setTerm({ [key]: this.term[key].filter((m) => m !== n) }) }, n, h("span", { class: "x" }, "×"))) : h("span", { class: "placeholder" }, key === "Y" ? "choose" : "none")),
        h("select", { class: "select", "aria-label": `Add to ${label}`, onChange: (e) => {
            const v = e.target.value;
            if (!v) return;
            const others = Object.fromEntries(["Y", "X", "Z"].filter((s) => s !== key).map((s) => [s, this.term[s].filter((m) => m !== v)]));
            this._setTerm({ ...others, [key]: MG.sorted([...this.term[key], v]) });
          } }, h("option", { value: "" }, "add…"), ids.filter((v) => !this.term[key].includes(v)).map((v) => h("option", { value: v }, v))));
      return h("div", { class: "panel-section" },
        h("div", { class: "slots" }, slot("Y", "Y", ""), slot("X", "do", "do"), slot("Z", "Z", "z")),
        h("div", { class: "form-row" }, h("button", { class: "btn small", onClick: () => this._reset() }, "Start over")));
    }

    _setTerm(patch, note = null) {
      if (note) this.history.push({ from: { ...this.term }, note });
      this.term = { ...this.term, ...patch };
      this.render(this.app.body);
    }

    _reset() {
      if (this.history.length) this.term = { ...this.history[0].from };
      this.history = [];
      this.render(this.app.body);
    }

    _current(graph) {
      const { Y, X, Z } = this.term;
      if (!Y.length) return h("div", { class: "empty" }, h("p", null, "Choose at least one outcome Y."));
      const done = !X.length;
      return h("div", { class: "panel-section" },
        h("div", { class: "formula-box" }, h("div", { class: "math" }, M().query(Y, Z, X))),
        done ? h("div", { class: "problem ok", style: { marginTop: "8px" } }, "No do() left: this term is an observational probability.") : null);
    }

    /** Every move the rules allow from the current term, and the ones they forbid. */
    _moves(graph) {
      const { Y, X, Z } = this.term;
      if (!Y.length) return h("div");
      const ids = this._nodes(graph).filter((v) => !Y.includes(v));
      const moves = [];
      // Rule 1: remove or add an observation
      for (const z of Z) moves.push(this._check(graph, 1, { Y, X, Z: [z], W: Z.filter((w) => w !== z) }, `Remove the observation ${z}`, { Z: Z.filter((w) => w !== z) }));
      for (const w of ids.filter((v) => !X.includes(v) && !Z.includes(v)).slice(0, 12)) moves.push(this._check(graph, 1, { Y, X, Z: [w], W: Z }, `Add the observation ${w}`, { Z: MG.sorted([...Z, w]) }));
      // Rule 2: exchange an intervention and an observation
      for (const x of X) moves.push(this._check(graph, 2, { Y, X: X.filter((v) => v !== x), Z: [x], W: Z }, `Replace do(${x}) by observing ${x}`, { X: X.filter((v) => v !== x), Z: MG.sorted([...Z, x]) }));
      for (const z of Z) moves.push(this._check(graph, 2, { Y, X, Z: [z], W: Z.filter((w) => w !== z) }, `Replace observing ${z} by do(${z})`, { X: MG.sorted([...X, z]), Z: Z.filter((w) => w !== z) }));
      // Rule 3: remove an intervention
      for (const x of X) moves.push(this._check(graph, 3, { Y, X: X.filter((v) => v !== x), Z: [x], W: Z }, `Remove do(${x})`, { X: X.filter((v) => v !== x) }));
      const allowed = moves.filter((m) => m.holds), blocked = moves.filter((m) => !m.holds);
      const row = (m) => h("div", { class: ["move", m.holds ? "ok" : "no"], tabindex: 0,
          onMouseenter: () => this._showCut(graph, m), onMouseleave: () => this._emphasise(),
          onFocus: () => this._showCut(graph, m), onBlur: () => this._emphasise() },
        h("div", { class: "move-head" }, h("span", { class: ["tag", m.holds ? "testable" : "never"] }, `Rule ${m.rule}`), h("span", null, m.label)),
        h("div", { class: "muted small" }, `${m.holds ? "Valid: " : "Not valid: "}${m.statement.pretty()} ${m.holds ? "holds" : "fails"} in ${m.label2}.`),
        m.holds ? h("button", { class: "btn small", onClick: () => this._setTerm(m.next, `Rule ${m.rule}: ${m.label}`) }, "Apply") : null);
      return h("div", { class: "panel-section" },
        h("h3", null, "Possible moves", h("span", { class: "aside" }, `${allowed.length} valid`)),
        allowed.length ? allowed.map(row) : h("p", { class: "muted small" }, "No rule applies to this term directly. Try adding an observation first, or ask the ID algorithm in the Causal effect tab."),
        blocked.length ? h("details", null, h("summary", null, `Moves the rules forbid (${blocked.length})`), blocked.map(row)) : null);
    }

    _check(graph, rule, sets, label, next) {
      const r = MG.causal.doRule(graph, rule, sets);
      return { rule, holds: r.holds, statement: r.statement, label, label2: r.label, next, graph: r.graph };
    }

    _showCut(graph, m) {
      const keep = new Set(m.graph.edges.map(([a, b]) => MG.scene.edgeKey(a, b)));
      const cut = new Set(graph.edges.map(([a, b]) => MG.scene.edgeKey(a, b)).filter((k) => !keep.has(k)));
      const { X, Y, Z } = this.term;
      this.store.setTransient({ emphasis: { x: new Set(X), y: new Set(Y), z: new Set(Z) }, cut });
    }

    _derivation(graph) {
      if (!this.history.length) return h("div");
      return h("div", { class: "panel-section" },
        h("h3", null, "Your derivation"),
        h("ol", { class: "steps" }, this.history.map((s) => h("li", null, h("div", { class: "math small-math" }, M().query(s.from.Y, s.from.Z, s.from.X)), h("div", { class: "muted small" }, s.note))),
          h("li", null, h("div", { class: "math small-math" }, M().query(this.term.Y, this.term.Z, this.term.X)), h("div", { class: "muted small" }, "current term"))),
        h("div", { class: "form-row" },
          h("button", { class: "btn small", onClick: () => { const last = this.history.pop(); this.term = { ...last.from }; this.render(this.app.body); } }, icon("undo"), "Undo step"),
          h("button", { class: "btn small", onClick: () => { this.store.state.causalQuery = { X: this.history[0].from.X, Y: this.history[0].from.Y, Z: this.history[0].from.Z }; this.app.panels.causal._key = null; this.app.showTab("causal"); } }, "Compare with the ID algorithm", icon("arrow"))));
    }
  }

  MG.ui.DoCalcPanel = DoCalcPanel;
})(globalThis.MG);
