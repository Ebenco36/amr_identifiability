/* The explorer application: wires the store, graph view, panels, toolbar and exporter. */
(function (MG) {
  "use strict";
  const { h, icon, iconButton, roleGlyph } = MG.ui;
  const $ = (sel) => document.querySelector(sel);

  // the page as delivered, before any DOM changes: the base for "Export > HTML"
  MG.pristineHTML = "<!doctype html>\n" + document.documentElement.outerHTML;

  const TABS = [
    ["node", "Node", "The selected node, or the graph as a whole"],
    ["conditions", "Conditions", "Every minimal conditional independence the graph implies"],
    ["query", "Query", "Check one independence statement and see its paths"],
    ["missing", "Missing", "Missing data: MCAR / v-MAR / MNAR, recoverability, testability"],
    ["causal", "Causal", "Causal effects: ID algorithm, adjustment, front-door, Section 3.5"],
    ["docalc", "do-calc", "do-calculus practice: Rules 1–3 step by step"],
    ["compare", "Compare", "Compare two graphs (Section 4.3)"],
  ];

  class App {
    constructor() {
      const data = JSON.parse($("#mg-data").textContent);
      let saved = {};
      try {
        saved = JSON.parse($("#mg-state").textContent) || {};
      } catch (e) {
        saved = {};
      }
      if (!saved.theme) {
        try {
          saved.theme = localStorage.getItem("mg-theme") || "auto";
        } catch (e) {
          /* storage blocked: follow the system */
        }
      }
      const store = (this.store = new MG.ui.Store(data, saved));
      this.body = $("#panel-body");
      this.tabsEl = $("#tabs");
      this._applyTheme();
      this._applyPanelWidth();

      this.view = new MG.ui.GraphView($("#canvas"), store, {
        onNodeClick: (id, e) => this._nodeClick(id, e),
        onEdgeClick: (a, b) => this._edgeClick(a, b),
        onBackgroundClick: () => this._backgroundClick(),
        onBackgroundDblClick: (pt, e) => this._askNodeName(pt, e),
        onConnect: (a, b) => this.connect(a, b),
        onConnectToEmpty: (a, pt, e) => {
          const kind = this.store.transient.edgeKind;
          this._askNodeName(pt, e, (name) => this.connect(a, name, kind));
        },
      });
      this.build = new MG.ui.BuildPanel(store, this);
      this.view.onViewChange = () => this._status();
      this.panels = {
        node: new MG.ui.InspectorPanel(store, this),
        conditions: new MG.ui.ConditionsPanel(store, this),
        query: new MG.ui.QueryPanel(store, this),
        missing: new MG.ui.MissingPanel(store, this),
        causal: new MG.ui.CausalPanel(store, this),
        docalc: new MG.ui.DoCalcPanel(store, this),
        compare: new MG.ui.ComparePanel(store, this),
      };
      this.exporter = new MG.ui.Exporter(store, this);
      this.importer = new MG.ui.Importer(store, this);
      this.toolbar = new MG.ui.Toolbar(store, this);
      this._controls();
      this._splitter();
      store.on((changed) => this._onChange(changed));
      MG.ui.bindKeyboard(this);
      this._tabs();
      this._legend();
      this._banner();
      this._status();
      this.renderPanel();
    }

    // ---------------------------------------------------------------- navigation

    showTab(tab) {
      if (this.store.state.tab !== tab) this.store.set({ tab });
    }

    renderPanel() {
      if (!this.panels[this.store.state.tab]) this.store.state.tab = "node";
      const panel = this.panels[this.store.state.tab];
      panel.render(this.body);
    }

    selectNode(id, { center = false } = {}) {
      const st = this.store.state;
      if (st.tab === "conditions") this.store.set({ node: id, filters: { ...st.filters, node: id } });
      else this.store.set({ node: id, tab: "node" });
      if (center) this.view.centerOn(id);
    }

    showStatement(text, { stay = false } = {}) {
      this.store.set({ statement: text, ...(stay ? {} : { tab: "query" }) });
      this.store.setTransient({ focusPath: null });
    }

    queryFrom(id) {
      const cur = MG.Statement.parseLoose(this.store.state.statement || "");
      const st = new MG.Statement([id], [...cur.y].filter((n) => n !== id), [...cur.z].filter((n) => n !== id));
      this.store.set({ statement: st.toLooseString(), tab: "query" });
      if (!st.y.size) this.store.setTransient({ pick: "y" });
    }

    toggleInSlot(slot, n) {
      const cur = MG.Statement.parseLoose(this.store.state.statement || "");
      const had = cur[slot].has(n);
      for (const s of ["x", "y", "z"]) cur[s].delete(n);
      if (!had) cur[slot].add(n);
      const text = cur.toLooseString();
      this.store.set({ statement: text === "_||_" ? null : text });
    }

    switchModel(key) {
      if (!key || key === this.store.state.modelKey) return;
      this.store.setTransient({ editSource: null, focusPath: null, pick: null });
      this.store.switchModel(key);
      this._afterSwitch();
    }

    openGallery(key) {
      this.store.setTransient({ editSource: null, focusPath: null, pick: null });
      this.store.openGallery(key);
      this._afterSwitch();
      const spec = this.store.model;
      if (spec.note) MG.ui.toast("This graph has a note about the paper: see the Node tab", "");
    }

    /** Open a graph the user imported. */
    openSpec(spec) {
      this.store.addUserGraph(spec);
      this._afterSwitch();
      MG.ui.toast(`Opened ${this.store.graph().name}`);
    }

    newGraph() {
      this.store.addUserGraph({ name: "New graph", nodes: [], edges: [], source: "user" });
      this._afterSwitch();
      this.toggleEdit(true);
    }

    duplicateGraph() {
      this.store.duplicate();
      this._afterSwitch();
      MG.ui.toast(`Made ${this.store.graph().name}`);
    }

    removeGraph() {
      const name = this.store.graph().name;
      if (!window.confirm(`Remove "${name}" from this page? This cannot be undone.`)) return;
      this.store.removeModel();
      this._afterSwitch();
      MG.ui.toast(`Removed ${name}`);
    }

    /** After changing graph: drop selections that do not exist in the new graph. */
    _afterSwitch() {
      const g = this.store.graph();
      const patch = {};
      if (this.store.state.node && !g.has(this.store.state.node)) patch.node = null;
      if (this.store.state.statement) {
        const st = MG.Statement.parseLoose(this.store.state.statement);
        if (![...st.x, ...st.y, ...st.z].every((n) => g.has(n))) patch.statement = null;
      }
      if (this.store.state.filters.node && !g.has(this.store.state.filters.node)) patch.filters = { ...this.store.state.filters, node: "" };
      if (Object.keys(patch).length) this.store.set(patch);
    }

    /** Join two nodes: "directed" (a → b, a direct cause) or "bidirected" (a ↔ b, an unrecorded common cause). */
    connect(a, b, kind = this.store.transient.edgeKind) {
      if (a === b) return false;
      const bi = kind === "bidirected";
      const ok = bi ? this.store.addBidirected(a, b) : this.store.addEdge(a, b);
      if (ok) MG.ui.toast(bi ? `Added ${a} ↔ ${b} (an unrecorded common cause)` : `Added ${a} → ${b}`);
      return ok;
    }

    /** The canvas tool: "select", "arrow", "bidirected" or "erase". Every tool but Select edits. */
    setTool(tool) {
      if (!["select", "arrow", "bidirected", "erase"].includes(tool)) tool = "select";
      this.store.setTransient({ tool, editMode: tool !== "select", edgeKind: tool === "bidirected" ? "bidirected" : "directed", editSource: null, pick: null });
      this.view.clearGhost();
    }

    /** Ask for a new node's name at a canvas point; `after(name)` runs once it is added. */
    _askNodeName(pt, e, after = null) {
      const canvas = $("#canvas");
      const r = canvas.getBoundingClientRect();
      const box = h("div", { class: "node-namer", style: { left: e.clientX - r.left - 80 + "px", top: e.clientY - r.top - 18 + "px" } });
      const input = h("input", { class: "input mono", placeholder: "Node name", "aria-label": "New node name" });
      const hint = h("div", { class: "faint", style: { fontSize: "11px", marginTop: "3px" } }, "Enter to add · Esc to cancel");
      box.append(input, hint);
      canvas.appendChild(box);
      input.focus();
      const done = (ok) => {
        const name = input.value.trim();
        box.remove();
        if (ok && name && this.store.addNode(name, Math.round(pt.x), Math.round(pt.y))) {
          MG.ui.toast(`Added ${name}`);
          this.store.set({ node: name });
          if (after) after(name);
        }
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") done(true);
        if (ev.key === "Escape") {
          ev.stopPropagation();
          done(false);
        }
        const problem = MG.ui.nameProblem(input.value.trim(), this.store.graph());
        input.classList.toggle("is-error", !!problem && !!input.value.trim());
      });
      input.addEventListener("blur", () => setTimeout(() => box.isConnected && done(true), 120));
    }

    toggleEdit(on = !this.store.transient.editMode) {
      this.setTool(on ? (this.store.transient.edgeKind === "bidirected" ? "bidirected" : "arrow") : "select");
    }

    escape() {
      const tr = this.store.transient;
      if (tr.editSource) {
        this.store.setTransient({ editSource: null });
        this.view.clearGhost();
      } else if (tr.tool !== "select") this.setTool("select");
      else if (tr.pick) this.store.setTransient({ pick: null });
      else if (this.store.state.statement) this.store.set({ statement: null });
      else if (this.store.state.node) this.store.set({ node: null });
    }

    cycleTheme() {
      const order = ["auto", "light", "dark"];
      const theme = order[(order.indexOf(this.store.state.theme) + 1) % order.length];
      this.store.set({ theme });
      try {
        localStorage.setItem("mg-theme", theme);
      } catch (e) {
        /* storage blocked */
      }
    }

    showHelp() {
      const d = $("#help-dialog");
      d.replaceChildren(
        h("header", null, h("h2", null, "Using the explorer"), iconButton("close", "Close", { onClick: () => d.close() })),
        h("div", { class: "dialog-body" },
          h("p", { class: "muted", style: { margin: 0 } }, "Every independence shown is computed from the graph with d-separation, in this page, so it updates as soon as you edit the graph. The same algorithms run in the Python package, and the test suite checks that both give the same answers."),
          h("dl", { class: "shortcut-list" }, MG.ui.SHORTCUTS.map(([k, v]) => [h("dt", null, h("kbd", null, k)), h("dd", null, v)])),
          h("p", { class: "faint", style: { fontSize: "12px", margin: "4px 0 0" } }, `Generated ${this.store.data.generated || ""} by amr-identifiability ${this.store.data.version || ""}.`)),
        h("footer", null, h("button", { class: "btn primary", onClick: () => d.close() }, "Done")));
      d.showModal();
    }

    // ---------------------------------------------------------------- graph clicks

    _nodeClick(id, e) {
      const tr = this.store.transient;
      if (tr.tool === "erase") {
        const g = this.store.graph();
        const what = (g.meta.get(id) || {}).bidirected ? `the common cause ${id}` : g.partiallyObserved.has(id) ? `${id}, its indicator and proxy` : id;
        if (this.store.deleteNode(id)) MG.ui.toast(`Deleted ${what} (⌘Z undoes)`);
        return;
      }
      if (tr.editMode) {
        if (!tr.editSource) return this.store.setTransient({ editSource: id });
        if (tr.editSource === id) return this.store.setTransient({ editSource: null });
        this.connect(tr.editSource, id);
        this.store.setTransient({ editSource: e.shiftKey ? tr.editSource : null });
        if (!e.shiftKey) this.view.clearGhost();
        return;
      }
      if (tr.pick) return this.toggleInSlot(tr.pick, id);
      if (e.shiftKey && this.store.state.statement) return this.toggleInSlot("z", id);
      this.selectNode(id);
    }

    _edgeClick(a, b) {
      if (!this.store.transient.editMode) return;
      const meta = this.store.graph().meta.get(a) || {};
      const text = meta.bidirected ? `${meta.bidirected[0]} ↔ ${meta.bidirected[1]}` : `${a} → ${b}`;
      if (this.store.removeEdge(a, b)) MG.ui.toast(`Deleted ${text} (⌘Z undoes)`);
    }

    _backgroundClick() {
      const tr = this.store.transient;
      if (tr.editSource) {
        this.store.setTransient({ editSource: null });
        this.view.clearGhost();
      } else if (!tr.pick && !tr.editMode && this.store.state.node) this.store.set({ node: null });
    }

    // ---------------------------------------------------------------- reactions

    _onChange(changed) {
      if (changed.has("tab")) {
        if (!["causal", "docalc"].includes(this.store.state.tab) && (this.store.transient.emphasis || this.store.transient.cut)) queueMicrotask(() => this.store.setTransient({ emphasis: null, cut: null }));
        this.renderPanel();
        this.body.scrollTop = 0;
        this._tabs();
      } else {
        const panel = this.panels[this.store.state.tab];
        if (panel && panel.shouldRender(changed)) this.renderPanel();
      }
      if (changed.has("modelKey") || changed.has("edits")) this._tabs();
      if (["modelKey", "edits", "hiddenRoles", "statement", "filters"].some((k) => changed.has(k))) this._legend();
      if (["t:editMode", "t:tool", "t:pick", "t:editSource", "t:edgeKind", "modelKey", "edits"].some((k) => changed.has(k))) this._banner();
      if (changed.has("theme")) this._applyTheme();
      if (changed.has("panelWidth")) this._applyPanelWidth();
      if (changed.has("t:editMode") && this.store.state.tab === "node") this.renderPanel();
      this._status();
    }

    _tabs() {
      const cur = this.store.state.tab;
      const n = this.store.catalogue().summary().sets;
      this.tabsEl.replaceChildren(...TABS.map(([id, label, title]) =>
        h("button", { type: "button", role: "tab", title, "aria-selected": String(cur === id), onClick: () => this.showTab(id) },
          label, id === "conditions" ? h("span", { class: "tab-count" }, n.toLocaleString("en-US")) : null)));
    }

    _legend() {
      const graph = this.store.graph();
      const hidden = new Set(this.store.state.hiddenRoles);
      const items = MG.ROLES.map((role) => ({ role, n: graph.ids.filter((id) => graph.role(id) === role).length })).filter((r) => r.n);
      const el = $("#legend");
      el.replaceChildren(...items.map(({ role, n }) =>
        h("button", { type: "button", "aria-pressed": String(!hidden.has(role)), title: hidden.has(role) ? `Show ${role} nodes` : `Hide ${role} nodes`,
            onClick: () => {
              const next = new Set(this.store.state.hiddenRoles);
              next.has(role) ? next.delete(role) : next.add(role);
              this.store.set({ hiddenRoles: [...next] });
            } },
          roleGlyph(role), h("span", { class: "legend-label" }, role), h("span", { class: "count" }, String(n)))));
    }

    _banner() {
      const el = $("#canvas-banner");
      const tr = this.store.transient;
      if (tr.editMode) {
        const tool = MG.ui.TOOLS.find((x) => x.id === tr.tool) || MG.ui.TOOLS[1];
        const text = tr.editSource
          ? `From ${tr.editSource}: click the other node`
          : !this.store.graph().ids.length ? "Add a node from the Build panel, or double-click"
          : tr.tool === "erase" ? "Click a node or arrow to delete it" : "Drag from one node onto another";
        el.replaceChildren(...[
          h("span", { class: "banner-tool" }, icon(tool.icon), tool.label),
          h("span", null, text),
          h("button", { class: "btn small", onClick: () => { this.store.autoLayout(); this.view.fit(true); } }, "Tidy layout"),
          this.store.isEdited() && (this.store.isBuiltin() || this.store.model.source === "gallery") ? h("button", { class: "btn small", onClick: () => this.store.resetModel() }, "Reset") : null,
          h("button", { class: "btn small", title: "Back to Select (Esc)", onClick: () => this.setTool("select") }, "Done")].filter(Boolean));
        el.hidden = false;
      } else if (tr.pick) {
        el.replaceChildren(h("span", null, `Click nodes to add or remove them from ${tr.pick.toUpperCase()}.`), h("button", { class: "btn small", onClick: () => this.store.setTransient({ pick: null }) }, "Done"));
        el.hidden = false;
      } else el.hidden = true;
    }

    _status() {
      const el = $("#canvas-status");
      if (!el || !this.view) return;
      el.textContent = `${Math.round(this.view.view.k * 100)}%`;
    }

    _controls() {
      $("#canvas-controls").replaceChildren(
        iconButton("plus", "Zoom in (+)", { onClick: () => this.view.zoomBy(1.25) }),
        iconButton("minus", "Zoom out (−)", { onClick: () => this.view.zoomBy(0.8) }),
        iconButton("fit", "Fit to window (F)", { onClick: () => this.view.fit(true) }),
        iconButton("layout", "Restore the original layout", { onClick: () => { this.store.resetLayout(); this.view.fit(true); } }));
    }

    _splitter() {
      const sp = $("#splitter");
      let start = null;
      sp.addEventListener("pointerdown", (e) => {
        start = { x: e.clientX, w: this.store.state.panelWidth };
        sp.setPointerCapture(e.pointerId);
        sp.classList.add("is-active");
      });
      sp.addEventListener("pointermove", (e) => {
        if (!start) return;
        const w = MG.clamp(start.w - (e.clientX - start.x), 320, Math.max(340, window.innerWidth * 0.7));
        this.store.state.panelWidth = Math.round(w);
        this._applyPanelWidth();
      });
      const end = () => {
        if (!start) return;
        start = null;
        sp.classList.remove("is-active");
        this.store.set({ panelWidth: this.store.state.panelWidth });
      };
      sp.addEventListener("pointerup", end);
      sp.addEventListener("pointercancel", end);
      sp.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") this.store.set({ panelWidth: Math.min(window.innerWidth * 0.7, this.store.state.panelWidth + 24) });
        if (e.key === "ArrowRight") this.store.set({ panelWidth: Math.max(320, this.store.state.panelWidth - 24) });
      });
    }

    _applyPanelWidth() {
      document.documentElement.style.setProperty("--panel-width", this.store.state.panelWidth + "px");
    }

    _applyTheme() {
      const t = this.store.state.theme;
      if (t === "auto") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t;
      if (this.toolbar) this.toolbar.render();
    }
  }

  function boot() {
    try {
      MG.app = new App();
    } catch (e) {
      console.error(e);
      document.body.prepend(h("div", { style: { padding: "16px", background: "#fbe8df", color: "#7a1f00", font: "13px system-ui" } }, `The explorer could not start: ${e.message}`));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(globalThis.MG);
