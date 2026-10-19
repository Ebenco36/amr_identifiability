/* Top bar: model switch, command box (find a node or check a statement), and actions. */
(function (MG) {
  "use strict";
  const { h, icon, iconButton } = MG.ui;

  class Toolbar {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this.switchEl = document.getElementById("model-switch");
      this.actionsEl = document.getElementById("actions");
      this.input = document.getElementById("command-input");
      this.suggest = document.getElementById("command-suggest");
      this.sub = document.getElementById("model-sub");
      this._sel = 0;
      this._buildActions();
      this._bindCommand();
      store.on((changed) => {
        if (["modelKey", "edits", "theme", "userOrder"].some((k) => changed.has(k)) || changed.has("t:editMode")) this.render();
        if (changed.has("statement") && document.activeElement !== this.input) this.input.value = store.state.statement || "";
      });
      this.render();
    }

    render() {
      const store = this.store;
      const cur = store.model;
      const key = store.state.modelKey;
      const picker = h("button", { type: "button", class: "graph-picker", "aria-haspopup": "true", title: "Open another graph, import your own, or start a new one", onClick: (e) => this._graphMenu(e.currentTarget) },
        h("span", { class: "graph-picker-name" }, store.graph().name), h("span", { class: "chev", "aria-hidden": "true" }, "▾"));
      const parts = [picker];
      if (store.isBuiltin(key) && cur.family) {
        const models = store.data.models;
        const families = [...new Set(models.map((m) => m.family))];
        const ups = [...new Set(models.filter((m) => m.family === cur.family).map((m) => m.upstream))].filter((u) => u != null);
        parts.push(h("div", { class: "segmented" }, families.map((f) =>
          h("button", { type: "button", "aria-pressed": String(cur.family === f), title: modelTitle(f), onClick: () => this.app.switchModel(this._find(f, cur.upstream)) }, f))));
        if (ups.length > 1) {
          const upSel = h("select", { class: "select", "aria-label": "Upstream antibiotics" },
            ups.sort((a, b) => b - a).map((u) => h("option", { value: u, selected: u === cur.upstream }, u === 1 ? "single upstream" : `${u} upstream`)));
          upSel.addEventListener("change", (e) => this.app.switchModel(this._find(cur.family, +e.target.value)));
          parts.push(upSel);
        }
      }
      this.switchEl.replaceChildren(...parts);
      const g = store.graph();
      this.sub.textContent = `${g.ids.length} nodes · ${g.edgeCount} edges${store.isEdited() ? " · edited" : ""}`;
      this.editBtn.setAttribute("aria-pressed", String(store.transient.editMode));
      this.undoBtn.disabled = !store.history.past.length;
      this.redoBtn.disabled = !store.history.future.length;
      const t = store.state.theme;
      this.themeBtn.replaceChildren(icon(t === "dark" ? "moon" : t === "light" ? "sun" : "auto"));
      this.themeBtn.title = `Theme: ${t === "auto" ? "follows system" : t}`;
    }

    /** The built-in model of a family (M1, M2, M3) with this many upstream drugs, or the nearest one. */
    _find(family, upstream) {
      const models = this.store.data.models.filter((m) => m.family === family);
      if (!models.length) return null;
      const exact = models.find((m) => m.upstream === upstream);
      if (exact) return exact.key;
      return models.slice().sort((a, b) => Math.abs((a.upstream ?? 0) - upstream) - Math.abs((b.upstream ?? 0) - upstream))[0].key;
    }

    /** The graph menu: every graph by group, with import, new and duplicate. */
    _graphMenu(anchor) {
      if (this._menuEl) return this._closeMenu();
      const store = this.store;
      const cur = store.state.modelKey;
      const loaded = new Map(store.listModels().map((m) => [m.key, m]));
      const item = (key, label, sub, fn, current) =>
        h("li", null, h("button", { type: "button", class: current ? "is-current" : null, onClick: () => { this._closeMenu(); fn(); } },
          h("span", { class: "menu-label" }, label), sub ? h("span", { class: "menu-desc" }, sub) : null));
      const groups = [];
      const builtins = store.data.models;
      if (builtins.length) groups.push(["AMR models", builtins.map((m) => item(m.key, store.graph(m.key).name, loaded.get(m.key).edited ? "edited" : "", () => this.app.switchModel(m.key), m.key === cur))]);
      const galleryGroups = [...new Set(MG.gallery.ENTRIES.map((e) => e.group))];
      for (const gname of galleryGroups)
        groups.push([gname, MG.gallery.ENTRIES.filter((e) => e.group === gname).map((e) =>
          item(e.key, e.name, loaded.has(e.key) && loaded.get(e.key).edited ? "edited" : "", () => this.app.openGallery(e.key), e.key === cur))]);
      const users = store.listModels().filter((m) => !m.builtin && m.source !== "gallery");
      if (users.length) groups.push(["Your graphs", users.map((m) => item(m.key, m.name, `${m.nodes.length} nodes`, () => this.app.switchModel(m.key), m.key === cur))]);
      const search = h("input", { class: "input", type: "search", placeholder: "Find a graph", "aria-label": "Find a graph", style: { width: "100%" } });
      const list = h("div", { class: "menu-scroll" }, groups.map(([title, items]) => h("div", { class: "menu-group" }, h("div", { class: "menu-heading" }, title), h("ul", null, items))));
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        for (const li of list.querySelectorAll("li")) li.hidden = !!q && !li.textContent.toLowerCase().includes(q);
        for (const g of list.querySelectorAll(".menu-group")) g.hidden = ![...g.querySelectorAll("li")].some((li) => !li.hidden);
      });
      const actions = h("div", { class: "menu-actions" },
        h("button", { type: "button", class: "btn small primary", onClick: () => { this._closeMenu(); this.app.importer.open(); } }, icon("download"), "Import a DAG"),
        h("button", { type: "button", class: "btn small", onClick: () => { this._closeMenu(); this.app.newGraph(); } }, icon("plus"), "New graph"),
        h("button", { type: "button", class: "btn small", onClick: () => { this._closeMenu(); this.app.duplicateGraph(); } }, icon("copy"), "Duplicate"),
        !store.isBuiltin() && store.model.source !== "gallery" ? h("button", { type: "button", class: "btn small", onClick: () => { this._closeMenu(); this.app.removeGraph(); } }, icon("close"), "Remove") : null);
      const menu = h("div", { class: "menu graph-menu", role: "menu" }, actions, search, list);
      const r = anchor.getBoundingClientRect();
      menu.style.top = r.bottom + 6 + "px";
      menu.style.left = Math.max(8, r.left) + "px";
      document.body.appendChild(menu);
      this._menuEl = menu;
      search.focus();
      this._bindMenuClose(anchor);
    }

    _buildActions() {
      this.editBtn = iconButton("edit", "Edit the graph (E)", { text: "Edit", onClick: () => this.app.toggleEdit() });
      this.undoBtn = iconButton("undo", "Undo edit (⌘Z)", { onClick: () => this.store.undo() });
      this.redoBtn = iconButton("redo", "Redo edit (⇧⌘Z)", { onClick: () => this.store.redo() });
      this.exportBtn = iconButton("download", "Export", { text: "Export", onClick: (e) => this._menu(e.currentTarget) });
      this.themeBtn = iconButton("auto", "Theme", { onClick: () => this.app.cycleTheme() });
      const help = iconButton("help", "Help and shortcuts (?)", { onClick: () => this.app.showHelp() });
      this.actionsEl.replaceChildren(this.editBtn, this.undoBtn, this.redoBtn, this.exportBtn, this.themeBtn, help);
    }

    _menu(anchor) {
      if (this._menuEl) return this._closeMenu();
      const ex = this.app.exporter;
      const item = (ext, label, desc, fn) => h("li", null, h("button", { type: "button", onClick: () => { this._closeMenu(); fn(); } }, h("span", { class: "menu-ext" }, ext), label, h("span", { class: "menu-desc" }, desc)));
      const menu = h("ul", { class: "menu", role: "menu" },
        item("SVG", "Figure", "vector", () => ex.open("svg")),
        item("PNG", "Image", "1–4×", () => ex.open("png")),
        item("PDF", "Document", "vector", () => ex.open("pdf")),
        item("HTML", "This explorer", "with state", () => ex.save("html")),
        h("hr"),
        item("CSV", "All conditions", "table", () => this.app.panels.conditions._csv(this.store.catalogue())),
        item("TXT", "DAGitty graph", "download", () => MG.ui.download(`${MG.ui.slug(this.store.graph().name)}.txt`, ex.dagitty(), "text/plain")),
        item("", "Copy DAGitty text", "clipboard", () => MG.ui.copyText(ex.dagitty())));
      const r = anchor.getBoundingClientRect();
      menu.style.top = r.bottom + 6 + "px";
      menu.style.right = Math.max(8, window.innerWidth - r.right) + "px";
      document.body.appendChild(menu);
      this._menuEl = menu;
      menu.querySelector("button").focus();
      this._bindMenuClose(anchor);
    }

    _bindMenuClose(anchor) {
      const menu = this._menuEl;
      this._outside = (e) => {
        if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) this._closeMenu();
      };
      this._esc = (e) => e.key === "Escape" && this._closeMenu();
      setTimeout(() => {
        document.addEventListener("pointerdown", this._outside);
        document.addEventListener("keydown", this._esc);
      });
    }

    _closeMenu() {
      if (!this._menuEl) return;
      this._menuEl.remove();
      this._menuEl = null;
      document.removeEventListener("pointerdown", this._outside);
      document.removeEventListener("keydown", this._esc);
    }

    // ---------------------------------------------------------------- command box

    _bindCommand() {
      const input = this.input;
      input.addEventListener("input", () => {
        input.classList.remove("is-error");
        this._sel = 0;
        this._renderSuggest();
      });
      input.addEventListener("focus", () => this._renderSuggest());
      input.addEventListener("blur", () => setTimeout(() => (this.suggest.hidden = true), 150));
      input.addEventListener("keydown", (e) => {
        const items = this._items || [];
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this._sel = Math.min(items.length - 1, this._sel + 1);
          this._renderSuggest(false);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this._sel = Math.max(0, this._sel - 1);
          this._renderSuggest(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          const it = items[this._sel];
          if (it) it.run();
          else if (input.value.trim()) input.classList.add("is-error");
        } else if (e.key === "Escape") {
          this.suggest.hidden = true;
          input.blur();
        }
      });
    }

    _renderSuggest(rebuild = true) {
      const text = this.input.value.trim();
      const graph = this.store.graph();
      if (rebuild) {
        const items = [];
        if (/_\|\|_|⊥|⫫/.test(text)) {
          let ok = null;
          try {
            MG.Statement.parse(text).check(graph);
            ok = true;
          } catch (err) {
            ok = err.message;
          }
          items.push({ label: ok === true ? "Check this statement" : `Can't check: ${ok}`, hint: "↵", run: () => { if (ok === true) { this.app.showStatement(text); this.input.blur(); } else this.input.classList.add("is-error"); } });
        } else if (text) {
          const q = text.toLowerCase();
          const nodes = graph.ids.filter((n) => n.toLowerCase().includes(q)).sort((a, b) => (a.toLowerCase().startsWith(q) ? 0 : 1) - (b.toLowerCase().startsWith(q) ? 0 : 1) || a.length - b.length || (a < b ? -1 : 1)).slice(0, 8);
          for (const n of nodes) items.push({ node: n, label: n, hint: graph.role(n), run: () => { this.app.selectNode(n, { center: true }); this.input.value = ""; this.input.blur(); } });
          const desc = graph.ids.filter((n) => !nodes.includes(n) && ((graph.meta.get(n) || {}).description || "").toLowerCase().includes(q)).slice(0, 5);
          for (const n of desc) items.push({ node: n, label: n, hint: graph.meta.get(n).description, run: () => { this.app.selectNode(n, { center: true }); this.input.value = ""; this.input.blur(); } });
        }
        this._items = items;
      }
      const items = this._items || [];
      if (!items.length || document.activeElement !== this.input) {
        this.suggest.hidden = true;
        return;
      }
      this.suggest.replaceChildren(...items.map((it, i) => {
        const li = h("li", { role: "option", "aria-selected": String(i === this._sel) },
          it.node ? MG.ui.roleGlyph(graph.role(it.node), 18, 11) : icon("query"),
          h("span", { class: it.node ? "mono" : null }, it.label), h("span", { class: "hint" }, it.hint));
        li.addEventListener("pointerdown", (e) => { e.preventDefault(); it.run(); });
        return li;
      }));
      this.suggest.hidden = false;
    }
  }

  function modelTitle(f) {
    return { M1: "M1: primary model", M2: "M2: unmeasured clinical selection (U_C)", M3: "M3: downstream self-masking (Yk -> R_Yk)" }[f] || f;
  }

  MG.ui.Toolbar = Toolbar;
})(globalThis.MG);
