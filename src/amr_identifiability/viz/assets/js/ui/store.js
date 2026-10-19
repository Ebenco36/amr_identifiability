/* MG.ui.Store: application state, derived data (graph, catalogue, analysis) and edit history.
 *
 * Graphs. The page ships with built-in models (data.models). Any graph the user opens, imports,
 * loads from the gallery or edits is kept as a full spec in state.custom[key]:
 *   {key, name, group?, description?, note?, source, edited?, nodes: [{id, latent, x, y, ...}], edges: [[a, b]]}
 * An edited built-in model has a custom spec under its own key; resetting removes it.
 * Specs are replaced, never mutated, so a spec object identifies one version of a graph.
 *
 * Persistent state (saved into an exported HTML file):
 *   modelKey, custom, userOrder, layout, node, statement, tab, filters, hiddenRoles, theme,
 *   recovery, panelWidth, buildOpen, view
 * Transient state (never saved): hover, pick slot, tool (select, arrow, common cause, erase) and
 * the edit mode it implies, focused path.
 */
(function (MG) {
  "use strict";

  const DEFAULTS = {
    modelKey: null,
    custom: {},
    userOrder: [],
    layout: {},
    node: null,
    statement: null,
    tab: "node",
    filters: { search: "", node: "", testableOnly: false, showNever: false, hideProxies: false, every: false },
    hiddenRoles: [],
    theme: "auto",
    missingQuery: null,
    causalQuery: null,
    panelWidth: 430,
    buildOpen: true,
    view: null,
  };

  const SAVED_KEYS = Object.keys(DEFAULTS);
  const GRAPH_KEYS = ["modelKey", "custom"];

  class Store {
    constructor(data, saved = {}) {
      this.data = data;
      this.builtins = new Map(data.models.map((m) => [m.key, m]));
      saved = migrate(saved || {}, this.builtins);
      this.state = {
        ...structuredClone(DEFAULTS),
        ...structuredClone(saved),
        filters: { ...DEFAULTS.filters, ...(saved.filters || {}) },
      };
      const first = data.defaultModel && this.builtins.has(data.defaultModel) ? data.defaultModel : data.models.length ? data.models[0].key : null;
      this._loadImports(data.imports || []);
      if (!this.spec(this.state.modelKey)) this.state.modelKey = first || this.state.userOrder[0] || this._loadFirstGallery();
      this.transient = { hoverNode: null, hoverEdge: null, focusPath: null, pick: null, tool: "select", editMode: false, editSource: null, edgeKind: "directed", pathTab: "open", emphasis: null, cut: null };
      this._listeners = new Set();
      this._graphs = new WeakMap();
      this._catalogues = new WeakMap();
      this._analysis = null;
      this.history = { past: [], future: [] };
    }

    /** Graphs given as text (DAGitty, edge list, ...) by the page's author. */
    _loadImports(imports) {
      imports.forEach((imp, i) => {
        const key = imp.key || `import-${i + 1}`;
        if (this.state.custom[key]) return;
        try {
          const { spec } = MG.parse.graphText(imp.text, { name: imp.name || `Graph ${i + 1}` });
          this.state.custom = { ...this.state.custom, [key]: { ...spec, key, source: "user" } };
          this.state.userOrder = [...this.state.userOrder, key];
          if (i === 0 && !this.state.modelKey) this.state.modelKey = key;
        } catch (e) {
          console.error(`could not read graph ${imp.name || key}: ${e.message}`);
        }
      });
    }

    _loadFirstGallery() {
      const spec = MG.gallery.load(MG.gallery.ENTRIES[0].key);
      this.state.custom = { ...this.state.custom, [spec.key]: spec };
      this.state.userOrder = [...this.state.userOrder, spec.key];
      return spec.key;
    }

    // ---------------------------------------------------------------- events

    on(fn) {
      this._listeners.add(fn);
      return () => this._listeners.delete(fn);
    }

    emit(changed) {
      for (const fn of this._listeners) fn(changed, this);
    }

    set(patch) {
      const changed = new Set(Object.keys(patch));
      Object.assign(this.state, patch);
      if (GRAPH_KEYS.some((k) => changed.has(k)) || changed.has("statement")) this._analysis = null;
      if (changed.has("custom")) changed.add("edits"); // panels listen for "edits" to mean "the graph changed"
      this.emit(changed);
    }

    setFilters(patch) {
      this.set({ filters: { ...this.state.filters, ...patch } });
    }

    setTransient(patch) {
      Object.assign(this.transient, patch);
      this.emit(new Set(["transient", ...Object.keys(patch).map((k) => "t:" + k)]));
    }

    // ---------------------------------------------------------------- models and graphs

    /** The spec of a graph: the user's version if there is one, else the built-in model. */
    spec(key = this.state.modelKey) {
      return (key && (this.state.custom[key] || this.builtins.get(key))) || null;
    }

    get model() {
      return this.spec();
    }

    /** Every graph that can be shown: built-ins first, then gallery and user graphs. */
    listModels() {
      const out = this.data.models.map((m) => ({ ...this.spec(m.key), key: m.key, builtin: true, edited: !!this.state.custom[m.key] }));
      for (const k of this.state.userOrder) if (this.state.custom[k] && !this.builtins.has(k)) out.push({ ...this.state.custom[k], builtin: false });
      return out;
    }

    isBuiltin(key = this.state.modelKey) {
      return this.builtins.has(key);
    }

    /** A built-in or gallery graph that differs from its original. */
    isEdited(key = this.state.modelKey) {
      const spec = this.state.custom[key];
      return !!spec && (this.builtins.has(key) || (spec.source === "gallery" && !!spec.edited));
    }

    graph(key = this.state.modelKey) {
      const spec = this.spec(key);
      if (!spec) throw new Error(`no graph ${key}`);
      if (!this._graphs.has(spec)) {
        const name = this.isEdited(key) && !/\(edited\)$/.test(spec.name) ? `${spec.name} (edited)` : spec.name;
        this._graphs.set(spec, MG.Graph.fromPayload({ ...spec, key, name }));
      }
      return this._graphs.get(spec);
    }

    catalogue(graph = this.graph()) {
      if (!this._catalogues.has(graph)) this._catalogues.set(graph, new MG.Catalogue(graph));
      return this._catalogues.get(graph);
    }

    positions(key = this.state.modelKey) {
      const spec = this.spec(key);
      const over = this.state.layout[key] || {};
      return new Map(spec.nodes.map((n) => [n.id, over[n.id] ? { x: over[n.id][0], y: over[n.id][1] } : { x: n.x, y: n.y }]));
    }

    moveNode(id, x, y, { silent = false } = {}) {
      const key = this.state.modelKey;
      const layout = { ...this.state.layout, [key]: { ...(this.state.layout[key] || {}), [id]: [Math.round(x * 10) / 10, Math.round(y * 10) / 10] } };
      if (silent) this.state.layout = layout;
      else this.set({ layout });
    }

    resetLayout() {
      const layout = { ...this.state.layout };
      delete layout[this.state.modelKey];
      this.set({ layout });
    }

    /** Lay the current graph out again automatically (keeps the result as the graph's layout). */
    autoLayout() {
      const spec = cloneSpec(this.spec());
      const pos = MG.layout.layered(spec.nodes.map((n) => n.id), spec.edges, { roleOf: (id) => this.graph().role(id) });
      const layout = { ...this.state.layout, [this.state.modelKey]: Object.fromEntries([...pos].map(([id, p]) => [id, [p.x, p.y]])) };
      this.set({ layout });
    }

    // ---------------------------------------------------------------- statement analysis

    analysis() {
      if (this._analysis) return this._analysis;
      const text = this.state.statement;
      if (!text) return (this._analysis = null);
      const graph = this.graph();
      const out = { text, statement: null, error: null };
      try {
        out.statement = MG.Statement.parse(text).check(graph);
      } catch (e) {
        out.error = e.message;
        return (this._analysis = out);
      }
      const st = out.statement;
      out.implied = MG.dsep.implies(graph, st);
      out.testable = MG.Statement.testable(graph, st);
      out.recorded = MG.Statement.recordedForm(graph, st);
      out.whyNot = MG.Statement.whyNotTestable(graph, st);
      out.open = { paths: [], truncated: false };
      if (!out.implied) {
        for (const a of MG.sorted(st.x)) for (const b of MG.sorted(st.y)) {
          const r = MG.dsep.paths(graph, a, b, st.z, { onlyOpen: true, maxPaths: 200 - out.open.paths.length });
          out.open.paths.push(...r.paths);
          out.open.truncated = out.open.truncated || r.truncated;
        }
        out.open.paths.sort((p, q) => p.path.length - q.path.length);
      }
      out.openEdges = edgeSet(out.open.paths);
      out._blocked = null;
      out.blocked = () => {
        if (!out._blocked) {
          const res = { paths: [], truncated: false };
          const cap = 400;
          for (const a of MG.sorted(st.x)) for (const b of MG.sorted(st.y)) {
            // iterative deepening, so the shortest blocked paths are always listed first
            let complete = [];
            for (let L = 1; L <= 9; L++) {
              const r = MG.dsep.paths(graph, a, b, st.z, { maxPaths: 50000, maxLength: L });
              const blocked = r.paths.filter((p) => !p.open);
              if (blocked.length + res.paths.length > cap || r.truncated) {
                const extra = blocked.filter((p) => p.path.length - 1 === L);
                complete = complete.concat(extra.slice(0, Math.max(0, cap - res.paths.length - complete.length)));
                res.truncated = true;
                break;
              }
              complete = blocked;
              if (L === 9) res.truncated = res.truncated || false;
            }
            res.paths.push(...complete);
          }
          res.paths.sort((p, q) => p.path.length - q.path.length);
          out._blocked = res;
        }
        return out._blocked;
      };
      if (st.x.size === 1 && st.y.size === 1) out.pair = this.catalogue(graph).pair([...st.x][0], [...st.y][0]);
      return (this._analysis = out);
    }

    /** The statement in every open graph that has all of its nodes, for the comparison grid. */
    compare() {
      const a = this.analysis();
      if (!a || !a.statement) return [];
      const out = [];
      for (const m of this.listModels()) {
        const g = this.graph(m.key);
        let implied = null, error = null;
        try {
          a.statement.check(g);
          implied = MG.dsep.implies(g, a.statement);
        } catch (e) {
          error = e.message;
        }
        if (implied === null && !m.builtin) continue;
        out.push({ key: m.key, name: g.name, family: m.family, upstream: m.upstream, implied, error });
      }
      return out;
    }

    // ---------------------------------------------------------------- opening graphs

    switchModel(key) {
      if (this.spec(key) && key !== this.state.modelKey) this.set({ modelKey: key });
    }

    /** Open a gallery entry (loading it the first time). */
    openGallery(key) {
      if (!this.state.custom[key]) {
        const spec = MG.gallery.load(key);
        this.set({ custom: { ...this.state.custom, [key]: spec }, userOrder: [...this.state.userOrder.filter((k) => k !== key), key], modelKey: key });
      } else this.set({ modelKey: key });
      return key;
    }

    /** Add a graph the user imported or drew; returns its key. */
    addUserGraph(spec) {
      let n = 1;
      while (this.state.custom[`user-${n}`]) n++;
      const key = `user-${n}`;
      const names = new Set(this.listModels().map((m) => m.name));
      let name = spec.name || `Graph ${n}`;
      for (let k = 2; names.has(name); k++) name = `${spec.name || "Graph"} (${k})`;
      const full = { ...cloneSpec(spec), key, name, source: spec.source || "user" };
      new MG.Graph({ nodes: full.nodes, edges: full.edges, latent: full.nodes.filter((x) => x.latent).map((x) => x.id) });
      this.set({ custom: { ...this.state.custom, [key]: full }, userOrder: [...this.state.userOrder, key], modelKey: key, node: null });
      return key;
    }

    duplicate(key = this.state.modelKey) {
      const spec = this.spec(key);
      return this.addUserGraph({ ...cloneSpec(spec), nodes: spec.nodes.map((n) => ({ ...n, ...(this.positions(key).get(n.id) || {}) })), name: `${spec.name} (copy)`, source: "user" });
    }

    removeModel(key = this.state.modelKey) {
      if (this.builtins.has(key)) return false;
      const custom = { ...this.state.custom };
      delete custom[key];
      const userOrder = this.state.userOrder.filter((k) => k !== key);
      const patch = { custom, userOrder };
      if (this.state.modelKey === key) patch.modelKey = this.data.models.length ? this.data.models[0].key : userOrder[0] || null;
      this.history = { past: this.history.past.filter((h) => h.key !== key), future: this.history.future.filter((h) => h.key !== key) };
      if (!patch.modelKey) {
        Object.assign(this.state, patch);
        patch.modelKey = this._loadFirstGallery();
        patch.custom = this.state.custom;
        patch.userOrder = this.state.userOrder;
      }
      this.set(patch);
      return true;
    }

    // ---------------------------------------------------------------- edits with undo

    /** Apply fn to a copy of the current spec; validate; record it for undo. */
    _edit(fn) {
      const key = this.state.modelKey;
      const before = this.state.custom[key];
      const next = cloneSpec(this.spec(key));
      next.key = key;
      // node moves made by dragging become part of the edited graph
      const over = this.state.layout[key] || {};
      for (const n of next.nodes) if (over[n.id]) [n.x, n.y] = over[n.id];
      const result = fn(next);
      if (result === false) return false;
      if (!this.builtins.has(key)) next.edited = true;
      try {
        new MG.Graph({ nodes: next.nodes, edges: next.edges, latent: next.nodes.filter((n) => n.latent).map((n) => n.id) });
      } catch (e) {
        MG.ui.toast(e.message, "error");
        return false;
      }
      this.history.past.push({ key, before, after: next });
      this.history.future = [];
      const layout = { ...this.state.layout };
      delete layout[key];
      this.set({ custom: { ...this.state.custom, [key]: next }, layout });
      return true;
    }

    addEdge(a, b) {
      if (a === b) return false;
      const problem = this.graph().edgeProblem(a, b);
      if (problem) return MG.ui.toast(problem, "error"), false;
      return this._edit((s) => void s.edges.push([a, b]));
    }

    removeEdge(a, b) {
      return this._edit((s) => {
        const src = s.nodes.find((n) => n.id === a);
        if (src && src.latent && src.bidirected) return void removeNode(s, a); // a <-> b goes as a whole
        s.edges = s.edges.filter(([p, q]) => !(p === a && q === b));
        // a latent node made for a bidirected edge goes when its last edge goes
        for (const n of s.nodes.filter((x) => x.latent && x.bidirected)) if (!s.edges.some((e) => e[0] === n.id)) removeNode(s, n.id);
      });
    }

    /** a <-> b: an unrecorded common cause, added as a latent node with edges to both. */
    addBidirected(a, b) {
      if (a === b) return false;
      const problem = this.graph().edgeProblem(a, b, "bidirected");
      if (problem) return MG.ui.toast(problem, "error"), false;
      return this._edit((s) => void pushBidirected(s, a, b));
    }

    /**
     * Add typed links in one undoable step: {nodes, edges, bidirected} as from MG.parse.links.
     * Names not in the graph become new nodes, placed next to the node they link to (or near
     * `near`, a point in graph coordinates). A link that breaks an m-graph rule is skipped and
     * reported. Returns {added: [text], created: [id], skipped: [[text, reason]]}.
     */
    addLinks({ nodes = [], edges = [], bidirected = [] }, { near = { x: 0, y: 0 } } = {}) {
      const report = { added: [], created: [], skipped: [] };
      const graphOf = (s) => new MG.Graph({ nodes: s.nodes, edges: s.edges, latent: s.nodes.filter((n) => n.latent).map((n) => n.id) });
      const ok = this._edit((s) => {
        const neighbourOf = new Map();
        for (const [a, b] of [...edges, ...bidirected]) {
          if (!neighbourOf.has(a)) neighbourOf.set(a, [b, +1]);
          if (!neighbourOf.has(b)) neighbourOf.set(b, [a, -1]);
        }
        let g = graphOf(s);
        // R_X or X_star for a variable X: make X partially observed (its indicator and proxy together)
        const base = (id) => (id.startsWith(MG.R_PREFIX) ? id.slice(MG.R_PREFIX.length) : id.endsWith(MG.PROXY_SUFFIX) ? id.slice(0, -MG.PROXY_SUFFIX.length) : null);
        const plain = nodes.filter((id) => !(base(id) && (g.has(base(id)) || nodes.includes(base(id)))));
        const partial = [...new Set(nodes.filter((id) => !plain.includes(id)).map(base))];
        for (const id of plain) {
          if (g.has(id)) continue;
          const problem = nameProblem(id, g);
          if (problem) {
            report.skipped.push([id, problem]);
            continue;
          }
          const [other, dir] = neighbourOf.get(id) || [null, 0];
          const anchor = other && s.nodes.find((n) => n.id === other);
          const start = anchor ? { x: anchor.x + 30 * dir, y: anchor.y + 90 * dir } : near;
          const at = MG.layout.freeSpot(s.nodes, start.x, start.y, { id });
          s.nodes.push({ id, latent: false, x: at.x, y: at.y });
          report.created.push(id);
          g = graphOf(s);
        }
        for (const v of partial) {
          if (!g.has(v) || g.partiallyObserved.has(v)) continue;
          if (g.latent.has(v)) {
            report.skipped.push([MG.R_PREFIX + v, `${v} is latent: it is never recorded, so it has no missingness indicator`]);
            continue;
          }
          const clash = [MG.R_PREFIX + v, v + MG.PROXY_SUFFIX].find((n) => g.has(n));
          if (clash) {
            report.skipped.push([clash, `${clash} exists but ${v} is not partially observed; rename it first`]);
            continue;
          }
          pushPartial(s, v);
          report.created.push(MG.R_PREFIX + v, v + MG.PROXY_SUFFIX);
          report.partial = [...(report.partial || []), v];
          g = graphOf(s);
        }
        const tryAdd = (a, b, kind) => {
          const text = kind === "bidirected" ? `${a} ↔ ${b}` : `${a} → ${b}`;
          const problem = g.edgeProblem(a, b, kind);
          if (problem) return void report.skipped.push([text, problem]);
          if (kind === "bidirected") pushBidirected(s, a, b);
          else s.edges.push([a, b]);
          g = graphOf(s);
          report.added.push(text);
        };
        for (const [a, b] of edges) tryAdd(a, b, "directed");
        for (const [a, b] of bidirected) tryAdd(a, b, "bidirected");
        if (!report.added.length && !report.created.length) return false;
      });
      report.ok = ok;
      return report;
    }

    toggleLatent(id) {
      return this._edit((s) => {
        const n = s.nodes.find((x) => x.id === id);
        n.latent = !n.latent;
      });
    }

    addNode(id, x, y, props = {}) {
      const check = nameProblem(id, this.graph());
      if (check) return MG.ui.toast(check, "error"), false;
      return this._edit((s) => void s.nodes.push({ id, latent: false, x, y, ...props }));
    }

    renameNode(from, to) {
      if (from === to) return false;
      const g = this.graph();
      const companions = g.partiallyObserved.has(from) ? [[MG.R_PREFIX + from, MG.R_PREFIX + to], [from + MG.PROXY_SUFFIX, to + MG.PROXY_SUFFIX]] : [];
      const all = [[from, to], ...companions];
      for (const [, t] of all) {
        const check = nameProblem(t, g, all.map(([f]) => f));
        if (check) return MG.ui.toast(check, "error"), false;
      }
      const map = new Map(all);
      const ok = this._edit((s) => {
        for (const n of s.nodes) if (map.has(n.id)) n.id = map.get(n.id);
        s.edges = s.edges.map(([a, b]) => [map.get(a) || a, map.get(b) || b]);
      });
      if (ok && this.state.node === from) this.set({ node: to });
      return ok;
    }

    deleteNode(id) {
      const g = this.graph();
      const extra = g.partiallyObserved.has(id) ? [MG.R_PREFIX + id, id + MG.PROXY_SUFFIX] : [];
      const ok = this._edit((s) => {
        for (const n of [id, ...extra]) removeNode(s, n);
        // a common cause drawn as a <-> edge goes with either of its two nodes
        for (const n of s.nodes.filter((x) => x.latent && x.bidirected)) if (s.edges.filter((e) => e[0] === n.id).length < 2) removeNode(s, n.id);
      });
      if (ok && this.state.node === id) this.set({ node: null });
      return ok;
    }

    /** Mark a variable as partially observed: add R_X and the proxy X_star (Equation 1). */
    makePartial(id) {
      const g = this.graph();
      if (g.partiallyObserved.has(id) || g.latent.has(id)) return false;
      const r = MG.R_PREFIX + id, star = id + MG.PROXY_SUFFIX;
      for (const n of [r, star]) if (g.has(n)) return MG.ui.toast(`${n} already exists`, "error"), false;
      return this._edit((s) => void pushPartial(s, id));
    }

    /** Make a partially observed variable fully observed: remove R_X, X_star and their edges. */
    makeFull(id) {
      if (!this.graph().partiallyObserved.has(id)) return false;
      return this._edit((s) => {
        removeNode(s, MG.R_PREFIX + id);
        removeNode(s, id + MG.PROXY_SUFFIX);
      });
    }

    setNodeFlag(id, flag, value) {
      return this._edit((s) => {
        const n = s.nodes.find((x) => x.id === id);
        n[flag] = value;
      });
    }

    /** Back to the built-in or gallery version of this graph. */
    resetModel() {
      const key = this.state.modelKey;
      if (!this.isEdited(key)) return false;
      const before = this.state.custom[key];
      const custom = { ...this.state.custom };
      let after;
      if (this.builtins.has(key)) delete custom[key];
      else if (before.source === "gallery") custom[key] = after = MG.gallery.load(key);
      else return false;
      this.history.past.push({ key, before, after });
      this.history.future = [];
      this.set({ custom });
      return true;
    }

    _restore(key, spec) {
      const custom = { ...this.state.custom };
      if (spec) custom[key] = spec;
      else delete custom[key];
      const userOrder = spec && !this.builtins.has(key) && !this.state.userOrder.includes(key) ? [...this.state.userOrder, key] : this.state.userOrder;
      this.set({ custom, userOrder, modelKey: key });
    }

    undo() {
      const step = this.history.past.pop();
      if (!step) return;
      this.history.future.push(step);
      this._restore(step.key, step.before);
    }

    redo() {
      const step = this.history.future.pop();
      if (!step) return;
      this.history.past.push(step);
      this._restore(step.key, step.after);
    }

    serialize() {
      const out = {};
      for (const k of SAVED_KEYS) out[k] = this.state[k];
      return out;
    }
  }

  function cloneSpec(spec) {
    return { ...spec, nodes: spec.nodes.map((n) => ({ ...n })), edges: spec.edges.map((e) => e.slice()) };
  }

  /** Equation (1): the indicator R_X and the proxy X_star, with X -> X_star <- R_X. */
  function pushPartial(s, id) {
    const r = MG.R_PREFIX + id, star = id + MG.PROXY_SUFFIX;
    const p = s.nodes.find((n) => n.id === id);
    const at1 = MG.layout.freeSpot(s.nodes, p.x + 80, p.y + 70, { id: r, roleOf: () => "missingness indicator" });
    s.nodes.push({ id: r, x: at1.x, y: at1.y, description: `missingness indicator of ${id} (1 = missing)` });
    const at2 = MG.layout.freeSpot(s.nodes, (p.x + at1.x) / 2, Math.max(p.y, at1.y) + 70, { id: star, roleOf: () => "recorded proxy" });
    s.nodes.push({ id: star, x: at2.x, y: at2.y, description: `recorded ${id}: equal to ${id} when ${r} = 0, missing otherwise` });
    s.edges.push([id, star], [r, star]);
  }

  /** a <-> b as a latent node with edges to both, placed above them. */
  function pushBidirected(s, a, b) {
    let id = `L_${a}_${b}`;
    for (let k = 2; s.nodes.some((n) => n.id === id); k++) id = `L_${a}_${b}_${k}`;
    const pa = s.nodes.find((n) => n.id === a), pb = s.nodes.find((n) => n.id === b);
    const at = MG.layout.freeSpot(s.nodes, (pa.x + pb.x) / 2, Math.min(pa.y, pb.y) - 60, { id, roleOf: () => "latent" });
    s.nodes.push({ id, latent: true, bidirected: [a, b], description: `unrecorded common cause of ${a} and ${b}`, x: at.x, y: at.y });
    s.edges.push([id, a], [id, b]);
    return id;
  }

  function removeNode(spec, id) {
    spec.nodes = spec.nodes.filter((n) => n.id !== id);
    spec.edges = spec.edges.filter(([a, b]) => a !== id && b !== id);
  }

  /** Why a name cannot be used, or null. */
  function nameProblem(id, graph, freed = []) {
    if (!id) return "a node needs a name";
    if (/[\s,|]/.test(id)) return "names cannot contain spaces, commas or |";
    if (/_\|\|_|⊥/.test(id)) return "that name looks like an independence statement";
    if (graph.has(id) && !freed.includes(id)) return `${id} already exists`;
    return null;
  }

  /** Older saved states stored edge edits instead of full specs. */
  function migrate(saved, builtins) {
    if (!saved.edits) return saved;
    const custom = { ...(saved.custom || {}) };
    for (const [key, e] of Object.entries(saved.edits)) {
      const base = builtins.get(key);
      if (!base || !(e.add.length || e.remove.length || e.latent.length || e.unlatent.length)) continue;
      const g = MG.Graph.fromPayload(base).with(e);
      custom[key] = { ...base, nodes: base.nodes.map((n) => ({ ...n, latent: g.latent.has(n.id) })), edges: g.edges };
    }
    const out = { ...saved, custom };
    delete out.edits;
    return out;
  }

  /** Directed edge keys used by a list of paths. */
  function edgeSet(paths) {
    const out = new Set();
    for (const p of paths)
      for (let i = 0; i < p.path.length - 1; i++) {
        const [u, v] = p.forward[i] ? [p.path[i], p.path[i + 1]] : [p.path[i + 1], p.path[i]];
        out.add(MG.scene.edgeKey(u, v));
      }
    return out;
  }

  MG.ui.Store = Store;
  MG.ui.cloneSpec = cloneSpec;
  MG.ui.nameProblem = nameProblem;
  MG.ui.edgeSet = edgeSet;
})(globalThis.MG);
