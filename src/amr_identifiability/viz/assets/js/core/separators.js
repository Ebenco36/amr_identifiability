/* Every minimal d-separating set between two nodes; mirrors amr_identifiability.separators.
 *
 * Minimal separators lie in the ancestral set An(x, y, required) and there equal vertex
 * separators of the moral graph. Required nodes are removed, nodes that may not be
 * conditioned on are eliminated (their neighbours joined), and the minimal x-y vertex
 * separators are listed with the close-separator algorithm (Berry, Bordat & Cogis 1999).
 */
(function (MG) {
  "use strict";

  function moralGraph(graph, nodes) {
    const adj = new Map();
    for (const n of nodes) adj.set(n, new Set());
    for (const child of nodes) {
      const parents = [...graph.parents(child)].filter((p) => nodes.has(p));
      for (const p of parents) {
        adj.get(p).add(child);
        adj.get(child).add(p);
      }
      for (let i = 0; i < parents.length; i++)
        for (let j = i + 1; j < parents.length; j++) {
          adj.get(parents[i]).add(parents[j]);
          adj.get(parents[j]).add(parents[i]);
        }
    }
    return adj;
  }

  function eliminate(adj, nodes) {
    const gone = new Set([...nodes].filter((n) => adj.has(n)));
    const out = new Map();
    for (const [n, nb] of adj) if (!gone.has(n)) out.set(n, new Set([...nb].filter((m) => !gone.has(m))));
    const seen = new Set();
    for (const start of gone) {
      if (seen.has(start)) continue;
      const group = new Set([start]);
      const border = new Set();
      const stack = [start];
      while (stack.length) for (const m of adj.get(stack.pop())) {
        if (gone.has(m)) {
          if (!group.has(m)) {
            group.add(m);
            stack.push(m);
          }
        } else border.add(m);
      }
      for (const g of group) seen.add(g);
      for (const m of border) for (const o of border) if (o !== m) out.get(m).add(o);
    }
    return out;
  }

  function component(adj, start, removed) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const m of adj.get(stack.pop())) if (!removed.has(m) && !seen.has(m)) {
      seen.add(m);
      stack.push(m);
    }
    return seen;
  }

  function border(adj, comp) {
    const out = new Set();
    for (const n of comp) for (const m of adj.get(n)) if (!comp.has(m)) out.add(m);
    return out;
  }

  function minimalVertexSeparators(adj, a, b, limit = null) {
    if (adj.get(a).has(b)) return { separators: [], truncated: false };
    if (!component(adj, a, new Set()).has(b)) return { separators: [new Set()], truncated: false };
    const first = border(adj, component(adj, b, new Set([...adj.get(a), a])));
    const seen = new Set([MG.setKey(first)]);
    const queue = [first];
    const out = [];
    let head = 0;
    while (head < queue.length) {
      const sep = queue[head++];
      out.push(sep);
      if (limit !== null && out.length >= limit) return { separators: out.sort(MG.compareSets), truncated: head < queue.length };
      for (const x of sep) {
        if (adj.get(x).has(b)) continue;
        const nxt = border(adj, component(adj, b, new Set([...sep, ...adj.get(x)])));
        const k = MG.setKey(nxt);
        if (!seen.has(k)) {
          seen.add(k);
          queue.push(nxt);
        }
      }
    }
    return { separators: out.sort(MG.compareSets), truncated: false };
  }

  /** Every minimal d-separator Z of x and y with included <= Z <= included | allowed. */
  function minimalDSeparators(graph, x, y, { included = [], allowed = null, limit = null } = {}) {
    included = new Set(included);
    if (x === y) throw new Error("x and y must differ");
    if (included.has(x) || included.has(y)) throw new Error("x and y cannot be in the conditioning set");
    allowed = allowed === null ? new Set(graph.ids) : new Set(allowed);
    const anc = graph.ancestralClosure(new Set([x, y, ...included]));
    const moral = moralGraph(graph, anc);
    let adj = new Map();
    for (const [n, nb] of moral) if (!included.has(n)) adj.set(n, new Set([...nb].filter((m) => !included.has(m))));
    const forbidden = [...adj.keys()].filter((n) => !allowed.has(n) && n !== x && n !== y);
    adj = eliminate(adj, forbidden);
    const { separators, truncated } = minimalVertexSeparators(adj, x, y, limit);
    return { separators: separators.map((s) => new Set([...s, ...included])), truncated };
  }

  /**
   * Every set Z of allowed nodes (x and y left out) with x d-separated from y given Z, smallest
   * sets first. Separating sets are not closed under adding nodes (conditioning on a common effect
   * opens a path), so every candidate is checked with d-separation. Stops after maxSets sets or
   * maxChecks checks: {sets, complete, checked, pool}. complete is true only when every subset of
   * the pool was checked.
   */
  function allDSeparators(graph, x, y, { allowed = null, maxSets = 500, maxChecks = 200000 } = {}) {
    if (x === y) throw new Error("x and y must differ");
    const pool = MG.sorted([...(allowed === null ? graph.ids : allowed)].filter((n) => n !== x && n !== y && !graph.latent.has(n)));
    const sets = [];
    let checks = 0;
    for (let k = 0; k <= pool.length; k++) {
      for (const combo of combinations(pool, k)) {
        if (checks >= maxChecks || sets.length >= maxSets) return { sets, complete: false, checked: checks, pool: pool.length };
        checks++;
        if (checks % 256 === 0) MG.checkTime();
        if (MG.dsep.dSeparated(graph, [x], [y], combo)) sets.push(new Set(combo));
      }
    }
    return { sets, complete: true, checked: checks, pool: pool.length };
  }

  /** The k-element subsets of items, in lexicographic order. */
  function* combinations(items, k) {
    const idx = Array.from({ length: k }, (_, i) => i);
    if (k > items.length) return;
    while (true) {
      yield idx.map((i) => items[i]);
      let i = k - 1;
      while (i >= 0 && idx[i] === items.length - k + i) i--;
      if (i < 0) return;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
  }

  MG.separators = { moralGraph, eliminate, minimalVertexSeparators, minimalDSeparators, allDSeparators, combinations };
})(globalThis.MG);
