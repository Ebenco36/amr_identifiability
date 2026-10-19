/* MG.Catalogue: every minimal conditional independence between recorded nodes.
 * Mirrors amr_identifiability.catalogue.ConditionCatalogue (the tests compare them).
 */
(function (MG) {
  "use strict";

  const pairKey = (a, b) => (a < b ? a + "\u0001" + b : b + "\u0001" + a);

  class Pair {
    constructor(x, y, adjacent, separators, testable, truncated) {
      this.x = x;
      this.y = y;
      this.adjacent = adjacent;
      this.separators = separators; // Array<Set>
      this.testable = testable; // Array<Set>
      this.truncated = truncated;
      this._testableKeys = new Set(testable.map(MG.setKey));
    }

    get separable() {
      return this.separators.length > 0;
    }

    get reason() {
      if (this.separators.length) return `${this.separators.length} minimal separating set(s)`;
      if (this.adjacent) return "adjacent: joined by an edge";
      return "no set of recorded nodes separates them";
    }

    isTestableSet(z) {
      return this._testableKeys.has(MG.setKey(z));
    }

    other(node) {
      return node === this.x ? this.y : this.x;
    }
  }

  /** X _||_ (non-descendants minus parents) | parents, or null when that set is empty. */
  function localMarkov(g, node) {
    const exclude = new Set([node, ...g.descendants(node), ...g.parents(node)]);
    const rest = g.ids.filter((n) => !exclude.has(n));
    return rest.length ? new MG.Statement([node], rest, g.parents(node)) : null;
  }

  class Catalogue {
    constructor(graph, { limit = null } = {}) {
      this.graph = graph;
      this.limit = limit;
      this.nodes = MG.sorted(graph.recorded);
      this._allowed = graph.recorded;
      this._testableAllowed = new Set([...graph.recorded].filter((n) => !graph.proxies.has(n)));
      this.pairs = [];
      this._byKey = new Map();
      for (let i = 0; i < this.nodes.length; i++)
        for (let j = i + 1; j < this.nodes.length; j++) {
          const p = this._build(this.nodes[i], this.nodes[j]);
          this.pairs.push(p);
          this._byKey.set(pairKey(p.x, p.y), p);
        }
    }

    _build(x, y) {
      const g = this.graph;
      if (g.adjacent(x, y)) return new Pair(x, y, true, [], [], false);
      const { separators, truncated } = MG.separators.minimalDSeparators(g, x, y, {
        allowed: this._allowed,
        limit: this.limit,
      });
      return new Pair(x, y, false, separators, this._testable(x, y), truncated);
    }

    _testable(x, y) {
      const g = this.graph;
      if (g.proxies.has(x) || g.proxies.has(y) || g.latent.has(x) || g.latent.has(y)) return [];
      const partial = g.partiallyObserved;
      const start = new Set([x, y].filter((v) => partial.has(v)).map((v) => MG.R_PREFIX + v));
      if (start.has(x) || start.has(y)) return [];
      const found = new Map();
      const queue = [start];
      const tried = new Set();
      while (queue.length) {
        const required = queue.pop();
        const rk = MG.setKey(required);
        if (tried.has(rk)) continue;
        tried.add(rk);
        const { separators } = MG.separators.minimalDSeparators(g, x, y, {
          included: required,
          allowed: this._testableAllowed,
          limit: this.limit,
        });
        for (const z of separators) {
          const needed = new Set([...z].filter((v) => partial.has(v)).map((v) => MG.R_PREFIX + v));
          if (MG.subset(needed, z)) found.set(MG.setKey(z), z);
          else if (!needed.has(x) && !needed.has(y)) queue.push(new Set([...required, ...needed]));
        }
      }
      const all = [...found.values()];
      return all.filter((z) => !all.some((o) => MG.properSubset(o, z))).sort(MG.compareSets);
    }

    pair(x, y) {
      return this._byKey.get(pairKey(x, y)) || null;
    }

    forNode(node) {
      return this.pairs.filter((p) => p.x === node || p.y === node).sort((a, b) => (a.other(node) < b.other(node) ? -1 : 1));
    }

    localMarkov(node) {
      return localMarkov(this.graph, node);
    }

    /** Flat rows, one per minimal statement (testable forms included when testableOnly). */
    rows({ testableOnly = false } = {}) {
      const out = [];
      for (const p of this.pairs) {
        const sets = testableOnly ? p.testable : p.separators;
        for (const z of sets) {
          const s = new MG.Statement([p.x], [p.y], z);
          const testable = p.isTestableSet(z);
          out.push({ pair: p, statement: s, testable, recorded: testable ? MG.Statement.recordedForm(this.graph, s) : null });
        }
      }
      return out;
    }

    summary() {
      let sep = 0, sets = 0, test = 0, adj = 0;
      for (const p of this.pairs) {
        if (p.separable) sep++;
        if (p.adjacent) adj++;
        sets += p.separators.length;
        test += p.testable.length;
      }
      return {
        nodes: this.nodes.length,
        pairs: this.pairs.length,
        separable: sep,
        sets,
        testable: test,
        adjacent: adj,
        inseparable: this.pairs.length - sep - adj,
      };
    }
  }

  MG.Catalogue = Catalogue;
  MG.localMarkov = localMarkov;
  MG.Catalogue.Pair = Pair;
})(globalThis.MG);
