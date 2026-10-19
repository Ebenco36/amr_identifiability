/* Node tab: everything about one node, including every independence it takes part in.
 * With no node selected it shows the model overview (roles, structure, self-masking). */
(function (MG) {
  "use strict";
  const { h, icon, roleGlyph, statementText } = MG.ui;

  class InspectorPanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.testableOnly = false;
    }

    get title() {
      return "Node";
    }

    shouldRender(changed) {
      return ["node", "modelKey", "edits", "statement", "filters"].some((k) => changed.has(k));
    }

    render(body) {
      const id = this.store.state.node;
      const graph = this.store.graph();
      body.replaceChildren(id && graph.has(id) ? this._node(graph, id) : this._overview(graph));
    }

    // ---------------------------------------------------------------- overview

    _overview(graph) {
      const roles = MG.ROLES.map((r) => ({ role: r, nodes: MG.sorted(graph.ids.filter((n) => graph.role(n) === r)) })).filter((r) => r.nodes.length);
      const problems = graph.validate();
      const masking = graph.selfMasking();
      const mech = graph.indicators.size ? MG.missing.classify(graph) : null;
      const t2 = graph.indicators.size ? MG.missing.theorem2(graph) : null;
      const cat = this.store.catalogue(graph);
      const sum = cat.summary();
      const total = graph.ids.length;
      const spec = this.store.model;
      if (!graph.ids.length)
        return h("div", { class: "empty" }, h("p", null, h("b", null, "An empty graph. "), "Turn on Edit (E) and double-click the canvas to add nodes, or use Import a DAG in the graph menu."),
          h("button", { class: "btn small primary", onClick: () => this.app.toggleEdit(true) }, icon("edit"), "Start editing"));
      return h("div", null,
        spec.description || spec.note ? h("div", { class: "panel-section" },
          spec.group ? h("div", { class: "eyebrow" }, spec.group) : null,
          spec.description ? h("p", { style: { margin: "0 0 6px" } }, spec.description) : null,
          spec.note ? h("div", { class: "problem" }, h("b", null, "Note on the paper: "), spec.note) : null) : null,
        h("div", { class: "panel-section" },
          h("h3", null, graph.name, h("span", { class: "aside" }, `${graph.ids.length} nodes · ${graph.edgeCount} edges`)),
          h("div", { class: "role-bar", "aria-hidden": "true" }, roles.map((r) => h("span", { style: { width: `${(100 * r.nodes.length) / total}%`, background: `var(--r-${MG.ui.ROLE_CLASS[r.role]})` } }))),
          h("dl", { class: "kv" }, roles.map((r) => [
            h("dt", null, h("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } }, roleGlyph(r.role, 18, 11), r.role)),
            h("dd", null, h("div", { class: "chip-row" }, r.nodes.map((n) => this._chip(n)))),
          ]))),
        h("div", { class: "panel-section" },
          h("h3", null, "Independences", h("span", { class: "aside" }, "between recorded nodes")),
          h("div", { class: "stat-grid" },
            stat(sum.sets, "minimal separating sets"),
            stat(sum.testable, "testable in recorded data"),
            stat(sum.separable, "pairs that can be separated"),
            stat(sum.inseparable + sum.adjacent, "pairs never independent")),
          h("div", { class: "form-row" }, h("button", { class: "btn small", onClick: () => this.app.showTab("conditions") }, "Browse all", icon("arrow")))),
        h("div", { class: "panel-section" },
          h("h3", null, "Missing-data structure"),
          problems.length ? problems.map((p) => h("div", { class: "problem" }, p)) : h("div", { class: "problem ok" }, "Valid m-graph: every proxy has exactly its variable and indicator as parents."),
          Object.keys(masking).length
            ? Object.entries(masking).map(([v, why]) => h("div", { class: "problem" }, h("b", { class: "mono" }, v), " self-masking: ", why))
            : h("div", { class: "problem ok" }, "No self-masking: no result drives its own missingness, directly or through latent nodes."),
          mech ? h("div", { class: mech.mechanism === "MNAR" ? "problem" : "problem ok" }, h("b", null, mech.mechanism + ": "), mech.text) : null,
          t2 ? h("div", { class: t2.recoverable === true ? "problem ok" : "problem" },
            t2.applies ? (t2.recoverable ? "The joint distribution is recoverable (Theorem 2)." : `The joint distribution is not recoverable (Theorem 2): ${t2.violations.map((v) => v.text).join("; ")}.`)
              : "Theorem 2 does not apply: some missingness indicators share an edge or an unrecorded cause.") : null,
          mech ? h("div", { class: "form-row" }, h("button", { class: "btn small", onClick: () => this.app.showTab("missing") }, "Missing data", icon("arrow")), h("button", { class: "btn small", onClick: () => this.app.showTab("causal") }, "Causal effect", icon("arrow"))) : h("div", { class: "form-row" }, h("button", { class: "btn small", onClick: () => this.app.showTab("causal") }, "Causal effect", icon("arrow")))),
        h("div", { class: "empty" }, h("p", null, "Click a node to see its parents, children and every independence it takes part in."))
      );
    }

    // ---------------------------------------------------------------- one node

    _node(graph, id) {
      const role = graph.role(id);
      const meta = graph.meta.get(id) || {};
      const cat = graph.recorded.has(id) ? this.store.catalogue(graph) : null;
      const head = h("div", { class: "panel-section" },
        h("div", { class: "node-head" },
          roleGlyph(role, 30, 18),
          h("div", null, h("h2", null, id), h("div", { class: "desc" }, meta.description || role), h("div", { style: { marginTop: "6px" } }, h("span", { class: "tag role" }, role))),
          h("div", { class: "actions-row" },
            MG.ui.iconButton("query", "Use in a query", { onClick: () => this.app.queryFrom(id) }),
            MG.ui.iconButton("target", "Centre on graph", { onClick: () => this.app.view.centerOn(id) }),
            MG.ui.iconButton("close", "Clear selection", { onClick: () => this.store.set({ node: null }) }))),
        h("dl", { class: "kv", style: { marginTop: "12px" } },
          h("dt", null, "Parents"), h("dd", null, this._chips(graph.parents(id))),
          h("dt", null, "Children"), h("dd", null, this._chips(graph.children(id))),
          h("dt", null, "Ancestors"), h("dd", { class: "muted" }, String(graph.ancestors(id).size)),
          h("dt", null, "Descendants"), h("dd", { class: "muted" }, String(graph.descendants(id).size))),
      );
      const sections = [head, this._changeNode(graph, id)];
      const lm = MG.localMarkov(graph, id);
      if (lm) sections.push(h("div", { class: "panel-section" }, h("h3", null, "Local Markov", h("span", { class: "aside" }, "independent of its non-descendants given its parents")), this._stmtRow(graph, lm, { tag: h("span", { class: "tag local" }, "local") })));
      if (!cat) {
        sections.push(h("div", { class: "empty" }, h("p", null, "Latent nodes cannot be conditioned on or tested, so pairwise independences are listed for recorded nodes only.")));
        return h("div", null, sections);
      }
      const pairs = cat.forNode(id);
      const sep = pairs.filter((p) => (this.testableOnly ? p.testable.length : p.separators.length));
      const never = pairs.filter((p) => !p.separators.length);
      const nSets = sep.reduce((n, p) => n + (this.testableOnly ? p.testable.length : p.separators.length + p.testable.filter((z) => !p.separators.some((s) => MG.setEq(s, z))).length), 0);
      const toggle = h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: this.testableOnly, onChange: (e) => { this.testableOnly = e.target.checked; this.render(this.app.body); } }), "Testable only");
      sections.push(h("div", { class: "panel-section" },
        h("h3", null, "Independent of", h("span", { class: "aside" }, `${MG.plural(sep.length, "node")} · ${MG.plural(nSets, "statement")}`)),
        h("div", { class: "filters", style: { marginBottom: "6px" } }, toggle),
        sep.length ? sep.map((p) => this._partner(graph, id, p)) : h("p", { class: "muted" }, this.testableOnly ? "No testable statements involve this node." : "No recorded set separates this node from any other.")));
      if (never.length && !this.testableOnly)
        sections.push(h("div", { class: "panel-section" },
          h("h3", null, "Never independent of", h("span", { class: "aside" }, MG.plural(never.length, "node"))),
          h("div", { class: "chip-row" }, never.map((p) => this._chip(p.other(id), p.adjacent ? "adjacent" : "no recorded separator")))));
      return h("div", null, sections);
    }

    /** Rename, change the role, or delete the node. Every change can be undone. */
    _changeNode(graph, id) {
      const store = this.store;
      const role = graph.role(id);
      const meta = graph.meta.get(id) || {};
      const name = h("input", { class: "input mono grow", value: id, "aria-label": "Node name" });
      const rename = () => {
        const to = name.value.trim();
        if (to && to !== id) store.renameNode(id, to);
      };
      name.addEventListener("keydown", (e) => e.key === "Enter" && rename());
      const toggle = (label, checked, onChange, title) =>
        h("label", { class: "toggle", title }, h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }), label);
      const rows = [h("div", { class: "form-row", style: { marginTop: 0 } }, name, h("button", { class: "btn small", onClick: rename }, "Rename"))];
      const flags = [];
      if (meta.bidirected) {
        flags.push(h("span", { class: "muted", style: { fontSize: "12px" } }, `Unrecorded common cause of ${meta.bidirected.join(" and ")}.`));
      } else {
        if (role === "fully observed" || role === "partially observed")
          flags.push(toggle("Partially observed", role === "partially observed", (on) => (on ? store.makePartial(id) : store.makeFull(id)), "Adds or removes its missingness indicator R_X and recorded proxy X_star"));
        if (role === "fully observed" || role === "latent")
          flags.push(toggle("Unmeasured (latent)", role === "latent", () => store.toggleLatent(id), "A latent variable is never recorded and cannot be conditioned on"));
        if (role !== "latent" && role !== "missingness indicator" && role !== "recorded proxy") {
          flags.push(toggle("Exposure", !!meta.exposure, (on) => store.setNodeFlag(id, "exposure", on), "Default treatment in the Causal effect tab"));
          flags.push(toggle("Outcome", !!meta.outcome, (on) => store.setNodeFlag(id, "outcome", on), "Default outcome in the Causal effect tab"));
        }
      }
      if (flags.length) rows.push(h("div", { class: "filters", style: { marginTop: "10px" } }, flags));
      rows.push(h("div", { class: "form-row" },
        h("button", { class: "btn small danger", onClick: () => store.deleteNode(id) }, icon("close"), meta.bidirected ? "Remove this common cause" : role === "partially observed" ? "Delete node, its indicator and proxy" : "Delete node"),
        h("span", { class: "faint", style: { fontSize: "11.5px" } }, "⌘Z undoes any change")));
      return h("div", { class: "panel-section" }, h("h3", null, "Change this node"), rows);
    }

    _partner(graph, id, p) {
      const other = p.other(id);
      const rows = [];
      const sets = this.testableOnly ? [] : p.separators;
      for (const z of sets) {
        const st = new MG.Statement([id], [other], z);
        rows.push(this._stmtRow(graph, st, { given: true, testable: p.isTestableSet(z) }));
      }
      for (const z of p.testable) {
        if (!this.testableOnly && p.separators.some((s) => MG.setEq(s, z))) continue;
        rows.push(this._stmtRow(graph, new MG.Statement([id], [other], z), { given: true, testable: true }));
      }
      return h("div", { class: "partner" },
        h("div", { class: "partner-head" }, this._chip(other), h("span", { class: "count" }, MG.plural(rows.length, "set"))),
        rows);
    }

    _stmtRow(graph, st, { tag = null, given = false, testable = false } = {}) {
      const active = this.store.state.statement === st.toString();
      let recorded = testable ? MG.Statement.recordedForm(graph, st) : null;
      if (recorded === st.toString()) recorded = null;
      const text = given ? h("span", { class: "stmt" }, h("span", { class: "given" }, "given "), st.z.size ? MG.sorted(st.z).join(", ") : "nothing (marginal)") : statementText(st);
      return h("div", { class: ["stmt-row", active ? "is-active" : null], tabindex: 0, onClick: () => this.app.showStatement(st.toString(), { stay: true }), onKeydown: (e) => e.key === "Enter" && this.app.showStatement(st.toString(), { stay: true }) },
        h("div", null, text, recorded ? h("div", { class: "sub" }, recorded) : null),
        h("div", { class: "row-tools" },
          tag || (testable ? h("span", { class: "tag testable" }, "testable") : null),
          h("button", { class: "row-btn", title: "Open in Query", "aria-label": "Open in Query", onClick: (e) => { e.stopPropagation(); this.app.showStatement(st.toString()); } }, icon("arrow"))));
    }

    _chips(nodes) {
      const list = MG.sorted(nodes);
      return list.length ? h("div", { class: "chip-row" }, list.map((n) => this._chip(n))) : h("span", { class: "faint" }, "none");
    }

    _chip(n, title) {
      const role = this.store.graph().role(n);
      return h("button", { class: "chip", title: title || role, onClick: () => this.app.selectNode(n) }, h("span", { class: "dot", style: { background: `var(--r-${MG.ui.ROLE_CLASS[role]})` } }), n);
    }
  }

  function stat(value, label) {
    return h("div", { class: "stat" }, h("b", null, value.toLocaleString("en-US")), h("span", null, label));
  }

  MG.ui.InspectorPanel = InspectorPanel;
})(globalThis.MG);
