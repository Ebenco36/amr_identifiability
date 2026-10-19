/* Query tab: check any statement X _||_ Y | Z, see why it holds or fails, and compare models. */
(function (MG) {
  "use strict";
  const { h, icon, debounce } = MG.ui;

  const SLOT_LABEL = { x: "X", y: "Y", z: "Z" };

  class QueryPanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this._typing = false;
    }

    get title() {
      return "Query";
    }

    shouldRender(changed) {
      return ["statement", "modelKey", "edits"].some((k) => changed.has(k)) || changed.has("t:pick") || changed.has("t:pathTab");
    }

    render(body) {
      this.body = body;
      if (!this.input || !this.input.isConnected) {
        this.input = h("input", { class: "input mono", style: { width: "100%" }, spellcheck: false, autocomplete: "off", placeholder: "Yk _||_ R_Yk | S, W, T", "aria-label": "Independence statement" });
        this.input.addEventListener("input", debounce((e) => {
          this._typing = true;
          this.store.set({ statement: e.target.value.trim() || null });
          this._typing = false;
        }, 160));
        this.details = h("div");
        body.replaceChildren(
          h("div", { class: "panel-section" },
            h("h3", null, "Statement", h("span", { class: "aside" }, "X _||_ Y | Z   ·   ⊥⊥ also works")),
            this.input,
            this.slots = h("div", { class: "slots", style: { marginTop: "10px" } })),
          this.details);
      }
      if (document.activeElement !== this.input) this.input.value = this.store.state.statement || "";
      this._slots();
      this._details();
    }

    _current() {
      const a = this.store.analysis();
      if (a && a.statement) return a.statement;
      if (a && a.text) {
        try {
          return MG.Statement.parse(a.text);
        } catch (e) {
          return null;
        }
      }
      return null;
    }

    _slots() {
      const st = this._current() || new MG.Statement([], [], []);
      const pick = this.store.transient.pick;
      const row = (slot) => {
        const members = MG.sorted(st[slot]);
        return h("div", { class: "slot" },
          h("span", { class: ["slot-label", slot === "z" ? "z" : null] }, SLOT_LABEL[slot]),
          h("div", { class: "chip-row" },
            members.length ? members.map((n) => h("button", { class: "chip", title: `Remove ${n}`, onClick: () => this.app.toggleInSlot(slot, n) }, n, h("span", { class: "x" }, "×")))
              : h("span", { class: "placeholder" }, slot === "z" ? "nothing conditioned on" : "empty")),
          h("button", { class: "btn small pick", "aria-pressed": String(pick === slot), title: `Click nodes on the graph to add them to ${SLOT_LABEL[slot]}`, onClick: () => this.store.setTransient({ pick: pick === slot ? null : slot }) },
            pick === slot ? "Picking…" : "Pick"));
      };
      this.slots.replaceChildren(row("x"), row("y"), row("z"));
    }

    _details() {
      const a = this.store.analysis();
      const graph = this.store.graph();
      if (!a) return this.details.replaceChildren(this._examples(graph));
      if (a.error)
        return this.details.replaceChildren(h("div", { class: "panel-section" }, h("div", { class: "verdict err" }, h("b", null, "Can't check this yet"), h("span", { class: "why" }, a.error))));
      const st = a.statement;
      const nOpen = a.open.paths.length;
      const verdict = h("div", { class: ["verdict", a.implied ? "yes" : "no"] },
        h("span", { class: "mark" }, icon(a.implied ? "check" : "cross")),
        h("b", null, a.implied ? "Implied by the graph" : "Not implied by the graph"),
        h("span", { class: "why" }, a.implied ? `Every path between ${list(st.x)} and ${list(st.y)} is blocked given ${st.z.size ? list(st.z) : "nothing"}.`
          : `${MG.plural(nOpen, "open path")}${a.open.truncated ? " (first 200 shown)" : ""} connect${nOpen === 1 ? "s" : ""} them; shown in orange on the graph.`));
      const test = h("div", { class: "panel-section" },
        h("h3", null, "Testability"),
        a.testable
          ? h("div", null, h("div", { class: "stmt-row", style: { cursor: "default", padding: "4px 0" } },
              h("div", null, h("div", { class: "mono" }, a.recorded), h("div", { class: "muted", style: { fontSize: "12px", marginTop: "3px" } }, "Checkable on recorded data: proxies stand in for the variables, among records where they are observed.")),
              h("div", { class: "row-tools" }, h("span", { class: "tag testable" }, "testable"), h("button", { class: "row-btn", style: { opacity: 1 }, title: "Copy", "aria-label": "Copy recorded form", onClick: () => MG.ui.copyText(a.recorded) }, icon("copy")))))
          : h("div", { class: "muted" }, h("span", { class: "tag never" }, "not testable"), " ", a.whyNot, "."));
      const sections = [h("div", { class: "panel-section" }, verdict, h("div", { class: "form-row" },
        h("button", { class: "btn small", onClick: () => MG.ui.copyText(st.toString()) }, icon("copy"), "Copy"),
        h("button", { class: "btn small", onClick: () => this.app.view.fit(true, [...st.x, ...st.y, ...st.z]) }, icon("fit"), "Zoom to statement"),
        h("button", { class: "btn small", onClick: () => this.app.exporter.open("svg") }, icon("download"), "Export figure"),
        h("button", { class: "btn small", onClick: () => this.store.set({ statement: null }) }, "Clear"))), test];
      sections.push(this._compare());
      if (a.pair) sections.push(this._separators(graph, a));
      sections.push(this._paths(a));
      this.details.replaceChildren(...sections);
    }

    _compare() {
      const rows = this.store.compare();
      return h("div", { class: "panel-section" },
        h("h3", null, "Across models", h("span", { class: "aside" }, "click to switch")),
        h("div", { class: "compare" }, rows.map((r) =>
          h("button", { class: r.key === this.store.state.modelKey ? "is-current" : null, title: r.error || r.name, onClick: () => this.app.switchModel(r.key) },
            h("span", null, h("b", null, r.family || r.name), " ", h("span", { class: "faint" }, r.upstream === 1 ? "single" : r.upstream ? `${r.upstream} up` : "")),
            h("span", { class: ["res", r.implied === null ? "na" : r.implied ? "yes" : "no"] }, r.implied === null ? "n/a" : r.implied ? "implied" : "not")))));
    }

    _separators(graph, a) {
      const p = a.pair;
      const [x] = [...a.statement.x], [y] = [...a.statement.y];
      const setChip = (z, testable) => {
        const st = new MG.Statement([x], [y], z);
        const active = MG.setEq(z, a.statement.z);
        return h("button", { class: "chip", style: active ? { borderColor: "var(--accent)", background: "var(--accent-soft)" } : null, title: testable ? MG.Statement.recordedForm(graph, st) : st.toString(), onClick: () => this.app.showStatement(st.toString(), { stay: true }) },
          z.size ? MG.sorted(z).join(", ") : "∅ (marginal)", testable ? h("span", { class: "tag testable", style: { marginLeft: "4px", height: "16px" } }, "T") : null);
      };
      const extra = p.testable.filter((z) => !p.separators.some((s) => MG.setEq(s, z)));
      return h("div", { class: "panel-section" },
        h("h3", null, `Minimal sets separating ${x} and ${y}`),
        p.separators.length ? h("div", { class: "chip-row" }, p.separators.map((z) => setChip(z, p.isTestableSet(z)))) : h("p", { class: "muted", style: { margin: 0 } }, p.reason + "."),
        extra.length ? [h("div", { class: "muted", style: { fontSize: "12px", margin: "10px 0 5px" } }, "Testable forms (indicators added):"), h("div", { class: "chip-row" }, extra.map((z) => setChip(z, true)))] : null);
    }

    _paths(a) {
      const tab = this.store.transient.pathTab;
      const open = a.open;
      const blocked = tab === "blocked" ? a.blocked() : a._blocked;
      const list = tab === "open" ? open : blocked;
      const rows = list.paths.slice(0, 300).map((p) =>
        h("div", { class: ["path-row", p.open ? "open" : null],
            onMouseenter: () => this.store.setTransient({ focusPath: p }),
            onMouseleave: () => this.store.setTransient({ focusPath: null }) },
          h("span", { class: "len" }, String(p.path.length - 1)),
          h("span", { class: "p" }, MG.dsep.formatPath(p)),
          h("span", { class: "r" }, p.open ? "open" : p.reason)));
      const sub = h("div", { class: "subtabs" },
        h("button", { "aria-pressed": String(tab === "open"), onClick: () => this.store.setTransient({ pathTab: "open" }) }, `Open ${open.paths.length}${open.truncated ? "+" : ""}`),
        h("button", { "aria-pressed": String(tab === "blocked"), onClick: () => this.store.setTransient({ pathTab: "blocked" }) }, blocked ? `Blocked ${blocked.paths.length}${blocked.truncated ? "+" : ""}` : "Blocked"));
      return h("div", { class: "panel-section" },
        h("h3", null, "Paths", h("span", { class: "aside" }, "hover to trace on the graph")),
        sub,
        h("div", { style: { marginTop: "8px" } }, rows.length ? rows : h("p", { class: "muted", style: { margin: "4px 0" } }, tab === "open" ? "No open paths: the statement holds." : "No blocked paths up to length 9.")),
        tab === "blocked" && blocked && blocked.truncated ? h("p", { class: "faint", style: { fontSize: "12px" } }, "Blocked paths are listed up to length 9 and 400 paths.") : null);
    }

    _examples(graph) {
      const up = graph.ids.filter((n) => /^Yj\d*$/.test(n)).sort();
      const ex = [];
      if (graph.has("Yk") && up.length) ex.push(`Yk _||_ R_Yk | ${up.join(", ")}, S, W, T`);
      if (up.length) ex.push(`${up[0]} _||_ R_${up[0]} | S, W, T`);
      if (up.length > 1) ex.push(`${up[0]} _||_ R_${up[1]} | S, W, T, R_${up[0]}`);
      if (graph.has("Yk")) ex.push("Yk _||_ R_Yk | S, W, T");
      return h("div", { class: "empty" },
        h("p", null, "Type a statement above, use Pick to choose nodes on the graph, or start from one of these:"),
        h("div", { style: { display: "grid", gap: "4px" } }, ex.filter((t) => { try { MG.Statement.parse(t).check(graph); return true; } catch (e) { return false; } })
          .map((t) => h("button", { class: "chip", style: { justifyContent: "flex-start", height: "auto", padding: "6px 10px", borderRadius: "7px" }, onClick: () => this.app.showStatement(t) }, t))));
    }
  }

  function list(set) {
    return MG.sorted(set).join(", ");
  }

  MG.ui.QueryPanel = QueryPanel;
})(globalThis.MG);
