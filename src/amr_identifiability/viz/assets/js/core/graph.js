/* MG.Graph: an m-graph with node roles, mirroring amr_identifiability.mgraph.MGraph.
 *
 *   X        substantive variable
 *   R_X      missingness indicator (0 observed, 1 missing)
 *   X_star   recorded proxy
 *
 * A non-latent node with both R_X and X_star present is partially observed.
 */
(function (MG) {
  "use strict";

  const ROLES = ["fully observed", "partially observed", "missingness indicator", "recorded proxy", "latent"];

  class Graph {
    /**
     * @param {object} spec
     * @param {Array<string|{id:string}>} spec.nodes
     * @param {Array<[string,string]>} spec.edges
     * @param {Iterable<string>} [spec.latent]
     * @param {string} [spec.name]
     */
    constructor({ nodes = [], edges = [], latent = [], name = "", key = "" }) {
      this.name = name;
      this.key = key;
      this.ids = [];
      this.meta = new Map();
      this._par = new Map();
      this._ch = new Map();
      for (const n of nodes) this._addNode(typeof n === "string" ? { id: n } : n);
      for (const [a, b] of edges) {
        if (a === b) throw new Error(`self-loop on ${a}`);
        this._addNode({ id: a });
        this._addNode({ id: b });
        this._ch.get(a).add(b);
        this._par.get(b).add(a);
      }
      this.latent = new Set(latent);
      for (const l of this.latent) if (!this.meta.has(l)) throw new Error(`latent node not in the graph: ${l}`);
      const cycle = this._findCycle();
      if (cycle) throw new Error(`graph has a cycle: ${cycle.join(" -> ")}`);
      this._cache = new Map();
      this._roles();
    }

    _addNode(m) {
      if (this.meta.has(m.id)) return;
      this.ids.push(m.id);
      this.meta.set(m.id, { ...m });
      this._par.set(m.id, new Set());
      this._ch.set(m.id, new Set());
    }

    _findCycle() {
      const state = new Map();
      const stack = [];
      const visit = (n) => {
        state.set(n, 1);
        stack.push(n);
        for (const c of this._ch.get(n)) {
          if (state.get(c) === 1) return stack.slice(stack.indexOf(c)).concat(c);
          if (!state.has(c)) {
            const found = visit(c);
            if (found) return found;
          }
        }
        stack.pop();
        state.set(n, 2);
        return null;
      };
      for (const n of this.ids) if (!state.has(n)) {
        const found = visit(n);
        if (found) return found;
      }
      return null;
    }

    _roles() {
      const has = (n) => this.meta.has(n);
      this.partiallyObserved = new Set(
        this.ids.filter((n) => !this.latent.has(n) && has(MG.R_PREFIX + n) && has(n + MG.PROXY_SUFFIX))
      );
      this.indicators = new Set([...this.partiallyObserved].map((v) => MG.R_PREFIX + v));
      this.proxies = new Set([...this.partiallyObserved].map((v) => v + MG.PROXY_SUFFIX));
      this.fullyObserved = new Set(
        this.ids.filter(
          (n) => !this.latent.has(n) && !this.partiallyObserved.has(n) && !this.indicators.has(n) && !this.proxies.has(n)
        )
      );
      this.recorded = new Set(this.ids.filter((n) => !this.latent.has(n)));
    }

    static fromPayload(model) {
      return new Graph({
        nodes: model.nodes,
        edges: model.edges,
        latent: model.nodes.filter((n) => n.latent).map((n) => n.id),
        name: model.name,
        key: model.key,
      });
    }

    get nodes() {
      return this.ids.slice();
    }

    get edges() {
      const out = [];
      for (const a of this.ids) for (const b of this._ch.get(a)) out.push([a, b]);
      return out;
    }

    get edgeCount() {
      let n = 0;
      for (const s of this._ch.values()) n += s.size;
      return n;
    }

    has(n) {
      return this.meta.has(n);
    }

    require(nodes) {
      const unknown = [...nodes].filter((n) => !this.meta.has(n));
      if (unknown.length) throw new Error(`not in the graph: ${MG.sorted(unknown).join(", ")}`);
    }

    parents(n) {
      return this._par.get(n);
    }

    children(n) {
      return this._ch.get(n);
    }

    hasEdge(a, b) {
      return this._ch.has(a) && this._ch.get(a).has(b);
    }

    adjacent(a, b) {
      return this.hasEdge(a, b) || this.hasEdge(b, a);
    }

    neighbours(n) {
      return new Set([...this._par.get(n), ...this._ch.get(n)]);
    }

    _walk(start, next) {
      const out = new Set();
      const stack = [start];
      while (stack.length) for (const m of next(stack.pop())) if (!out.has(m)) {
        out.add(m);
        stack.push(m);
      }
      out.delete(start);
      return out;
    }

    ancestors(n) {
      const k = "a:" + n;
      if (!this._cache.has(k)) this._cache.set(k, this._walk(n, (v) => this._par.get(v)));
      return this._cache.get(k);
    }

    descendants(n) {
      const k = "d:" + n;
      if (!this._cache.has(k)) this._cache.set(k, this._walk(n, (v) => this._ch.get(v)));
      return this._cache.get(k);
    }

    /** The nodes and all their ancestors. */
    ancestralClosure(nodes) {
      const out = new Set(nodes);
      for (const n of nodes) for (const a of this.ancestors(n)) out.add(a);
      return out;
    }

    role(n) {
      if (this.latent.has(n)) return "latent";
      if (this.partiallyObserved.has(n)) return "partially observed";
      if (this.indicators.has(n)) return "missingness indicator";
      if (this.proxies.has(n)) return "recorded proxy";
      return "fully observed";
    }

    wouldCreateCycle(a, b) {
      return a === b || this.descendants(b).has(a);
    }

    /**
     * Why a -> b (kind "directed") or a <-> b (kind "bidirected") cannot be added, or null.
     * The m-graph rules of Mohan & Pearl (2021, Sec. 2.1): a proxy X_star has exactly the parents
     * X and R_X and no children; a missingness indicator R_X may point only at its proxy or at
     * another indicator (R -> R); and the graph stays acyclic.
     */
    edgeProblem(a, b, kind = "directed") {
      const unknown = [a, b].filter((n) => !this.has(n));
      if (unknown.length) return `not in the graph: ${unknown.join(", ")}`;
      if (a === b) return kind === "bidirected" ? "a common cause needs two different nodes" : `${a} cannot cause itself`;
      for (const n of [a, b])
        if (this.proxies.has(n)) {
          const v = n.slice(0, -MG.PROXY_SUFFIX.length);
          return `${n} is a recorded proxy: its only parents are ${v} and ${MG.R_PREFIX + v}, and it has no children`;
        }
      if (kind === "bidirected") {
        const shared = this.ids.some((l) => this.latent.has(l) && this._ch.get(l).size === 2 && this._ch.get(l).has(a) && this._ch.get(l).has(b) && !this._par.get(l).size);
        return shared ? `${a} and ${b} already share an unrecorded common cause` : null;
      }
      if (this.hasEdge(a, b)) return `${a} → ${b} is already in the graph`;
      if (this.indicators.has(a) && !this.indicators.has(b))
        return `${a} is a missingness indicator: in an m-graph it can point only at another indicator (R → R) or at its own proxy`;
      if (this.wouldCreateCycle(a, b)) return `${a} → ${b} would close a cycle: ${b} already reaches ${a}`;
      return null;
    }

    /** A new graph with edits applied; this graph is unchanged. */
    with({ add = [], remove = [], latent = [], unlatent = [], name, key } = {}) {
      const removeKeys = new Set(remove.map(([a, b]) => a + "\u0001" + b));
      const edges = this.edges.filter(([a, b]) => !removeKeys.has(a + "\u0001" + b));
      const seen = new Set(edges.map(([a, b]) => a + "\u0001" + b));
      for (const [a, b] of add) if (!seen.has(a + "\u0001" + b)) {
        edges.push([a, b]);
        seen.add(a + "\u0001" + b);
      }
      const lat = new Set([...this.latent, ...latent]);
      for (const n of unlatent) lat.delete(n);
      return new Graph({
        nodes: this.ids.map((id) => this.meta.get(id)),
        edges,
        latent: lat,
        name: name || this.name,
        key: key || this.key,
      });
    }

    // ------------------------------------------------------------- missing-data structure

    /** Pairs of non-latent nodes with a common latent ancestor reached through latent nodes only. */
    latentLinks() {
      const links = new Set();
      for (const u of this.latent) {
        const reached = new Set();
        const seen = new Set([u]);
        const stack = [u];
        while (stack.length) for (const c of this._ch.get(stack.pop())) {
          if (this.latent.has(c)) {
            if (!seen.has(c)) {
              seen.add(c);
              stack.push(c);
            }
          } else reached.add(c);
        }
        const r = MG.sorted(reached);
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) links.add(r[i] + "\u0001" + r[j]);
      }
      return links;
    }

    latentLinked(a, b) {
      const [p, q] = MG.sorted([a, b]);
      return this.latentLinks().has(p + "\u0001" + q);
    }

    latentDirected(source, target) {
      const stack = [source];
      const seen = new Set([source]);
      while (stack.length) for (const c of this._ch.get(stack.pop())) {
        if (c === target) return true;
        if (this.latent.has(c) && !seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
      return false;
    }

    /** {variable: reason} for variables whose value can drive their own missingness. */
    selfMasking() {
      const links = this.latentLinks();
      const out = {};
      for (const v of MG.sorted(this.partiallyObserved)) {
        const r = MG.R_PREFIX + v;
        const [p, q] = MG.sorted([v, r]);
        if (this.hasEdge(v, r)) out[v] = `direct edge ${v} -> ${r}`;
        else if (this.latentDirected(v, r)) out[v] = `${v} reaches ${r} through latent nodes only`;
        else if (links.has(p + "\u0001" + q)) out[v] = `${v} and ${r} share an unrecorded cause`;
      }
      return out;
    }

    /** Structural problems as an m-graph; mirrors MGraph.validate. */
    validate() {
      const problems = [];
      for (const v of MG.sorted(this.partiallyObserved)) {
        const r = MG.R_PREFIX + v, star = v + MG.PROXY_SUFFIX;
        const ps = this.parents(star);
        if (!(ps.size === 2 && ps.has(v) && ps.has(r)))
          problems.push(`${star} must have exactly the parents ${v} and ${r}; has ${MG.sorted(ps).join(", ") || "none"}`);
        if (this.children(star).size) problems.push(`${star} is a proxy and must have no children`);
        for (const c of MG.sorted(this.children(r)))
          if (c !== star && !this.indicators.has(c))
            problems.push(`${r} is a missingness indicator; its child ${c} is neither its proxy nor an indicator`);
      }
      for (const n of MG.sorted(this.ids)) {
        if (n.startsWith(MG.R_PREFIX) && !this.indicators.has(n))
          problems.push(`${n} looks like an indicator but ${n.slice(2)} has no proxy or is latent`);
        if (n.endsWith(MG.PROXY_SUFFIX) && !this.proxies.has(n))
          problems.push(`${n} looks like a proxy but ${n.slice(0, -5)} has no indicator or is latent`);
      }
      return problems;
    }
  }

  MG.ROLES = ROLES;
  MG.Graph = Graph;
})(globalThis.MG);
