/* Recovery that mixes missing-data reasoning with the do-calculus. It generalises Appendix A.2
 * of Mohan & Pearl (2021) and handles partially observed treatments.
 *
 * A query is P(A | do(D), B) over nodes of the m-graph (substantive variables, indicators and
 * proxies), each with a value: a symbol or a constant. The solver rewrites it with identities that
 * hold in every model of the graph until every term is read from the observed data:
 *
 *   proxy        with R_Y = 0 fixed, the event Y = y is the event Y* = y (Equation 1)
 *   observed     no partially observed variable is left: P(A | B) is read from the data
 *   add R = 0    P(A | do(D), B) = P(A | do(D), B, R_N = 0) when A ⊥⊥ R_N | B, D in G with
 *                edges into D removed (Rule 1)
 *   classic      substantive questions go to MG.missing.recover (Theorems 1-3, R-factorisation)
 *   Rule 2       P(A | B) = P(A | do(W), B \ W) when A ⊥⊥ W | B \ W in G with edges out of W removed
 *   chain rule   P(a, A' | ·) = P(a | A', ·) P(A' | ·)
 *   weighting    P(A | ·) = Σ_P P(A, P, R_Y = 0 | ·) / P(R_Y = 0 | A \ Y, P, ·), summing over
 *                the indicator parents P of R_Y, valid when R_Y ⊥⊥ Y given the rest (Rule 1)
 *   identify     IDC in the graph where a chosen set of partially observed variables is treated
 *                as observed and the rest appear only through their proxies; each resulting term
 *                is solved again (this choice is what Appendix A.2 makes by hand)
 *
 * The tests evaluate every formula against the truth, as for the rest of the engine.
 *   ratio        P(A | do(D), B) = P(A, B_m | do(D), B') / P(B_m | do(D), B')
 */
(function (MG) {
  "use strict";
  const E = () => MG.expr;
  const STAR = () => MG.PROXY_SUFFIX;

  /** The symbol a node's value is written with: X, R_X, or X* for a proxy (which can be missing). */
  function defaultSymbol(graph, n) {
    return graph.proxies.has(n) ? n.slice(0, -STAR().length) + "*" : n;
  }

  const fmtQuery = (A, B, D = []) => {
    const f = (l) => l.map(([n, v]) => (typeof v === "number" ? `${n} = ${v}` : n)).join(", ");
    const right = [D.length ? `do(${f(D)})` : null, B.length ? f(B) : null].filter(Boolean).join(", ");
    return right ? `P(${f(A)} | ${right})` : `P(${f(A)})`;
  };

  // solved queries are shared by every search on the same graph; failures are kept only when the
  // search was complete (no cycle cut and no budget exhausted below them)
  const solvedCache = new WeakMap();

  function context(graph, opts = {}) {
    if (!solvedCache.has(graph)) solvedCache.set(graph, new Map());
    return { debug: !!opts.debug, graph, maxDepth: opts.maxDepth ?? 6, memo: new Map(), solved: solvedCache.get(graph), steps: [], budget: { left: opts.budget ?? 4000 }, cut: new Map(), inProgress: new Set() };
  }

  /** Spend work units; false when the budget is used up. */
  function spend(ctx, units) {
    MG.checkTime();
    ctx.budget.left -= units;
    return ctx.budget.left >= 0;
  }

  function recoverPlain(graph, A, B, opts = {}) {
    return recoverDo(graph, A, B, [], opts);
  }

  /**
   * Passes are repeated while they solve new sub-queries: a sub-query that failed only because it
   * looped back to a query still in progress can succeed in the next pass, which starts from
   * every success so far (successes are always valid; such failures are not kept).
   */
  function recoverDo(graph, A, B, D, opts = {}) {
    // iterative deepening: shallow solutions are found cheaply and cached for deeper passes
    const deepest = opts.maxDepth ?? 6;
    const passes = opts.passes ?? 4;
    for (let depth = Math.min(2, deepest); depth <= deepest; depth++) {
      for (let i = 0; i < passes; i++) {
        const ctx = context(graph, { ...opts, maxDepth: depth });
        const before = [...ctx.solved.values()].filter(Boolean).length;
        ctx.tainted = false;
        const expr = solve(ctx, A, B, D, 0);
        if (expr) return { expr, steps: ctx.steps, depth, passes: i + 1 };
        const after = [...ctx.solved.values()].filter(Boolean).length;
        if (!ctx.tainted) return null; // a complete search found nothing
        if (after === before) break;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- the solver

  function solve(ctx, A, B, D, depth) {
    [A, B] = canonical(ctx.graph, A, B);
    // a query whose condition could be an impossible event (a recorded proxy value with its
    // indicator free, say) has undefined values: no rule may produce it
    if (!supportSafe(ctx.graph, E().P(A, B))) return null;
    const key = JSON.stringify([sortE(A), sortE(B), sortE(D)]);
    if (ctx.solved.has(key)) return ctx.solved.get(key);
    if (ctx.memo.has(key)) {
      ctx.tainted = true; // a failure remembered from a cut search: not a proof of anything
      return ctx.memo.get(key).expr;
    }
    if (ctx.inProgress.has(key)) {
      ctx.tainted = true; // a cycle: this failure says nothing about the query
      return null;
    }
    if (depth > ctx.maxDepth || !spend(ctx, 1)) {
      ctx.tainted = true;
      return null;
    }
    if (ctx.debug) console.log("  ".repeat(depth) + "? " + fmtQuery(A, B, D));
    ctx.inProgress.add(key);
    const outerTaint = ctx.tainted;
    ctx.tainted = false;
    const r0 = rules(ctx, A, B, D, depth);
    const r = r0 ? r0.expr : null;
    const rule = r0 ? r0.rule : null;
    ctx.inProgress.delete(key);
    if (r) {
      ctx.solved.set(key, r);
      ctx.steps.push({ query: fmtQuery(A, B, D), depth, A, B, D, expr: r, rule });
    } else if (!ctx.tainted) ctx.solved.set(key, null);
    else ctx.memo.set(key, { expr: null });
    ctx.tainted = outerTaint || ctx.tainted;
    return r;
  }

  /**
   * Y becomes its proxy Y* where that names the same event: Y and R_Y = 0 both in the outcome
   * (the joint event), or R_Y = 0 in the condition. Not when Y is conditioned on and R_Y = 0 is
   * an outcome: P(R_Y = 0 | Y = y) is not P(R_Y = 0 | Y* = y), which is always 1.
   */
  function canonical(g, A, B) {
    const zeroIn = (list) => new Set(list.filter(([n, v]) => g.indicators.has(n) && v === 0).map(([n]) => n));
    const zA = zeroIn(A), zB = zeroIn(B);
    const pm = g.partiallyObserved;
    const swapA = ([n, v]) => (pm.has(n) && (zA.has(MG.R_PREFIX + n) || zB.has(MG.R_PREFIX + n)) ? [n + STAR(), v] : [n, v]);
    const swapB = ([n, v]) => (pm.has(n) && zB.has(MG.R_PREFIX + n) ? [n + STAR(), v] : [n, v]);
    return [A.map(swapA), B.map(swapB)];
  }

  function rules(ctx, A, B, D, depth) {
    const g = ctx.graph;
    const pm = g.partiallyObserved;
    const nodes = (l) => l.map(([n]) => n);
    const all = [...A, ...B];
    const hidden = all.filter(([n]) => pm.has(n)); // partially observed, indicator not fixed at 0
    const Dn = nodes(D);
    const cutG = cutInto(ctx, Dn);

    // observed
    if (!D.length && !hidden.length) return { rule: "observed", expr: E().P(A, B) };

    // add R = 0 (Rule 1 when there are interventions)
    const need = [...new Set(hidden.map(([n]) => MG.R_PREFIX + n))];
    const used = new Set(nodes([...all, ...D]));
    if (need.length && need.every((r) => !used.has(r)) && MG.dsep.dSeparated(cutG, nodes(A), need, [...nodes(B), ...Dn])) {
      const r = solve(ctx, A, [...B, ...need.map((x) => [x, 0])], D, depth + 1);
      if (r) return { rule: "add R = 0", expr: r };
    }

    // classic missing-data methods for substantive questions written with their own names
    const substantive = !D.length && all.every(([n, v]) => (g.fullyObserved.has(n) || pm.has(n)) && v === n);
    if (substantive && depth > 0 && !spend(ctx, 10)) ctx.tainted = true;
    else if (substantive && depth > 0) {
      try {
        const r = MG.missing.recover(g, nodes(A), nodes(B), { depth: 1, maxDepth: 1, noHybrid: true, quick: true });
        if (r.recoverable === true) return { rule: "classic " + r.method, expr: r.expr };
        if (r.recoverable === false) return null; // proved impossible (Theorem 3)
      } catch (e) {
        if (e instanceof MG.TimeUp) throw e; // out of time: not a verdict
        /* not a question the classic methods take */
      }
    }

    // Rule 2: partially observed conditioning variables become interventions
    if (!D.length) {
      const cands = B.filter(([n, v]) => pm.has(n) && typeof v === "string");
      for (const W of subsets(cands).filter((w) => w.length).sort((a, b) => a.length - b.length)) {
        const w = nodes(W);
        const rest = B.filter(([n]) => !w.includes(n));
        const cut = new MG.Graph({ nodes: g.ids.map((i) => g.meta.get(i)), edges: g.edges.filter(([a]) => !w.includes(a)), latent: g.latent });
        if (MG.dsep.dSeparated(cut, nodes(A), w, nodes(rest))) {
          const r = solve(ctx, A, rest, W, depth + 1);
          if (r) return { rule: "Rule 2", expr: r };
        }
      }
    }

    // chain rule
    if (A.length > 1) {
      for (let i = 0; i < A.length; i++) {
        const others = A.filter((_, j) => j !== i);
        const f1 = solve(ctx, [A[i]], [...others, ...B], D, depth + 1);
        if (!f1) continue;
        const f2 = solve(ctx, others, B, D, depth + 1);
        if (f2) return { rule: "chain rule", expr: E().prod(f1, f2) };
      }
    }

    // weighting: observe a partially observed outcome only where its indicator is 0
    for (const [Y, y] of A.filter(([n]) => pm.has(n))) {
      const rY = MG.R_PREFIX + Y;
      if (used.has(rY)) continue;
      const parents = MG.sorted([...g.parents(rY)].filter((p) => g.indicators.has(p) && !used.has(p) && p !== rY));
      const rest = [...A.filter(([n]) => n !== Y), ...parents.map((p) => [p, p]), ...B];
      if (!MG.dsep.dSeparated(cutG, [rY], [Y], [...nodes(rest), ...Dn])) continue;
      const num = solve(ctx, [...A, ...parents.map((p) => [p, p]), [rY, 0]], B, D, depth + 1);
      if (!num) continue;
      const den = solve(ctx, [[rY, 0]], rest, D, depth + 1);
      if (!den) continue;
      return { rule: "weighting", expr: E().sum(parents, E().frac(num, den)) };
    }

    // ratio: P(A | do(D), B) = P(A, B_m | do(D), B \ B_m) / P(B_m | do(D), B \ B_m) for the
    // partially observed conditioning variables B_m
    const Bm = B.filter(([n]) => pm.has(n));
    if (Bm.length) {
      const rest = B.filter(([n]) => !pm.has(n));
      const num = solve(ctx, [...A, ...Bm], rest, D, depth + 1);
      if (num) {
        const den = solve(ctx, Bm, rest, D, depth + 1);
        if (den) return { rule: "ratio", expr: E().frac(num, den) };
      }
    }

    // identify with some partially observed variables treated as observed, the rest as proxies
    const id = identify(ctx, A, B, D, depth);
    return id ? { rule: "identify", expr: id } : null;
  }

  function identify(ctx, A, B, D, depth) {
    const g = ctx.graph;
    const pm = MG.sorted(g.partiallyObserved);
    const all = [...A, ...B, ...D];
    const mustObserve = new Set(all.filter(([n]) => g.partiallyObserved.has(n)).map(([n]) => n));
    const mustHide = new Set(all.filter(([n]) => g.proxies.has(n)).map(([n]) => n.slice(0, -STAR().length)));
    if ([...mustObserve].some((n) => mustHide.has(n))) return null;
    const free = pm.filter((v) => !mustObserve.has(v) && !mustHide.has(v));
    // identify under every candidate observed set first (cheap), then solve the terms of the
    // candidates with the least missingness left in them first
    const candidates = [];
    const inQuery = new Set(all.map(([n]) => n));
    // proxies go last in the topological order, so ID conditions on them as rarely as possible
    const rank = (n) => (g.proxies.has(n) ? 1 : 0);
    for (const extra of subsets(free).sort((a, b) => a.length - b.length).slice(0, 16)) {
      const S = new Set([...mustObserve, ...extra]);
      // a hidden variable's proxy is kept only when the query uses it; otherwise it is an
      // unobserved sink and leaving it out changes nothing
      const O = g.ids.filter((n) => {
        if (g.latent.has(n)) return false;
        if (g.partiallyObserved.has(n)) return S.has(n);
        if (g.proxies.has(n)) return !S.has(n.slice(0, -STAR().length)) && inQuery.has(n);
        return true;
      });
      // ID needs positivity, which a proxy and its own indicator break (X* is missing exactly
      // when R_X = 1). The proxy alone carries the indicator, so each such indicator is merged
      // into its proxy: the merged node keeps the indicator's causes and effects.
      const merged = O.filter((n) => g.proxies.has(n)).map((x) => [MG.R_PREFIX + x.slice(0, -STAR().length), x]);
      const q = translateForMerge(g, A, B, D, merged);
      if (!q) continue;
      if (!spend(ctx, 3)) {
        ctx.tainted = true;
        break;
      }
      const gm = mergeIndicators(g, merged);
      const Om = O.filter((n) => !merged.some(([r]) => r === n));
      const vOf = new Map([...q.A, ...q.B, ...q.D]);
      const sym = (n) => (vOf.has(n) && typeof vOf.get(n) === "string" ? vOf.get(n) : defaultSymbol(g, n));
      const cons = Object.fromEntries([...q.A, ...q.B, ...q.D].filter(([, v]) => typeof v === "number"));
      try {
        const r = MG.causal.idc(MG.ADMG.project(gm, Om), q.A.map(([n]) => n), q.D.map(([n]) => n), q.B.map(([n]) => n), { symbol: sym, constants: cons, rank });
        if (supportSafe(g, r.expr)) candidates.push({ expr: r.expr, score: missingness(g, r.expr), size: S.size });
      } catch (e) {
        if (e instanceof MG.TimeUp) throw e; // out of time: not a verdict
        if (!(e instanceof MG.causal.NotIdentifiable)) throw e;
      }
    }
    candidates.sort((a, b) => a.score - b.score || a.size - b.size);
    for (const c of candidates) {
      const out = substitute(c.expr, (term) => {
        const r = solve(ctx, term.vars, term.given, [], depth + 1);
        if (ctx.debug && r) console.log("    term", E().toText(term), "=>", E().toText(r).slice(0, 160));
        return r;
      });
      if (ctx.debug) console.log("  IDC raw:", E().toText(c.expr).slice(0, 300));
      if (out) return out;
    }
    return null;
  }

  /**
   * Every conditioning event can have positive probability. A proxy is tied to its indicator
   * (X* is missing exactly when R_X = 1), so conditioning on both is safe only when their values
   * cannot contradict: a recorded value of X* needs R_X fixed at 0, and a value that may be
   * "missing" needs R_X left out.
   */
  function supportSafe(g, e) {
    const isProxySymbol = (v) => typeof v === "string" && v.endsWith("*");
    let ok = true;
    const go = (x) => {
      if (!ok) return;
      if (x.t === "P") {
        const given = new Map(x.given);
        const all = new Map([...x.vars, ...x.given]);
        for (const [c, v] of x.given) {
          if (!g.proxies.has(c)) continue;
          const r = MG.R_PREFIX + c.slice(0, -STAR().length);
          if (!all.has(r)) continue;
          const rv = all.get(r);
          if (isProxySymbol(v) || v === 2) {
            if (!(rv === 1 && v === 2)) ok = false; // a possibly-missing value with R_X stated
          } else if (rv !== 0) ok = false; // a recorded value needs R_X = 0
        }
        for (const [c, v] of x.vars) {
          // R_X as an outcome with a recorded proxy value in the condition: R_X must be 0
          if (!g.indicators.has(c)) continue;
          const proxy = c.slice(MG.R_PREFIX.length) + STAR();
          if (given.has(proxy) && v !== 0 && !isProxySymbol(given.get(proxy))) ok = false;
        }
      } else if (x.t === "sum") go(x.body);
      else if (x.t === "prod") x.factors.forEach(go);
      else if (x.t === "frac") {
        go(x.num);
        go(x.den);
      }
    };
    go(e);
    return ok;
  }

  /** How many partially observed values in an expression's terms still lack R = 0. */
  function missingness(g, e) {
    let n = 0;
    const go = (x) => {
      if (x.t === "P") {
        const all = [...x.vars, ...x.given];
        const zero = new Set(all.filter(([c, v]) => g.indicators.has(c) && v === 0).map(([c]) => c));
        for (const [c] of all) if (g.partiallyObserved.has(c) && !zero.has(MG.R_PREFIX + c)) n++;
      } else if (x.t === "sum") go(x.body);
      else if (x.t === "prod") x.factors.forEach(go);
      else if (x.t === "frac") {
        go(x.num);
        go(x.den);
      }
    };
    go(e);
    return n;
  }

  /**
   * Rewrite a query for a graph where each listed indicator R_X is merged into its proxy X*.
   * "X* = x, R_X = 0" is the event "X* = x"; a query that names R_X otherwise cannot be written
   * in the merged graph (null).
   */
  function translateForMerge(g, A, B, D, merged) {
    const rs = new Map(merged);
    const all = [...A, ...B, ...D];
    const valueOf = new Map(all);
    for (const [n, v] of all) {
      if (!rs.has(n)) continue;
      const proxy = rs.get(n);
      if (D.some(([d]) => d === n)) return null; // an intervention on a merged indicator
      const pv = valueOf.get(proxy);
      if (v !== 0 || pv === undefined || (typeof pv === "string" && pv.endsWith("*")) || pv === 2) return null;
      // R_X = 0 must sit on the same side as X*, or in the condition
      const proxyInA = A.some(([a]) => a === proxy);
      const rInA = A.some(([a]) => a === n);
      if (rInA && !proxyInA) return null;
    }
    const keep = ([n]) => !rs.has(n);
    return { A: A.filter(keep), B: B.filter(keep), D: D.filter(keep) };
  }

  /** The graph with each indicator R_X contracted into its proxy X*. */
  function mergeIndicators(g, merged) {
    if (!merged.length) return g;
    const into = new Map(merged);
    const edges = [];
    const seen = new Set();
    for (const [a0, b0] of g.edges) {
      const a = into.get(a0) || a0, b = into.get(b0) || b0;
      if (a === b) continue;
      const k = a + "\u0001" + b;
      if (!seen.has(k)) {
        seen.add(k);
        edges.push([a, b]);
      }
    }
    return new MG.Graph({ nodes: g.ids.filter((n) => !into.has(n)).map((n) => g.meta.get(n)), edges, latent: g.latent });
  }

  /** G with edges into D removed (cached). */
  function cutInto(ctx, D) {
    const k = D.slice().sort().join(",");
    if (!ctx.cut.has(k)) {
      const g = ctx.graph;
      ctx.cut.set(k, D.length ? new MG.Graph({ nodes: g.ids.map((i) => g.meta.get(i)), edges: g.edges.filter(([, b]) => !D.includes(b)), latent: g.latent }) : g);
    }
    return ctx.cut.get(k);
  }

  /** Replace every P term by fn(term); null if any term cannot be replaced. */
  function substitute(e, fn) {
    const go = (x) => {
      if (x.t === "P") {
        const r = fn(x);
        if (!r) throw new Error("unrecovered term");
        return r;
      }
      if (x.t === "sum") return { ...x, body: go(x.body) };
      if (x.t === "prod") return { ...x, factors: x.factors.map(go) };
      if (x.t === "frac") return { ...x, num: go(x.num), den: go(x.den) };
      return x;
    };
    try {
      return go(e);
    } catch (err) {
      if (err instanceof MG.TimeUp) throw err; // out of time: not a verdict
      if (err.message === "unrecovered term") return null;
      throw err;
    }
  }

  function subsets(items) {
    const out = [[]];
    for (const it of items) for (const s of out.slice()) out.push([...s, it]);
    return out;
  }

  function sortE(list) {
    return list.map(([n, v]) => [n, v]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  MG.hybrid = { recoverPlain, recoverDo, defaultSymbol, fmtQuery, _cache: (g) => solvedCache.get(g) };
})(globalThis.MG);
