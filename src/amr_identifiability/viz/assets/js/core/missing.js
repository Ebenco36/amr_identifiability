/* Missing data: the graphical results of Mohan & Pearl (2021, JASA). Numbers are JASA numbers.
 *
 *   classify(graph)                 MCAR / v-MAR / MNAR (Section 2.2), with the deciding d-separation
 *   recover(graph, target, given)   is P(target | given) recoverable, and how:
 *       direct          every variable is fully observed
 *       Corollary 2     complete cases / available cases
 *       Corollary 1     v-MAR joint distribution
 *       Theorem 1       admissible ordered factorisation (Definition 2), summing over helper
 *                       variables if needed; helpers and conditioning sets may include
 *                       indicators, which are fully observed (as in Example 4)
 *       R-factorisation the joint as P(V*, R = 0) / P(R = 0 | V) (Section 3.2, Theorem 2),
 *                       each factor simplified by a d-separation, then marginalised
 *       Theorem 3       proof that it is NOT recoverable
 *   testability(graph)              Theorems 4-6 and Corollary 3
 *
 * Every recoverable answer is an estimand (MG.expr) built step by step from d-separations
 * that the graph implies; the tests evaluate each one numerically against the truth.
 * Recovery by intervention (Section 3.3) uses the ID algorithm and lives in MG.causal.
 */
(function (MG) {
  "use strict";
  const E = () => MG.expr;
  const R = (v) => MG.R_PREFIX + v;

  /** Roles in the paper's notation. */
  function sets(graph) {
    return {
      Vo: new Set(graph.fullyObserved),
      Vm: new Set(graph.partiallyObserved),
      U: new Set(graph.latent),
      R: new Set(graph.indicators),
      Vstar: new Set(graph.proxies),
    };
  }

  // ---------------------------------------------------------------- Section 2.2

  function classify(graph) {
    const { Vo, Vm, U, R: Rs } = sets(graph);
    if (!Rs.size) return { mechanism: "complete", text: "No variable is partially observed: there is no missing data." };
    const all = new Set([...Vm, ...Vo, ...U]);
    const sep = (X, Z) => MG.dsep.dSeparated(graph, X, Rs, Z);
    const mcar = new MG.Statement(all, Rs, []);
    const vmar = new MG.Statement(new Set([...Vm, ...U]), Rs, Vo);
    const out = { mcarStatement: mcar, vmarStatement: vmar };
    out.mcar = sep(all, []);
    out.vmar = Vm.size + U.size === 0 ? true : sep(new Set([...Vm, ...U]), Vo);
    out.mechanism = out.mcar ? "MCAR" : out.vmar ? "v-MAR" : "MNAR";
    // a witness: an open path that breaks the stronger condition
    const witness = (from, Z) => {
      for (const a of MG.sorted(from)) for (const r of MG.sorted(Rs)) {
        const { paths } = MG.dsep.paths(graph, a, r, Z, { onlyOpen: true, maxPaths: 1, maxLength: 30 });
        if (paths.length) return paths[0];
      }
      return null;
    };
    if (!out.mcar) out.mcarWitness = witness(all, []);
    if (!out.vmar) out.vmarWitness = witness(new Set([...Vm, ...U]), Vo);
    out.text = {
      MCAR: "Missingness is independent of every variable in the model (Vm ∪ Vo ∪ U ⊥⊥ R).",
      "v-MAR": "Given the fully observed variables, missingness is independent of the partially observed and latent ones (Vm ∪ U ⊥⊥ R | Vo).",
      MNAR: "Missingness depends on partially observed or latent variables even given the fully observed ones.",
    }[out.mechanism];
    return out;
  }

  // ---------------------------------------------------------------- helpers

  /** The observed column that carries a variable's value. */
  function column(graph, v) {
    return graph.partiallyObserved.has(v) ? v + MG.PROXY_SUFFIX : v;
  }

  /** Indicators that must be 0 to observe these variables. */
  function indicatorsOf(graph, vars) {
    return new Set([...vars].filter((v) => graph.partiallyObserved.has(v)).map(R));
  }

  function termOf(graph, vars, given, zeros) {
    return E().P(
      [...vars].map((v) => [column(graph, v), v]),
      [...MG.sorted(given).map((v) => [column(graph, v), v]), ...MG.sorted(zeros).filter((r) => !given.has(r)).map((r) => [r, 0])]
    );
  }

  function makeSep(graph) {
    const memo = new Map();
    return (X, Y, Z) => {
      X = new Set(X);
      Y = new Set(Y);
      Z = new Set(Z);
      for (const z of Z) {
        X.delete(z);
        Y.delete(z);
      }
      if (!X.size || !Y.size) return true;
      const k = MG.setKey(X) + "|" + MG.setKey(Y) + "|" + MG.setKey(Z);
      if (!memo.has(k)) memo.set(k, MG.dsep.dSeparated(graph, X, Y, Z));
      return memo.get(k);
    };
  }

  function subsetsBySize(items, maxSize = items.length) {
    const out = [];
    const rec = (start, acc) => {
      out.push(acc.slice());
      if (acc.length === maxSize) return;
      for (let i = start; i < items.length; i++) {
        acc.push(items[i]);
        rec(i + 1, acc);
        acc.pop();
      }
    };
    rec(0, []);
    return out.sort((a, b) => a.length - b.length);
  }

  /** Permutations in lexicographic order of positions, generated lazily. */
  function* permutations(items) {
    if (items.length <= 1) {
      yield items.slice();
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const rest = items.slice(0, i).concat(items.slice(i + 1));
      for (const p of permutations(rest)) yield [items[i], ...p];
    }
  }

  const ind = (x, y, z) => new MG.Statement([].concat(x), [...y], [...z]);

  // ---------------------------------------------------------------- Theorem 3 (non-recoverability)

  /**
   * Proof that P(target | given) is not recoverable, or null. For each partially observed X in
   * the target, Theorem 3 applies to P(X | Y) with Y = (target ∪ given) \ {X}; P(X | Y) is
   * computable from P(target | given) because given ⊆ Y, so the target is not recoverable either.
   */
  function theorem3(graph, target, given) {
    const adm = MG.ADMG.project(graph);
    const { Vm } = sets(graph);
    for (const X of MG.sorted(target)) {
      if (!Vm.has(X)) continue;
      const rx = R(X);
      const Y = new Set([...target, ...given].filter((v) => v !== X));
      if (adm.adjacent(X, rx)) {
        const how = adm.hasDirected(X, rx) ? `${X} → ${rx}` : adm.hasDirected(rx, X) ? `${rx} → ${X}` : `${X} ↔ ${rx}`;
        return { variable: X, kind: "neighbours", text: `${X} and ${rx} are neighbours (${how}${graph.hasEdge(X, rx) || graph.hasEdge(rx, X) ? "" : ", through latent variables"}), so P(${X}${Y.size ? " | " + MG.sorted(Y).join(", ") : ""}) is not recoverable (Theorem 3).` };
      }
      const paths = adm.colliderPaths(X, rx, Y);
      if (paths.length) {
        const p = paths[0];
        return { variable: X, kind: "collider path", path: p, text: `${X} and ${rx} are joined by ${p.join(" ⋯ ")}, a path whose inner nodes are all colliders in the conditioning set, so P(${X} | ${MG.sorted(Y).join(", ")}) is not recoverable (Theorem 3).` };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- Corollaries 1 and 2

  function corollary2(graph, target, given, sep) {
    const T = new Set(target), S = new Set(given);
    const { R: all } = sets(graph);
    const avail = indicatorsOf(graph, [...T, ...S]);
    const out = {};
    // (b) available cases: T ⊥⊥ (R_T, R_S) | S
    out.available = { statement: ind([...T], avail, S), holds: avail.size === 0 || sep(T, avail, S) };
    // (a) complete cases: T ⊥⊥ R | S, every indicator in the dataset
    out.complete = { statement: ind([...T], all, S), holds: all.size === 0 || sep(T, all, S) };
    if (out.available.holds) out.available.expr = termOf(graph, T, S, avail);
    if (out.complete.holds) out.complete.expr = termOf(graph, T, S, all);
    return out;
  }

  // ---------------------------------------------------------------- Theorem 1

  /**
   * An admissible ordered factorisation of P(T | S), summing over helper variables W if needed:
   *   P(T | S) = Σ_W Π_i P(Y_i | X_i),   X_i ⊆ {Y_{i+1}, ..., Y_n} ∪ S
   * with, for every factor,
   *   (a) Y_i ⊥⊥ ({Y_{i+1}, ..., Y_n} ∪ S) \ X_i | X_i   (the factor equals the chain-rule term)
   *   (b) Y_i ⊥⊥ (R_{Y_i}, R_{X_i}) | X_i                (Theorem 1: the factor is recoverable)
   * Returns the factorisation with the fewest helpers, or null.
   */
  function theorem1(graph, target, given, sep, opts = {}) {
    if (opts.quick) return theorem1Search(graph, target, given, sep, { ...opts, maxHelpers: 1, maxOrders: 24 });
    // fast pass: larger helper sets, but only the natural order (descendants first, so each
    // factor conditions on its causes); then the full search over orders with fewer helpers
    const topo = new Map(MG.ADMG.project(graph).topological().map((v, i) => [v, i]));
    const natural = (vars) => [vars.slice().sort((a, b) => (topo.get(b) ?? 0) - (topo.get(a) ?? 0))];
    // first pass: the helpers are a minimal set separating the target from its indicators,
    // which is exactly what the target's own factor needs
    const { Vo, Vm, R: Rs } = sets(graph);
    const T = [...target], S = [...given];
    const need = [...indicatorsOf(graph, T)];
    if (T.length === 1 && need.length === 1) {
      const allowed = new Set([...Vo, ...Vm, ...Rs].filter((v) => !T.includes(v) && v !== need[0]));
      const inc = S.filter((v) => allowed.has(v));
      let seps = [];
      try {
        seps = MG.separators.minimalDSeparators(graph, T[0], need[0], { allowed, included: inc, limit: 20 }).separators;
      } catch (e) {
        if (e instanceof MG.TimeUp) throw e; // out of time: not a verdict
        seps = [];
      }
      for (const Z of seps) {
        const W = [...Z].filter((v) => !S.includes(v));
        if (W.some((w) => Rs.has(w))) continue;
        const r = theorem1Search(graph, target, given, sep, { ...opts, fixedHelpers: W, maxVars: 14, orders: natural });
        if (r) return r;
      }
    }
    // the wider natural-order pass only at the top level; recursive sub-queries use the full search
    const wide = (opts.depth || 0) === 0 ? theorem1Search(graph, target, given, sep, { ...opts, maxHelpers: opts.maxHelpersNatural ?? 6, maxVars: 12, orders: natural, maxSubsets: 400, maxDepth: 0 }) : null;
    return wide || theorem1Search(graph, target, given, sep, opts);
  }

  function theorem1Search(graph, target, given, sep, { maxHelpers = 3, maxVars = 7, depth = 0, maxDepth = 2, orders = null, maxSubsets = Infinity, fixedHelpers = null, maxOrders = 5040 } = {}) {
    const { Vo, Vm, R: Rs } = sets(graph);
    const T = MG.sorted(target), S = new Set(given);
    const used = new Set([...T, ...S]);
    const usedPartial = new Set([...used].filter((v) => Vm.has(v)));
    // helpers: substantive ancestors of the target and given variables, and indicators of
    // variables that are not themselves in the factorisation
    const anc = graph.ancestralClosure(new Set([...used, ...indicatorsOf(graph, used)]));
    // a partially observed variable and its own indicator can never both be free symbols:
    // the variable is only observed where its indicator is 0
    const pool = MG.sorted([...anc].filter((v) => !used.has(v) && (Vo.has(v) || (Vm.has(v) && !used.has(R(v))) || (Rs.has(v) && !usedPartial.has(v.slice(2))))));
    const subMemo = new Map();
    // a factor whose condition (b) fails may still be recoverable on its own (Example 4, G1)
    const subRecover = (Yi, Xi) => {
      const k = Yi + "|" + Xi.join(",");
      if (!subMemo.has(k)) {
        let r = null;
        if (depth < maxDepth) {
          try {
            r = recoverRaw(graph, [Yi], Xi, { maxHelpers, maxVars, depth: depth + 1, maxDepth });
          } catch (e) {
            if (e instanceof MG.TimeUp) throw e; // out of time: not a verdict
            r = null;
          }
        }
        subMemo.set(k, r && r.recoverable === true ? r : null);
      }
      return subMemo.get(k);
    };
    let nSubsets = 0;
    for (const W of fixedHelpers ? [MG.sorted(fixedHelpers)] : subsetsBySize(pool, maxHelpers)) {
      if (++nSubsets > maxSubsets) break;
      if (T.length + W.length > maxVars) continue;
      // an indicator helper R_v cannot sit with v in the same factorisation
      if (W.some((w) => Rs.has(w) && W.includes(w.slice(2)))) continue;
      const vars = [...T, ...W];
      let tried = 0;
      for (const order of orders ? orders(vars) : permutations(vars)) {
        if (++tried > maxOrders) break;
        MG.checkTime();
        const steps = [];
        let ok = true;
        for (let i = 0; i < order.length && ok; i++) {
          const Yi = order[i];
          const C = MG.sorted([...order.slice(i + 1), ...S]);
          let found = null;
          const fallback = [];
          for (const Xi of subsetsBySize(C, Math.min(C.length, 8))) {
            const Xs = new Set(Xi);
            const rest = C.filter((c) => !Xs.has(c));
            const need = indicatorsOf(graph, [Yi, ...Xi]);
            if (need.has(Yi)) continue; // Y_i is the indicator of a variable it is conditioned on
            if (Vm.has(Yi) && Xs.has(R(Yi))) continue; // Y_i conditioned on its own indicator
            if (Xi.some((x) => Rs.has(x) && Xi.includes(x.slice(2)))) continue;
            const a = rest.length === 0 || sep([Yi], rest, Xs);
            if (!a) continue;
            const b = need.size === 0 || sep([Yi], need, Xs);
            if (!b) {
              fallback.push({ Xi, rest });
              continue;
            }
            found = { Xi, need, a: rest.length ? ind(Yi, rest, Xs) : null, b: need.size ? ind(Yi, need, Xs) : null };
            break;
          }
          if (!found) {
            for (const { Xi, rest } of fallback) {
              const sub = subRecover(Yi, Xi);
              if (sub) {
                found = { Xi, need: new Set(), a: rest.length ? ind(Yi, rest, new Set(Xi)) : null, b: null, sub };
                break;
              }
            }
          }
          if (!found) ok = false;
          else steps.push({ variable: Yi, given: found.Xi, zeros: MG.sorted(found.need), validity: found.a, recoverability: found.b, sub: found.sub || null });
        }
        if (!ok) continue;
        const factors = steps.map((s) => (s.sub ? s.sub.expr : termOf(graph, [s.variable], new Set(s.given), new Set(s.zeros))));
        const expr = E().sum(W, E().prod(...factors));
        return { order, helpers: W, steps, expr };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- R-factorisation (Section 3.2)

  /**
   * P(V) = P(V*, Vo, R = 0) / P(R = 0 | V), with P(R = 0 | V) = Π_i P(R_i = 0 | V, R_<i = 0)
   * (chain rule in some order of the indicators). Each factor is reduced to P(R_i = 0 | S_i)
   * by a d-separation R_i ⊥⊥ (V ∪ R_<i) \ S_i | S_i, and is observable when the indicators of
   * the partially observed variables in S_i can be set to 0 (they are in R_<i, or adding them
   * keeps the separation). Theorem 2's formula (4) is the special case with no edges between
   * indicators.
   */
  const rfCache = new WeakMap();

  function rFactorisation(graph, sep, opts = {}) {
    if (!rfCache.has(graph)) rfCache.set(graph, rFactorisationSearch(graph, sep, opts));
    return rfCache.get(graph);
  }

  function rFactorisationSearch(graph, sep) {
    const { Vo, Vm, R: Rs } = sets(graph);
    const V = MG.sorted([...Vo, ...Vm]);
    const Rlist = MG.sorted(Rs);
    if (!Rlist.length || Rlist.length > 14) return null;
    // a factor depends only on the indicator and the set of indicators before it: memoise it
    const memo = new Map();
    const factorFor = (Ri, before) => {
      const k = Ri + "|" + before.slice().sort().join(",");
      if (memo.has(k)) return memo.get(k);
      const pool = [...V, ...before];
      // greedy minimal S: drop partially observed variables first, then indicators, then the rest
      const rank = (n) => (Vm.has(n) ? 0 : Rs.has(n) ? 1 : 2);
      let S = new Set(pool);
      for (const n of pool.slice().sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))) {
        const trial = new Set(S);
        trial.delete(n);
        const rest = pool.filter((q) => !trial.has(q));
        if (sep([Ri], rest, trial)) S = trial;
      }
      let f = null;
      const need = indicatorsOf(graph, [...S].filter((n) => Vm.has(n)));
      if (!need.has(Ri)) {
        const extraBefore = [...need].filter((r) => before.includes(r) && !S.has(r));
        const extraAfter = [...need].filter((r) => !before.includes(r));
        const cond = new Set([...S, ...extraBefore]);
        const restOfPool = pool.filter((q) => !S.has(q));
        if (!extraAfter.length || sep([Ri], extraAfter, cond)) {
          f = {
            indicator: Ri,
            given: MG.sorted([...S].filter((n) => !Rs.has(n))),
            zeros: MG.sorted(new Set([...[...S].filter((n) => Rs.has(n)), ...need])),
            drop: restOfPool.length ? ind(Ri, restOfPool, S) : null,
            add: extraAfter.length ? ind(Ri, extraAfter, cond) : null,
          };
        } else {
          // Appendix A.2: recover the factor as a causal query
          f = causalFactor(graph, Ri, S);
        }
      }
      memo.set(k, f);
      return f;
    };
    // dynamic programming over sets of indicators already placed in the order
    const n = Rlist.length;
    const depth = new Map(Rlist.map((r) => [r, [...graph.ancestors(r)].filter((a) => Rs.has(a)).length]));
    const byDepth = Rlist.map((r, i) => i).sort((a, b) => depth.get(Rlist[a]) - depth.get(Rlist[b]) || a - b);
    const reach = new Map([[0, []]]); // mask -> order reaching it
    const queue = [0];
    while (queue.length) {
      MG.checkTime();
      const mask = queue.shift();
      const order = reach.get(mask);
      if (mask === (1 << n) - 1) {
        const factors = order.map((i, k) => factorFor(Rlist[i], order.slice(0, k).map((j) => Rlist[j])));
        const num = E().P([...V.map((v) => [column(graph, v), v]), ...Rlist.map((r) => [r, 0])]);
        const den = E().prod(...factors.map((f) => f.expr || E().P([[f.indicator, 0]], [...f.given.map((v) => [column(graph, v), v]), ...f.zeros.map((r) => [r, 0])])));
        return { order: order.map((i) => Rlist[i]), factors, expr: E().frac(num, den), V };
      }
      for (const i of byDepth) {
        if (mask & (1 << i)) continue;
        const next = mask | (1 << i);
        if (reach.has(next)) continue;
        const before = order.map((j) => Rlist[j]);
        if (factorFor(Rlist[i], before)) {
          reach.set(next, [...order, i]);
          queue.push(next);
        }
      }
    }
    return null;
  }

  /** One R-factorisation factor P(R_i = 0 | S) recovered with the do-calculus (Appendix A.2). */
  const factorCache = new WeakMap();

  function causalFactor(graph, Ri, S) {
    if (!MG.hybrid) return null;
    if (!factorCache.has(graph)) factorCache.set(graph, new Map());
    const cache = factorCache.get(graph);
    const key = Ri + "|" + MG.sorted(S).join(",");
    if (!cache.has(key)) cache.set(key, causalFactorUncached(graph, Ri, S));
    return cache.get(key);
  }

  function causalFactorUncached(graph, Ri, S) {
    const B = [...S].map((n) => (graph.indicators.has(n) ? [n, 0] : [n, n]));
    const h = MG.hybrid.recoverPlain(graph, [[Ri, 0]], B);
    if (!h) return null;
    const vars = [...S].filter((n) => !graph.indicators.has(n));
    return { indicator: Ri, given: MG.sorted(vars), zeros: MG.sorted([...S].filter((n) => graph.indicators.has(n))), expr: h.expr, viaDo: true, steps: h.steps, drop: null, add: null };
  }

  // ---------------------------------------------------------------- the whole question

  /**
   * Is P(target | given) recoverable from the observed-data distribution P(V*, Vo, R)?
   * target, given: substantive variables (fully or partially observed); given may include indicators.
   * Returns {recoverable: true | false | null, method, expr, steps, ...}.
   */
  const answerCache = new WeakMap();

  function recover(graph, target, given = [], opts = {}) {
    const r = recoverRaw(graph, target, given, opts);
    if (!opts.depth && r.expr) r.expr = MG.expr.present(r.expr);
    return r;
  }

  function recoverRaw(graph, target, given = [], opts = {}) {
    if (!answerCache.has(graph)) answerCache.set(graph, new Map());
    const cache = answerCache.get(graph);
    const key = JSON.stringify([MG.sorted(new Set(target)), MG.sorted(new Set(given)), opts.depth || 0, opts.maxDepth ?? 2, !!opts.ignoreTheorem3, !!opts.quick, !!opts.deep]);
    if (!cache.has(key)) cache.set(key, recoverUncached(graph, target, given, opts));
    return { ...cache.get(key) };
  }

  function recoverUncached(graph, target, given = [], opts = {}) {
    MG.checkTime();
    target = MG.sorted(new Set(target));
    given = MG.sorted(new Set(given));
    graph.require([...target, ...given]);
    const { Vo, Vm, R: Rs, U } = sets(graph);
    for (const v of [...target, ...given]) {
      if (U.has(v)) throw new Error(`${v} is latent; only recorded and partially observed variables can be recovered`);
      if (graph.proxies.has(v)) throw new Error(`${v} is a proxy; ask about the variable ${v.slice(0, -MG.PROXY_SUFFIX.length)} instead`);
    }
    for (const v of target) if (Rs.has(v)) throw new Error(`${v} is an indicator; it is fully observed, so its distribution is directly estimable`);
    const overlap = target.filter((v) => given.includes(v));
    if (overlap.length) throw new Error(`${overlap.join(", ")} is on both sides`);
    if (!target.length) throw new Error("the target needs at least one variable");
    const sep = makeSep(graph);
    const T = new Set(target), S = new Set(given);
    const out = { target, given, query: queryText(target, given), attempts: [] };
    const clash = [...T, ...S].filter((v) => Vm.has(v) && S.has(R(v)));
    if (clash.length)
      return { ...out, recoverable: null, method: null, reason: `The query conditions on ${clash.map(R).join(", ")} as a variable while asking about ${clash.join(", ")}, which is only observed where its indicator is 0. Ask about the variable with its indicator fixed instead.` };

    if ([...T, ...S].every((v) => Vo.has(v) || Rs.has(v))) {
      return { ...out, recoverable: true, method: "direct", reason: "Every variable in the query is fully observed.", expr: termOf(graph, T, S, new Set()) };
    }

    const proof = theorem3(graph, T, S);
    if (proof && !opts.ignoreTheorem3) return { ...out, recoverable: false, method: "Theorem 3", reason: proof.text, proof };

    const c2 = corollary2(graph, T, S, sep);
    out.corollary2 = c2;
    if (c2.complete.holds) return { ...out, recoverable: true, method: "Corollary 2(a)", reason: `Complete cases suffice: ${c2.complete.statement.pretty()}.`, expr: c2.complete.expr, completeCases: true, availableCases: true };
    if (c2.available.holds) return { ...out, recoverable: true, method: "Corollary 2(b)", reason: `Available cases suffice: ${c2.available.statement.pretty()}.`, expr: c2.available.expr, availableCases: true, completeCases: false };

    // simplest first: Theorem 1 with directly recoverable factors, then R-factorisation, then
    // Theorem 1 with factors that are themselves recovered (as in Example 4)
    const depth0 = opts.depth || 0;
    const t1 = theorem1(graph, T, S, sep, { ...opts, maxDepth: depth0 });
    if (t1) return { ...out, recoverable: true, method: "Theorem 1", reason: "An admissible ordered factorisation recovers every factor.", expr: t1.expr, factorisation: t1, completeCases: false, availableCases: false };

    const rf = [...S].every((v) => Vo.has(v) || Vm.has(v)) ? rFactorisation(graph, sep, opts) : null;
    if (rf) {
      const V = rf.V;
      const outside = V.filter((v) => !T.has(v) && !S.has(v));
      const joint = E().sum(outside, rf.expr);
      const expr = S.size ? E().frac(joint, E().sum([...T, ...outside], rf.expr)) : joint;
      return { ...out, recoverable: true, method: "R-factorisation", reason: "The joint distribution is recovered by R-factorisation, then marginalised.", expr, rfactorisation: rf, completeCases: false, availableCases: false };
    }

    const t1r = theorem1(graph, T, S, sep, opts);
    // a single factor recovered on its own is that recovery, not a factorisation
    if (t1r && t1r.steps.length === 1 && !t1r.helpers.length && t1r.steps[0].sub) {
      const sub = t1r.steps[0].sub;
      return { ...out, recoverable: true, method: sub.method, reason: sub.reason, expr: sub.expr, trace: sub.trace, completeCases: false, availableCases: false };
    }
    if (t1r) return { ...out, recoverable: true, method: "Theorem 1", reason: "An admissible ordered factorisation in which some factors are recovered on their own.", expr: t1r.expr, factorisation: t1r, completeCases: false, availableCases: false };

    // recovery by intervention on the indicators (Section 3.3, Example 6)
    if (MG.causal && !opts.quick && [...S].every((v) => !Rs.has(v))) {
      const viaR = MG.causal.interventionRoute(graph, [...T], [], [...S]);
      if (viaR) return { ...out, recoverable: true, method: "intervention", reason: `Intervening on ${viaR.R.join(", ")} turns the query into an identification problem that the ID algorithm solves (Section 3.3).`, expr: viaR.expr, trace: viaR.trace, completeCases: false, availableCases: false };
    }
    // mixed reasoning: do-calculus on parts of the query, variables treated as observed or as proxies
    if (MG.hybrid && opts.deep && !opts.noHybrid && !(opts.depth > 0)) {
      const ent = (v) => [v, v];
      const h = MG.hybrid.recoverPlain(graph, [...T].map(ent), [...S].map(ent));
      if (h) return { ...out, recoverable: true, method: "do-calculus", reason: "Parts of the query are turned into interventions (Rule 2) and identified in a graph where some partially observed variables appear only through their proxies; each resulting term is then recovered (as in Appendix A.2).", expr: h.expr, hybridSteps: h.steps, completeCases: false, availableCases: false };
    }
    // P(T | S) = P(T, S) / P(S) when both are recoverable
    const depth = opts.depth || 0;
    if (S.size && !opts.quick && depth < (opts.maxDepth ?? 2)) {
      const sub = { ...opts, depth: depth + 1, ignoreTheorem3: false };
      const both = recover(graph, [...T, ...S], [], sub);
      const marg = both.recoverable === true ? recover(graph, [...S], [], sub) : null;
      if (both.recoverable === true && marg && marg.recoverable === true) {
        return { ...out, recoverable: true, method: "ratio", reason: `P(${[...T, ...S].join(", ")}) and P(${[...S].join(", ")}) are both recoverable, so their ratio is.`, expr: E().frac(both.expr, marg.expr), parts: [both, marg], completeCases: false, availableCases: false };
      }
    }
    return { ...out, recoverable: null, method: null, reason: "None of the graphical criteria in Sections 3.1–3.2 recovers this query, and Theorem 3 does not prove it non-recoverable. It may still be recoverable through intervention (Section 3.3) or with assumptions beyond the graph (Section 3.4)." };
  }

  /** Theorem 2's own statement, for the joint distribution: its precondition and conditions. */
  function theorem2(graph) {
    const adm = MG.ADMG.project(graph);
    const { Vo, Vm, R: Rs } = sets(graph);
    const rEdges = [];
    for (const a of Rs) for (const b of Rs) if (a < b && adm.adjacent(a, b)) rEdges.push([a, b]);
    const violations = [];
    for (const X of MG.sorted(Vm)) {
      const rx = R(X);
      if (adm.adjacent(X, rx)) violations.push({ variable: X, condition: 1, text: `${X} and ${rx} are neighbours` });
      else {
        const p = adm.colliderPaths(X, rx, new Set([...Vm, ...Vo]));
        if (p.length) violations.push({ variable: X, condition: 2, path: p[0], text: `${X} and ${rx} are joined by ${p[0].join(" ⋯ ")}, all inner nodes colliders` });
      }
    }
    return {
      applies: rEdges.length === 0,
      edgesBetweenIndicators: rEdges,
      violations,
      recoverable: rEdges.length === 0 ? violations.length === 0 : violations.length ? false : null,
    };
  }

  // ---------------------------------------------------------------- Section 4: testability

  /**
   * Untestable claims (Theorem 4: X ⊥⊥ R_X | Z, W, R_Z with X, Z partially observed, W fully
   * observed) that the graph makes, and the testability of the v-MAR and MCAR claims
   * (Theorem 6, Corollary 3) with the tests they imply.
   */
  function testability(graph, catalogue = new MG.Catalogue(graph)) {
    const { Vo, Vm, R: Rs } = sets(graph);
    const untestable = [];
    for (const X of MG.sorted(Vm)) {
      const p = catalogue.pair(X, R(X));
      if (!p) continue;
      for (const z of p.separators) {
        const zs = [...z];
        const partial = zs.filter((n) => Vm.has(n));
        // Theorem 4's form: the other conditioning variables are partially observed with their
        // indicators present, or fully observed
        const form = zs.every((n) => Vo.has(n) || Vm.has(n) || Rs.has(n)) && partial.every((n) => z.has(R(n)));
        untestable.push({ statement: new MG.Statement([X], [R(X)], z), theorem4: form });
      }
    }
    const k = Vm.size;
    const vmarTests = [];
    const mcarTests = [];
    for (const A of MG.sorted(Vm)) for (const B of MG.sorted(Vm)) if (A !== B) {
      vmarTests.push(new MG.Statement([A], [R(B)], [...Vo, R(A)]));
      mcarTests.push(new MG.Statement([A], [R(B)], [R(A)]));
    }
    for (const C of MG.sorted(Vo)) for (const A of MG.sorted(Vm)) mcarTests.push(new MG.Statement([C], [R(A)], []));
    return {
      untestable,
      vmar: { testable: k > 1, tests: vmarTests, text: k > 1 ? `With ${k} partially observed variables, v-MAR is testable (Theorem 6).` : "With one partially observed variable, v-MAR cannot be tested (Theorem 6)." },
      mcar: { testable: k > 0 && k + Vo.size >= 2, tests: mcarTests, text: k + Vo.size >= 2 ? "MCAR is testable (Corollary 3)." : "MCAR cannot be tested (Corollary 3)." },
    };
  }

  function queryText(target, given) {
    return given.length ? `P(${target.join(", ")} | ${given.join(", ")})` : `P(${target.join(", ")})`;
  }

  MG.missing = { sets, classify, recover, theorem1, theorem2, theorem3, rFactorisation, corollary2, testability, column, indicatorsOf, queryText, makeSep };
})(globalThis.MG);
