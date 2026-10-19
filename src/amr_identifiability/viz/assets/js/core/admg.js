/* MG.ADMG: acyclic directed mixed graphs and the latent projection of a DAG.
 *
 * The latent projection (Verma 1993; Tian & Pearl 2002) of a DAG over observed nodes O keeps
 *   a -> b   when a directed path a -> ... -> b has only latent intermediate nodes
 *   a <-> b  when some latent node reaches both a and b by directed paths through latent
 *            nodes only (an unrecorded common cause)
 * It has the same d-separations among O as the DAG, and it is the graph the theorems of
 * Mohan & Pearl (2021) and the ID algorithm (Shpitser & Pearl 2006) are stated on.
 */
(function (MG) {
  "use strict";

  const pk = (a, b) => (a < b ? a + "\u0001" + b : b + "\u0001" + a);

  class ADMG {
    /**
     * @param {string[]} nodes
     * @param {Array<[string,string]>} directed
     * @param {Array<[string,string]>} bidirected
     */
    constructor(nodes, directed = [], bidirected = []) {
      this.ids = MG.sorted(new Set(nodes));
      this._set = new Set(this.ids);
      this._pa = new Map(this.ids.map((n) => [n, new Set()]));
      this._ch = new Map(this.ids.map((n) => [n, new Set()]));
      this._sib = new Map(this.ids.map((n) => [n, new Set()]));
      for (const [a, b] of directed) {
        if (!this._set.has(a) || !this._set.has(b)) continue;
        this._ch.get(a).add(b);
        this._pa.get(b).add(a);
      }
      for (const [a, b] of bidirected) {
        if (!this._set.has(a) || !this._set.has(b) || a === b) continue;
        this._sib.get(a).add(b);
        this._sib.get(b).add(a);
      }
    }

    /** Latent projection of an MG.Graph onto its non-latent nodes (or onto `keep`). */
    static project(graph, keep = null) {
      const observed = new Set(keep ? keep : graph.ids.filter((n) => !graph.latent.has(n)));
      const hidden = (n) => !observed.has(n);
      const directed = [];
      for (const a of observed) {
        // directed paths from a through hidden nodes only
        const stack = [...graph.children(a)];
        const seen = new Set();
        while (stack.length) {
          const c = stack.pop();
          if (seen.has(c)) continue;
          seen.add(c);
          if (hidden(c)) stack.push(...graph.children(c));
          else directed.push([a, c]);
        }
      }
      const bidirected = [];
      for (const u of graph.ids) {
        if (!hidden(u)) continue;
        const reach = new Set();
        const stack = [...graph.children(u)];
        const seen = new Set();
        while (stack.length) {
          const c = stack.pop();
          if (seen.has(c)) continue;
          seen.add(c);
          if (hidden(c)) stack.push(...graph.children(c));
          else reach.add(c);
        }
        const r = MG.sorted(reach);
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) bidirected.push([r[i], r[j]]);
      }
      return new ADMG([...observed], directed, bidirected);
    }

    has(n) {
      return this._set.has(n);
    }

    parents(n) {
      return this._pa.get(n);
    }

    children(n) {
      return this._ch.get(n);
    }

    siblings(n) {
      return this._sib.get(n);
    }

    hasDirected(a, b) {
      return this._ch.has(a) && this._ch.get(a).has(b);
    }

    hasBidirected(a, b) {
      return this._sib.has(a) && this._sib.get(a).has(b);
    }

    /** Joined by any edge: a -> b, b -> a or a <-> b. */
    adjacent(a, b) {
      return this.hasDirected(a, b) || this.hasDirected(b, a) || this.hasBidirected(a, b);
    }

    get directedEdges() {
      const out = [];
      for (const a of this.ids) for (const b of MG.sorted(this._ch.get(a))) out.push([a, b]);
      return out;
    }

    get bidirectedEdges() {
      const out = [];
      for (const a of this.ids) for (const b of MG.sorted(this._sib.get(a))) if (a < b) out.push([a, b]);
      return out;
    }

    /** The nodes and their ancestors (directed edges only). */
    ancestors(nodes) {
      const out = new Set(nodes);
      const stack = [...out];
      while (stack.length) for (const p of this._pa.get(stack.pop())) if (!out.has(p)) {
        out.add(p);
        stack.push(p);
      }
      return out;
    }

    descendants(nodes) {
      const out = new Set(nodes);
      const stack = [...out];
      while (stack.length) for (const c of this._ch.get(stack.pop())) if (!out.has(c)) {
        out.add(c);
        stack.push(c);
      }
      return out;
    }

    /** Induced subgraph on S. */
    sub(S) {
      S = new Set(S);
      return new ADMG([...S], this.directedEdges.filter(([a, b]) => S.has(a) && S.has(b)), this.bidirectedEdges.filter(([a, b]) => S.has(a) && S.has(b)));
    }

    /** G with edges into X removed (both directed and bidirected): the graph after do(X). */
    withoutIncoming(X) {
      X = new Set(X);
      return new ADMG(this.ids, this.directedEdges.filter(([, b]) => !X.has(b)), this.bidirectedEdges.filter(([a, b]) => !X.has(a) && !X.has(b)));
    }

    /** G with directed edges out of X removed (used by Rule 2 of the do-calculus). */
    withoutOutgoing(X) {
      X = new Set(X);
      return new ADMG(this.ids, this.directedEdges.filter(([a]) => !X.has(a)), this.bidirectedEdges);
    }

    /** Districts (c-components): classes of nodes joined by bidirected paths. */
    districts() {
      const seen = new Set();
      const out = [];
      for (const n of this.ids) {
        if (seen.has(n)) continue;
        const comp = new Set([n]);
        const stack = [n];
        seen.add(n);
        while (stack.length) for (const s of this._sib.get(stack.pop())) if (!seen.has(s)) {
          seen.add(s);
          comp.add(s);
          stack.push(s);
        }
        out.push(comp);
      }
      return out;
    }

    /** A topological order of the directed part; ties broken by `rank` (lower first), then name. */
    topological(rank = null) {
      const indeg = new Map(this.ids.map((n) => [n, this._pa.get(n).size]));
      const ready = this.ids.filter((n) => !indeg.get(n));
      const out = [];
      const cmp = rank ? (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0) : undefined;
      while (ready.length) {
        ready.sort(cmp);
        const n = ready.shift();
        out.push(n);
        for (const c of this._ch.get(n)) {
          indeg.set(c, indeg.get(c) - 1);
          if (!indeg.get(c)) ready.push(c);
        }
      }
      return out;
    }

    /**
     * m-separation of X and Y given Z (the d-separation of mixed graphs), by converting to a
     * DAG with one latent node per bidirected edge and using MG.dsep.
     */
    separated(X, Y, Z = []) {
      const g = this.asDag();
      return MG.dsep.dSeparated(g, X, Y, Z);
    }

    asDag() {
      if (this._dag) return this._dag;
      const edges = this.directedEdges.slice();
      const nodes = this.ids.slice();
      const latent = [];
      for (const [a, b] of this.bidirectedEdges) {
        const u = `\u0000u_${a}_${b}`;
        nodes.push(u);
        latent.push(u);
        edges.push([u, a], [u, b]);
      }
      this._dag = new MG.Graph({ nodes, edges, latent });
      return this._dag;
    }

    /** Paths whose inner nodes are all colliders: a *-> c1 <-> c2 <-> ... <-* b, inner nodes in `allowed`. */
    colliderPaths(a, b, allowed, { maxLength = 12 } = {}) {
      // inner nodes must have arrowheads on both sides; an inner-inner step must therefore be <->
      const out = [];
      const into = (x, y) => this.hasDirected(x, y) || this.hasBidirected(x, y); // an edge with an arrowhead at y
      const first = [...this.ids].filter((c) => c !== a && c !== b && allowed.has(c) && into(a, c));
      const walk = (path) => {
        if (path.length > maxLength) return;
        const last = path[path.length - 1];
        if (into(b, last)) out.push([a, ...path, b]);
        for (const s of this._sib.get(last)) if (s !== a && s !== b && allowed.has(s) && !path.includes(s)) walk([...path, s]);
      };
      for (const c of first) walk([c]);
      return out;
    }

    toString() {
      return [...this.directedEdges.map(([a, b]) => `${a} -> ${b}`), ...this.bidirectedEdges.map(([a, b]) => `${a} <-> ${b}`)].join("\n");
    }
  }

  ADMG.pairKey = pk;
  MG.ADMG = ADMG;
})(globalThis.MG);
