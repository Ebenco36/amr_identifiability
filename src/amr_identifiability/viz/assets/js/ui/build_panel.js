/* MG.ui.BuildPanel: the left panel for building a graph.
 *
 *   Tools    Select, Arrow (X → Y), Common cause (X ↔ Y), Erase. Arrow and Common cause join nodes
 *            by dragging from one node to another anywhere on the canvas.
 *   Add      drag a kind of node onto the canvas, or onto a node (indicator, exposure, outcome).
 *   Link     type links ("W -> R_Y", "U <-> Y", "X -> {Y W}"); missing nodes are created and an
 *            indicator name makes its variable partially observed.
 *   Nodes    every node by role. Drag one onto another, here or on the canvas, to join them.
 *   Check    the m-graph rules of Mohan & Pearl (2021, Sec. 2.1) and the missingness class,
 *            recomputed after every edit.
 * Every edit goes through the store, so it can be undone and is checked by MG.Graph.edgeProblem.
 */
(function (MG) {
  "use strict";
  const { h, icon, iconButton, roleGlyph } = MG.ui;

  const TOOLS = [
    { id: "select", key: "V", label: "Select", icon: "pointer",
      hint: "Click a node to select it, drag to move it. Hover a node and drag its + handle onto another node to join them." },
    { id: "arrow", key: "A", label: "Arrow", icon: "link",
      hint: "Drag from a node onto another: X → Y, a direct cause. Or click two nodes. Drop on empty space to make a new node. Shift keeps the first node." },
    { id: "bidirected", key: "B", label: "Common cause", icon: "bidir",
      hint: "Drag between two nodes: X ↔ Y, an unrecorded common cause. It is added as a latent node with an arrow to each." },
    { id: "erase", key: "X", label: "Erase", icon: "erase",
      hint: "Click a node or an arrow to delete it. ⌘Z undoes." },
  ];

  const EXAMPLES = ["W -> R_Y", "Y -> R_Y", "U <-> Y"];

  class BuildPanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.el = document.getElementById("build");
      this.filter = "";
      // on a phone the panel starts folded, so the graph gets the screen
      if (matchMedia("(max-width: 880px)").matches) store.state.buildOpen = false;
      this._build();
      store.on((changed) => this._onChange(changed));
      this.render();
    }

    // ---------------------------------------------------------------- skeleton (built once)

    _build() {
      this.toggleBtn = iconButton("panel", "Hide the build panel", { class: "build-toggle", onClick: () => this.store.set({ buildOpen: !this.store.state.buildOpen }) });
      this.railEl = h("div", { class: "build-rail", role: "toolbar", "aria-label": "Tools" });
      this.toolsEl = h("div", { class: "tool-grid", role: "toolbar", "aria-label": "Tools" });
      this.toolHint = h("p", { class: "build-hint" });

      const add = h("div", { class: "build-add" });
      this.palette = new MG.ui.Palette(this.store, this.app, add);

      this.linkInput = h("textarea", { class: "input mono link-input", rows: 2, spellcheck: false, placeholder: "W -> R_Y\nU <-> Y", "aria-label": "Links to add" });
      this.linkInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this._addLinks();
        }
      });
      this.linkInput.addEventListener("input", () => this._previewLinks());
      this.linkPreview = h("div", { class: "link-preview" });
      const examples = h("div", { class: "link-examples" }, EXAMPLES.map((x) =>
        h("button", { type: "button", class: "chip mono", title: "Insert this example", onClick: () => this._insert(x) }, x)));
      const linkRow = h("div", { class: "link-row" }, this.linkInput,
        h("button", { type: "button", class: "btn small primary", title: "Add (Enter). Shift+Enter starts a new line.", onClick: () => this._addLinks() }, "Add"));

      this.searchEl = h("input", { class: "input", type: "search", placeholder: "Filter nodes", "aria-label": "Filter nodes" });
      this.searchEl.addEventListener("input", () => {
        this.filter = this.searchEl.value.trim().toLowerCase();
        this._renderNodes();
      });
      this.nodesEl = h("div", { class: "node-list", role: "list" });
      this.checkEl = h("div", { class: "build-check" });

      this.bodyEl = h("div", { class: "build-body" },
        section("Tools", "Keys V, A, B, X", "is-tools", this.toolsEl, this.toolHint),
        section("Add", "Drag onto the canvas, or onto a node. A click adds mid-view.", "is-add", add),
        section("Link", "Type links; Enter adds them all as one undoable step", "is-link", linkRow, this.linkPreview, examples),
        section("Nodes", "Drag one node onto another, here or on the canvas, to join them", "is-nodes", this.searchEl, this.nodesEl),
        section("Check", "Recomputed after every edit", "is-check", this.checkEl));
      this.el.replaceChildren(
        h("header", { class: "build-head" }, h("span", { class: "build-title" }, "Build"), this.toggleBtn),
        this.railEl, this.bodyEl);
    }

    // ---------------------------------------------------------------- rendering

    render() {
      const open = this.store.state.buildOpen;
      this.el.classList.toggle("is-collapsed", !open);
      document.getElementById("workspace").classList.toggle("build-collapsed", !open);
      this.toggleBtn.title = open ? "Hide the build panel" : "Show the build panel";
      this.toggleBtn.setAttribute("aria-label", this.toggleBtn.title);
      this.toggleBtn.setAttribute("aria-expanded", String(open));
      this._renderTools();
      this._renderNodes();
      this._renderCheck();
      this._previewLinks();
    }

    _onChange(changed) {
      if (changed.has("buildOpen")) {
        this.render();
        if (this.app.view) requestAnimationFrame(() => this.app.view._onResize());
        return;
      }
      if (changed.has("t:tool")) this._renderTools();
      if (changed.has("modelKey") || changed.has("edits")) {
        this._renderNodes();
        this._renderCheck();
        this._previewLinks();
      } else if (changed.has("node") || changed.has("t:hoverNode")) this._markNodes();
    }

    _renderTools() {
      const cur = this.store.transient.tool;
      const button = (t, labelled) => h("button", {
        type: "button", class: "tool", "aria-pressed": String(cur === t.id), title: `${t.label} (${t.key})`, "aria-label": `${t.label} (${t.key})`,
        onClick: () => this.app.setTool(t.id),
      }, icon(t.icon), labelled ? h("span", null, t.label) : null);
      this.toolHint.title = TOOLS.find((x) => x.id === cur).hint;
      this.toolsEl.replaceChildren(...TOOLS.map((t) => button(t, true)));
      this.railEl.replaceChildren(this.toggleBtnRail(), ...TOOLS.map((t) => button(t, false)));
      this.toolHint.textContent = TOOLS.find((t) => t.id === cur).hint;
    }

    toggleBtnRail() {
      return iconButton("panel", "Show the build panel", { class: "rail-open", onClick: () => this.store.set({ buildOpen: true }) });
    }

    _renderNodes() {
      const g = this.store.graph();
      const q = this.filter;
      const groups = MG.ROLES.map((role) => [role, g.ids.filter((id) => g.role(id) === role && (!q || id.toLowerCase().includes(q))).sort(byName)]).filter(([, ids]) => ids.length);
      this.rowEls = new Map();
      if (!g.ids.length) {
        this.nodesEl.replaceChildren(h("p", { class: "faint build-empty" }, "No nodes yet. Drag a Variable from Add, or type a link such as X -> Y."));
        return;
      }
      if (!groups.length) {
        this.nodesEl.replaceChildren(h("p", { class: "faint build-empty" }, `No node matches “${q}”.`));
        return;
      }
      this.nodesEl.replaceChildren(...groups.map(([role, ids]) =>
        h("div", { class: "node-group" },
          h("div", { class: "node-group-head" }, roleGlyph(role, 18, 11), h("span", null, role), h("span", { class: "count" }, String(ids.length))),
          ids.map((id) => this._row(g, id)))));
      this._markNodes();
    }

    _row(g, id) {
      const pa = g.parents(id).size, ch = g.children(id).size;
      const el = h("div", { class: "node-row", role: "listitem", tabindex: 0, "data-id": id, title: `${id}: drag onto another node to join them; click to select` },
        h("span", { class: "mono node-row-name" }, id),
        h("span", { class: "node-row-deg", title: `${pa} parents, ${ch} children` }, `${pa} in · ${ch} out`));
      el.addEventListener("pointerdown", (e) => this._dragStart(e, id));
      el.addEventListener("pointerenter", () => this.store.setTransient({ hoverNode: id }));
      el.addEventListener("pointerleave", () => this.store.transient.hoverNode === id && this.store.setTransient({ hoverNode: null }));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.app.selectNode(id, { center: true });
      });
      this.rowEls.set(id, el);
      return el;
    }

    _markNodes() {
      if (!this.rowEls) return;
      const sel = this.store.state.node, hover = this.store.transient.hoverNode;
      for (const [id, el] of this.rowEls) {
        el.classList.toggle("is-selected", id === sel);
        el.classList.toggle("is-hover", id === hover);
      }
    }

    _renderCheck() {
      const g = this.store.graph();
      const badges = [];
      const problems = g.validate();
      const badge = (cls, iconName, text, title) => h("span", { class: `badge-pill ${cls}`, title }, iconName ? icon(iconName) : null, h("span", null, text));
      if (problems.length) badges.push(badge("bad", "cross", `${MG.plural(problems.length, "rule")} broken`, problems.join("\n")));
      else badges.push(badge("ok", "check", "Valid m-graph", "Every proxy has exactly its variable and indicator as parents and no children; indicators point only at indicators or their own proxy; there are no cycles."));
      if (!problems.length && g.ids.length) {
        let c = null;
        try {
          c = MG.missing.classify(g);
        } catch (e) {
          c = null;
        }
        if (c && c.mechanism !== "complete") badges.push(badge(c.mechanism === "MNAR" ? "warn" : "ok", null, c.mechanism, c.text));
        const sm = g.selfMasking();
        const keys = Object.keys(sm);
        if (keys.length) badges.push(badge("warn", "target", `Self-masking: ${keys.join(", ")}`, keys.map((v) => `${v}: ${sm[v]}`).join("\n") + "\nTheorem 3: P(X) is then not recoverable from the graph alone."));
      }
      const problemList = problems.length ? h("ul", { class: "check-problems" }, problems.map((p) => h("li", null, p))) : null;
      this.checkEl.replaceChildren(...[h("div", { class: "badge-row" }, badges), problemList,
        h("div", { class: "check-foot" },
          h("span", { class: "faint", title: `${g.partiallyObserved.size} partially observed` }, `${g.ids.length} nodes · ${g.edgeCount} arrows`),
          g.partiallyObserved.size ? h("button", { type: "button", class: "link-btn", onClick: () => this.app.showTab("missing") }, "Missing data →") : null)].filter(Boolean));
    }

    // ---------------------------------------------------------------- typed links

    _insert(text) {
      const cur = this.linkInput.value.trim();
      this.linkInput.value = cur ? `${cur}\n${text}` : text;
      this.linkInput.focus();
      this._previewLinks();
    }

    _parse() {
      const text = this.linkInput.value;
      if (!text.trim()) return null;
      try {
        return { links: MG.parse.links(text) };
      } catch (e) {
        return { error: e.message };
      }
    }

    _previewLinks() {
      if (!this.linkPreview) return;
      const r = this._parse();
      this.linkInput.classList.toggle("is-error", !!(r && r.error));
      if (!r) return this.linkPreview.replaceChildren();
      if (r.error) return this.linkPreview.replaceChildren(h("span", { class: "link-bad" }, r.error));
      const g = this.store.graph();
      const fresh = r.links.nodes.filter((n) => !g.has(n));
      const n = r.links.edges.length + r.links.bidirected.length;
      this.linkPreview.replaceChildren(h("span", { class: "faint" },
        `${MG.plural(n, "link")}`, fresh.length ? `, ${MG.plural(fresh.length, "new node")}: ${fresh.join(", ")}` : "", " · Enter adds"));
    }

    _addLinks() {
      const r = this._parse();
      if (!r) return MG.ui.toast("Type a link first, such as W -> R_Y");
      if (r.error) return MG.ui.toast(r.error, "error");
      const near = this.app.view.toGraph(...this._viewCentre());
      const rep = this.store.addLinks(r.links, { near });
      const parts = [];
      if (rep.added.length) parts.push(`added ${rep.added.join(", ")}`);
      const madePartial = rep.partial || [];
      const plainNew = rep.created.filter((n) => !madePartial.some((v) => n === MG.R_PREFIX + v || n === v + MG.PROXY_SUFFIX));
      if (plainNew.length) parts.push(`new ${plainNew.length === 1 ? "node" : "nodes"} ${plainNew.join(", ")}`);
      if (madePartial.length) parts.push(`${madePartial.join(", ")} now partially observed`);
      const rows = [];
      if (parts.length) rows.push(h("div", { class: "link-good" }, icon("check"), h("span", null, parts.join("; "))));
      for (const [what, why] of rep.skipped) rows.push(h("div", { class: "link-bad" }, icon("cross"), h("span", null, h("span", { class: "mono" }, what), `: ${why}`)));
      this.linkPreview.replaceChildren(...rows);
      if (rep.ok) {
        this.linkInput.value = rep.skipped.length ? this.linkInput.value : "";
        MG.ui.toast(parts.join("; ") || "Done");
      } else if (rep.skipped.length) MG.ui.toast("Nothing added: see the reasons under the box", "error");
    }

    _viewCentre() {
      const r = this.app.view.svg.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }

    // ---------------------------------------------------------------- drag a node row to link

    _dragStart(e, id) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const sx = e.clientX, sy = e.clientY;
      let ghost = null;
      let target = null, problem = null;
      const kind = () => (this.store.transient.tool === "bidirected" ? "bidirected" : "directed");
      const label = (t) => (kind() === "bidirected" ? `${id} ↔ ${t || "?"}` : `${id} → ${t || "?"}`);
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          ghost = h("div", { class: "drag-ghost" }, label());
          document.body.appendChild(ghost);
          this.el.classList.add("is-dragging");
        }
        ghost.style.left = ev.clientX + 12 + "px";
        ghost.style.top = ev.clientY + 10 + "px";
        target = this._targetAt(ev.clientX, ev.clientY, id);
        problem = target ? this.store.graph().edgeProblem(id, target, kind()) : null;
        ghost.textContent = problem ? problem : label(target);
        ghost.classList.toggle("is-invalid", !!problem);
        this.app.view.setDropTarget(target, !!problem);
        for (const [rid, el] of this.rowEls) el.classList.toggle("is-drop-target", rid === target);
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
        this.el.classList.remove("is-dragging");
        this.app.view.setDropTarget(null);
        for (const el of this.rowEls.values()) el.classList.remove("is-drop-target");
        if (!ghost) return this.app.selectNode(id, { center: true });
        ghost.remove();
        if (!target) return;
        if (problem) return MG.ui.toast(problem, "error");
        this.app.connect(id, target, kind());
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
    }

    /** The node under a point: a canvas node or a row in the list (not the dragged node). */
    _targetAt(x, y, self) {
      const el = document.elementFromPoint(x, y);
      if (!el || !el.closest) return null;
      const n = el.closest(".graph .node") || el.closest(".node-row");
      const id = n ? n.dataset.id : null;
      return id && id !== self ? id : null;
    }
  }

  function section(title, sub, cls, ...children) {
    return h("section", { class: ["build-section", cls], "aria-label": title },
      h("div", { class: "build-section-head", title: sub || "" }, h("span", null, title), sub ? h("span", { class: "faint" }, sub) : null),
      children);
  }

  function byName(a, b) {
    return a.localeCompare(b, "en", { numeric: true });
  }

  MG.ui.BuildPanel = BuildPanel;
  MG.ui.TOOLS = TOOLS;
})(globalThis.MG);
