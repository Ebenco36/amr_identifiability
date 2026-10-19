/* Causal effects: the ID and IDC algorithms, the do-calculus, adjustment, front-door and
 * instrumental variables.
 *
 *   id(admg, Y, X)            Shpitser & Pearl (2006) ID: P(Y | do(X)) as an estimand, or the hedge
 *                             that makes it non-identifiable. Complete for identification.
 *   idc(admg, Y, X, Z)        conditional version: P(Y | do(X), Z)
 *   doRule(graph, n, ...)     checks Rule 1, 2 or 3 of the do-calculus and says which graph it used
 *   adjustment(graph, X, Y)   generalised adjustment criterion (Shpitser et al. 2010; Perković et
 *                             al. 2018): every minimal adjustment set, a valid set if any exists,
 *                             and the optimal set when there are no latent variables
 *   frontDoor, instruments    Pearl's front-door criterion; conditional instruments
 *   effect(graph, X, Y, Z)    everything above for one query, plus Section 3.5 of Mohan & Pearl
 *                             (2021) when variables are partially observed
 *
 * Estimands are MG.expr trees; the tests evaluate them against truncated factorisation.
 */
(function (MG) {
  "use strict";
  const E = () => MG.expr;

  class NotIdentifiable extends Error {
    constructor(hedge, trace) {
      super(`not identifiable: hedge over {${MG.sorted(hedge.F).join(", ")}} and {${MG.sorted(hedge.Fprime).join(", ")}}`);
      this.hedge = hedge;
      this.trace = trace;
    }
  }

  // ---------------------------------------------------------------- distributions inside ID

  /**
   * A distribution over `scope` given as an expression (null for the observed joint itself).
   * valueOf(v) is the symbol or constant carrying v's value.
   */
  function baseDist(scope) {
    return { scope: new Set(scope), expr: null };
  }

  function marginal(dist, keep, ctx) {
    keep = MG.sorted(keep);
    if (!dist.expr) return E().P(keep.map((v) => ctx.entry(v)));
    const drop = MG.sorted([...dist.scope].filter((v) => !keep.includes(v)));
    return E().sum(drop.map(ctx.sym), dist.expr);
  }

  function conditional(dist, v, prior, ctx) {
    prior = MG.sorted([...prior].filter((p) => dist.scope.has(p) || !dist.expr));
    if (!dist.expr) return E().P([ctx.entry(v)], prior.map((p) => ctx.entry(p)));
    const inScope = prior.filter((p) => dist.scope.has(p));
    const num = marginal(dist, [...inScope, v], ctx);
    const den = marginal(dist, inScope, ctx);
    return E().frac(num, den);
  }

  // ---------------------------------------------------------------- ID

  /**
   * P(Y | do(X)) in the ADMG `G` (observed nodes only; bidirected edges for latent causes).
   * opts.symbol(v): the symbol of v's value (default v); opts.constants: {v: value} for
   * interventions at fixed values (do(R = 0)).
   */
  function id(G, Y, X, opts = {}) {
    const constants = opts.constants || {};
    const symbolOf = opts.symbol || ((v) => v);
    const column = opts.column || ((v) => v);
    // values stay symbolic while the estimand is built (ID sums over some intervened variables
    // after they leave the intervention set, at line 2); fixed values are substituted at the end
    const ctx = {
      sym: (v) => symbolOf(v),
      entry: (v) => [column(v), symbolOf(v)],
    };
    const order = G.topological(opts.rank || null);
    const trace = [];
    let expr = idRec(new Set(Y), new Set(X), baseDist(G.ids), G, order, ctx, trace, 0);
    const fixed = Object.fromEntries(Object.entries(constants).map(([v, c]) => [symbolOf(v), c]));
    if (Object.keys(fixed).length) expr = renameSymbols(expr, fixed);
    return { expr, trace };
  }

  function idRec(Y, X, dist, G, order, ctx, trace, depth) {
    const V = new Set(G.ids);
    const fmt = (s) => `{${MG.sorted(s).join(", ")}}`;
    const note = (line, text) => trace.push({ line, depth, text });
    const priorOf = (v) => {
      const i = order.indexOf(v);
      return order.slice(0, i).filter((u) => V.has(u));
    };

    // line 1
    if (!X.size) {
      note(1, `No intervention left: sum the distribution over ${fmt([...V].filter((v) => !Y.has(v)))}.`);
      return marginal(dist, Y, ctx);
    }
    // line 2
    const anY = G.ancestors(Y);
    if (anY.size < V.size) {
      note(2, `Only ancestors of ${fmt(Y)} matter: drop ${fmt([...V].filter((v) => !anY.has(v)))}.`);
      const sub = G.sub(anY);
      const d2 = { scope: new Set(anY), expr: dist.expr ? marginal(dist, anY, ctx) : null };
      return idRec(Y, new Set([...X].filter((x) => anY.has(x))), d2, sub, order, ctx, trace, depth + 1);
    }
    // line 3
    const anYnoX = G.withoutIncoming(X).ancestors(Y);
    const W = [...V].filter((v) => !X.has(v) && !anYnoX.has(v));
    if (W.length) {
      note(3, `Intervening on ${fmt(W)} changes nothing (they are not ancestors of ${fmt(Y)} once ${fmt(X)} is fixed): add them to the intervention, at any value.`);
      const r3 = idRec(Y, new Set([...X, ...W]), dist, G, order, ctx, trace, depth + 1);
      // the result does not depend on the values given to W; fix them at 0
      return renameSymbols(r3, Object.fromEntries(W.map((w) => [ctx.sym(w), 0])));
    }
    // line 4
    const rest = G.sub([...V].filter((v) => !X.has(v)));
    const C = rest.districts();
    if (C.length > 1) {
      note(4, `G without ${fmt(X)} splits into districts ${C.map(fmt).join(", ")}: identify each, multiply, and sum over ${fmt([...V].filter((v) => !Y.has(v) && !X.has(v)))}.`);
      const parts = C.map((S) => idRec(S, new Set([...V].filter((v) => !S.has(v))), dist, G, order, ctx, trace, depth + 1));
      return E().sum([...V].filter((v) => !Y.has(v) && !X.has(v)).map(ctx.sym), E().prod(...parts));
    }
    const S = C[0];
    const CG = G.districts();
    // line 5
    if (CG.length === 1 && CG[0].size === V.size) {
      note(5, `Hedge: ${fmt(V)} is a single district and so is ${fmt(S)} inside it. The effect is not identifiable.`);
      throw new NotIdentifiable({ F: V, Fprime: S }, trace);
    }
    // line 6
    const same = CG.find((c) => MG.setEq(c, S));
    if (same) {
      note(6, `${fmt(S)} is a district of G: P(${fmt(S)} | do(rest)) is a product of conditionals in topological order.`);
      const factors = order.filter((v) => S.has(v)).map((v) => conditional(dist, v, priorOf(v), ctx));
      return E().sum([...S].filter((v) => !Y.has(v)).map(ctx.sym), E().prod(...factors));
    }
    // line 7
    const bigger = CG.find((c) => MG.subset(S, c));
    if (bigger) {
      note(7, `${fmt(S)} sits inside the district ${fmt(bigger)}: restrict to it and continue with the intervention ${fmt([...X].filter((x) => bigger.has(x)))}.`);
      const factors = order.filter((v) => bigger.has(v)).map((v) => conditional(dist, v, priorOf(v), ctx));
      const d7 = { scope: new Set(bigger), expr: E().prod(...factors) };
      return idRec(Y, new Set([...X].filter((x) => bigger.has(x))), d7, G.sub(bigger), order, ctx, trace, depth + 1);
    }
    throw new Error("ID: no line applies (this cannot happen in an ADMG)");
  }

  /** P(Y | do(X), Z): Shpitser & Pearl (2006b) IDC. */
  function idc(G, Y, X, Z, opts = {}) {
    Y = new Set(Y);
    X = new Set(X);
    Z = new Set(Z);
    const trace = [];
    for (const z of MG.sorted(Z)) {
      const others = new Set([...Z].filter((v) => v !== z));
      const H = G.withoutIncoming(X).withoutOutgoing([z]);
      if (H.separated(Y, [z], new Set([...X, ...others]))) {
        trace.push({ line: "IDC", depth: 0, text: `Rule 2: ${z} can be moved into the intervention, since ${MG.sorted(Y).join(", ")} ⊥⊥ ${z} | ${[...X, ...others].join(", ") || "∅"} once edges into the intervention and out of ${z} are removed.` });
        const r = idc(G, Y, new Set([...X, z]), others, opts);
        return { expr: r.expr, trace: [...trace, ...r.trace] };
      }
    }
    // fixed values of outcomes are substituted after the normalising sum over the outcomes
    const constants = opts.constants || {};
    const symbolOf = opts.symbol || ((v) => v);
    const early = Object.fromEntries(Object.entries(constants).filter(([v]) => !Y.has(v)));
    const late = Object.fromEntries(Object.entries(constants).filter(([v]) => Y.has(v)).map(([v, c]) => [symbolOf(v), c]));
    const joint = id(G, new Set([...Y, ...Z]), X, { ...opts, constants: early });
    let expr = joint.expr;
    if (Z.size) {
      trace.push({ line: "IDC", depth: 0, text: `Identify P(${[...Y, ...Z].join(", ")} | do(${[...X].join(", ")})) and divide by its sum over ${[...Y].join(", ")}.` });
      expr = E().frac(joint.expr, E().sum([...Y].map(symbolOf), joint.expr));
    }
    if (Object.keys(late).length) expr = renameSymbols(expr, late);
    return { expr, trace: [...trace, ...joint.trace] };
  }

  // ---------------------------------------------------------------- do-calculus

  /**
   * Check one rule of the do-calculus on the DAG (latent variables allowed).
   *   rule 1: P(y | do(x), z, w) = P(y | do(x), w)        if Y ⊥⊥ Z | X, W in G_{X̄}
   *   rule 2: P(y | do(x), do(z), w) = P(y | do(x), z, w) if Y ⊥⊥ Z | X, W in G_{X̄ Z̲}
   *   rule 3: P(y | do(x), do(z), w) = P(y | do(x), w)    if Y ⊥⊥ Z | X, W in G_{X̄ Z(W)̄}
   * with Z(W) the nodes of Z that are not ancestors of W in G_{X̄}.
   */
  function doRule(graph, rule, { Y, X = [], Z, W = [] }) {
    Y = new Set(Y); X = new Set(X); Z = new Set(Z); W = new Set(W);
    const cut = (g, intoCut, outCut) => {
      const edges = g.edges.filter(([a, b]) => !intoCut.has(b) && !outCut.has(a));
      return new MG.Graph({ nodes: g.ids.map((id) => g.meta.get(id)), edges, latent: g.latent });
    };
    let H, label;
    if (rule === 1) {
      H = cut(graph, X, new Set());
      label = "G with edges into X removed";
    } else if (rule === 2) {
      H = cut(graph, X, Z);
      label = "G with edges into X and out of Z removed";
    } else {
      const gx = cut(graph, X, new Set());
      const anW = gx.ancestralClosure(W);
      const ZW = new Set([...Z].filter((z) => !anW.has(z)));
      H = cut(graph, new Set([...X, ...ZW]), new Set());
      label = `G with edges into X and into {${MG.sorted(ZW).join(", ")}} removed`;
    }
    const cond = new Set([...X, ...W]);
    const holds = MG.dsep.dSeparated(H, Y, Z, cond);
    return { rule, holds, graph: H, label, statement: new MG.Statement(Y, Z, cond) };
  }

  // ---------------------------------------------------------------- adjustment

  /** Minimal separators between node sets, by contracting each set in the moral graph. */
  function minimalSetSeparators(graph, X, Y, { allowed, included = [], limit = 200 } = {}) {
    X = new Set(X); Y = new Set(Y);
    const inc = new Set(included);
    const anc = graph.ancestralClosure(new Set([...X, ...Y, ...inc]));
    const moral = MG.separators.moralGraph(graph, anc);
    let adj = new Map();
    for (const [n, nb] of moral) if (!inc.has(n)) adj.set(n, new Set([...nb].filter((m) => !inc.has(m))));
    const forbidden = [...adj.keys()].filter((n) => !allowed.has(n) && !X.has(n) && !Y.has(n));
    adj = MG.separators.eliminate(adj, forbidden);
    const contract = (a, S, name) => {
      const out = new Map();
      const nb = new Set();
      for (const s of S) if (a.has(s)) for (const m of a.get(s)) if (!S.has(m)) nb.add(m);
      for (const [n, ns] of a) {
        if (S.has(n)) continue;
        const set = new Set([...ns].filter((m) => !S.has(m)));
        if (nb.has(n)) set.add(name);
        out.set(n, set);
      }
      out.set(name, nb);
      return out;
    };
    adj = contract(adj, X, "\u0000X");
    adj = contract(adj, Y, "\u0000Y");
    const { separators, truncated } = MG.separators.minimalVertexSeparators(adj, "\u0000X", "\u0000Y", limit);
    return { separators: separators.map((s) => new Set([...s, ...inc])), truncated };
  }

  function adjustment(graph, X, Y) {
    X = new Set(X); Y = new Set(Y);
    const gNoInX = new MG.Graph({ nodes: graph.ids.map((i) => graph.meta.get(i)), edges: graph.edges.filter(([, b]) => !X.has(b)), latent: graph.latent });
    const gNoOutX = new MG.Graph({ nodes: graph.ids.map((i) => graph.meta.get(i)), edges: graph.edges.filter(([a]) => !X.has(a)), latent: graph.latent });
    // proper causal paths: nodes that are descendants of X in G_{X̄} (excluding X) and ancestors of Y in G_{X̲}
    const deX = new Set();
    for (const x of X) for (const d of gNoInX.descendants(x)) if (!X.has(d)) deX.add(d);
    const anY = gNoOutX.ancestralClosure(Y);
    const pcp = new Set([...deX].filter((v) => anY.has(v)));
    const dpcp = new Set();
    for (const v of pcp) {
      dpcp.add(v);
      for (const d of graph.descendants(v)) dpcp.add(d);
    }
    const forbidden = new Set([...dpcp, ...X]);
    // proper back-door graph: remove the first edge of every proper causal path
    const pbd = new MG.Graph({ nodes: graph.ids.map((i) => graph.meta.get(i)), edges: graph.edges.filter(([a, b]) => !(X.has(a) && pcp.has(b))), latent: graph.latent });
    const allowed = new Set(graph.ids.filter((v) => !graph.latent.has(v) && !forbidden.has(v) && !Y.has(v)));
    const isValid = (Z) => [...Z].every((z) => allowed.has(z)) && MG.dsep.dSeparated(pbd, X, Y, Z);
    const canonical = new Set([...graph.ancestralClosure(new Set([...X, ...Y]))].filter((v) => allowed.has(v)));
    const exists = isValid(canonical);
    let minimal = [];
    let truncated = false;
    if (exists) {
      const r = minimalSetSeparators(pbd, X, Y, { allowed });
      minimal = r.separators.filter(isValid).sort(MG.compareSets);
      truncated = r.truncated;
    }
    let optimal = null;
    if (exists && !graph.latent.size) {
      // O-set (Henckel, Perković & Maathuis 2022): parents of the causal nodes, minus the forbidden set
      const cn = new Set([...pcp]);
      const O = new Set();
      for (const c of cn) for (const p of graph.parents(c)) if (!forbidden.has(p)) O.add(p);
      if (isValid(O)) optimal = O;
    }
    return { exists, canonical: exists ? canonical : null, minimal, truncated, optimal, forbidden, causalNodes: pcp, isValid, backdoorGraph: pbd };
  }

  /** Σ_z P(y | x, z) P(z): the adjustment formula. */
  function adjustmentFormula(X, Y, Z, column = (v) => v) {
    const ent = (v) => [column(v), v];
    const z = MG.sorted(Z);
    return E().sum(z, E().prod(E().P(MG.sorted(Y).map(ent), [...MG.sorted(X), ...z].map(ent)), z.length ? E().P(z.map(ent)) : E().ONE));
  }

  // ---------------------------------------------------------------- front-door and instruments

  function frontDoor(graph, x, y, { maxSize = 3 } = {}) {
    const obs = graph.ids.filter((v) => !graph.latent.has(v) && v !== x && v !== y);
    const directed = (from, to, blocked) => {
      // is there a directed path from -> to avoiding `blocked`?
      const stack = [from], seen = new Set([from]);
      while (stack.length) for (const c of graph.children(stack.pop())) {
        if (c === to) return true;
        if (!blocked.has(c) && !seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
      return false;
    };
    const backdoorFree = (a, b, Z) => {
      // no open back-door path from a to b given Z: d-separation after removing edges out of a
      const g = new MG.Graph({ nodes: graph.ids.map((i) => graph.meta.get(i)), edges: graph.edges.filter(([p]) => p !== a), latent: graph.latent });
      return MG.dsep.dSeparated(g, [a], [b], Z);
    };
    const found = [];
    const subsets = [];
    const rec = (start, acc) => {
      if (acc.length) subsets.push(acc.slice());
      if (acc.length === maxSize) return;
      for (let i = start; i < obs.length; i++) {
        acc.push(obs[i]);
        rec(i + 1, acc);
        acc.pop();
      }
    };
    rec(0, []);
    for (const M of subsets.sort((a, b) => a.length - b.length)) {
      const Ms = new Set(M);
      if (found.some((f) => MG.subset(f, Ms))) continue;
      if (directed(x, y, Ms)) continue; // (i) M intercepts every directed path
      if (![...Ms].every((m) => backdoorFree(x, m, new Set()))) continue; // (ii)
      if (![...Ms].every((m) => backdoorFree(m, y, new Set([x])))) continue; // (iii)
      if (![...Ms].every((m) => graph.ancestralClosure([y]).has(m) && graph.descendants(x).has(m))) continue;
      found.push(Ms);
    }
    return found;
  }

  function frontDoorFormula(x, y, M) {
    const m = MG.sorted(M);
    const xp = `${x}'`;
    const inner = E().sum([xp], E().prod(E().P([[y, y]], [...m.map((v) => [v, v]), [x, xp]]), E().P([[x, xp]])));
    return E().sum(m, E().prod(E().P(m.map((v) => [v, v]), [[x, x]]), inner));
  }

  /** Conditional instruments Z for x -> y given W (W non-descendants of x and y). */
  function instruments(graph, x, y, { maxW = 2 } = {}) {
    const noOut = new MG.Graph({ nodes: graph.ids.map((i) => graph.meta.get(i)), edges: graph.edges.filter(([a]) => a !== x), latent: graph.latent });
    const desc = new Set([...graph.descendants(x), ...graph.descendants(y), x, y]);
    const cands = graph.ids.filter((v) => !graph.latent.has(v) && !desc.has(v));
    const out = [];
    for (const z of cands) {
      const pool = cands.filter((w) => w !== z);
      const tryW = (W) => MG.dsep.dSeparated(noOut, [z], [y], W) && !MG.dsep.dSeparated(graph, [z], [x], W);
      let found = null;
      const rec = (start, acc) => {
        if (found) return;
        if (tryW(acc)) return (found = acc.slice());
        if (acc.length === maxW) return;
        for (let i = start; i < pool.length; i++) {
          acc.push(pool[i]);
          rec(i + 1, acc);
          acc.pop();
        }
      };
      rec(0, []);
      if (found) out.push({ z, given: found });
    }
    return out;
  }

  // ---------------------------------------------------------------- paths

  /** Causal (directed) paths from X to Y and back-door paths into X. */
  function pathsBetween(graph, x, y, { max = 200 } = {}) {
    const all = MG.dsep.paths(graph, x, y, [], { maxPaths: 2000, maxLength: 12 }).paths;
    const causal = all.filter((p) => p.forward.every(Boolean));
    const backdoor = all.filter((p) => !p.forward[0]);
    const other = all.filter((p) => p.forward[0] && !p.forward.every(Boolean));
    return { causal: causal.slice(0, max), backdoor: backdoor.slice(0, max), other: other.slice(0, max) };
  }

  // ---------------------------------------------------------------- one causal question

  /**
   * P(Y | do(X)[, Z]) in the graph. Without missing data: ID/IDC plus adjustment, front-door
   * and instruments. With partially observed variables (Section 3.5 of Mohan & Pearl 2021):
   * identify in the substantive model and recover each factor, or identify P(Y* | do(X, R = 0), Z*)
   * in the graph where partially observed variables are latent.
   */
  function effect(graph, X, Y, Z = []) {
    X = MG.sorted(new Set(X)); Y = MG.sorted(new Set(Y)); Z = MG.sorted(new Set(Z));
    graph.require([...X, ...Y, ...Z]);
    const both = [...X].filter((v) => Y.includes(v) || Z.includes(v));
    if (both.length) throw new Error(`${both.join(", ")} appears twice`);
    if (!X.length || !Y.length) throw new Error("choose at least one treatment and one outcome");
    for (const v of [...X, ...Y, ...Z]) if (graph.latent.has(v)) throw new Error(`${v} is latent`);
    const missing = graph.partiallyObserved.size > 0;
    const out = { X, Y, Z, missing };

    // a partially observed treatment: identify and recover in one go with the mixed engine
    if (missing && X.some((x) => graph.partiallyObserved.has(x))) {
      const ent = (v) => [v, v];
      const h = MG.hybrid.recoverDo(graph, Y.map(ent), Z.map(ent), X.map(ent));
      const sub = MG.ADMG.project(graph, graph.ids.filter((v) => !graph.latent.has(v) && !graph.indicators.has(v) && !graph.proxies.has(v)));
      try {
        const r = Z.length ? idc(sub, Y, X, Z) : id(sub, Y, X);
        out.identifiable = true;
        out.idExpr = MG.expr.present(r.expr);
        out.trace = r.trace;
      } catch (e) {
        if (e instanceof MG.TimeUp) throw e; // out of time: not a verdict
        if (!(e instanceof NotIdentifiable)) throw e;
        out.identifiable = false;
        out.hedge = e.hedge;
        out.trace = e.trace;
      }
      out.recoverable = h ? true : out.identifiable ? null : false;
      out.method = h ? "do-calculus with a partially observed treatment" : null;
      out.expr = h ? MG.expr.present(h.expr) : null;
      out.hybridSteps = h ? h.steps : null;
      if (!h) out.reason = out.identifiable ? "Identifiable without missing data, but the engine found no way to recover it with the treatment partially observed." : "Not identifiable even without missing data.";
      return out;
    }
    // the substantive model: observed and partially observed variables; indicators and proxies dropped
    const substantive = MG.ADMG.project(graph, graph.ids.filter((v) => !graph.latent.has(v) && !graph.indicators.has(v) && !graph.proxies.has(v)));
    try {
      const r = Z.length ? idc(substantive, Y, X, Z) : id(substantive, Y, X);
      out.identifiable = true;
      out.idExpr = r.expr;
      out.trace = r.trace;
    } catch (e) {
      if (e instanceof MG.TimeUp) throw e; // out of time: not a verdict
      if (!(e instanceof NotIdentifiable)) throw e;
      out.identifiable = false;
      out.hedge = e.hedge;
      out.trace = e.trace;
    }
    const subDag = graph.partiallyObserved.size ? null : graph;
    if (!Z.length && subDag) {
      out.adjustment = adjustment(subDag, X, Y);
      if (out.adjustment.exists) {
        const best = out.adjustment.optimal || out.adjustment.minimal[0] || out.adjustment.canonical;
        out.adjustmentExpr = adjustmentFormula(X, Y, best);
        out.adjustmentSet = best;
      }
      if (X.length === 1 && Y.length === 1) {
        out.frontDoor = frontDoor(subDag, X[0], Y[0]);
        out.instruments = instruments(subDag, X[0], Y[0]);
        out.paths = pathsBetween(subDag, X[0], Y[0]);
      }
    }
    if (out.idExpr) out.idExpr = MG.expr.present(out.idExpr);
    if (!missing) {
      out.recoverable = out.identifiable;
      out.expr = out.idExpr || null;
      out.method = out.identifiable ? "ID" : null;
      return out;
    }

    // Section 3.5: a query not identifiable in the substantive model is not recoverable
    if (!out.identifiable) {
      out.recoverable = false;
      out.method = "not identifiable";
      out.reason = "The effect is not identifiable even without missing data, so it cannot be recovered (Section 3.5).";
      return out;
    }
    // (a) recover every factor of the substantive estimand
    const viaFactors = recoverFactors(graph, out.idExpr);
    if (viaFactors) {
      out.recoverable = true;
      out.method = "identify, then recover each factor";
      out.expr = MG.expr.present(viaFactors.expr);
      out.factorResults = viaFactors.parts;
      return out;
    }
    // (b) identify P(Y* | do(X, R = 0), Z*) where partially observed variables are latent
    const viaR = interventionRoute(graph, Y, X, Z);
    if (viaR) {
      out.recoverable = true;
      out.method = "intervention on the indicators";
      out.expr = MG.expr.present(viaR.expr);
      out.trace = [...(out.trace || []), ...viaR.trace];
      out.interventionSet = viaR.R;
      return out;
    }
    out.recoverable = null;
    out.reason = "Identifiable without missing data, but neither recovering each factor nor intervening on the indicators recovers it.";
    return out;
  }

  /** Replace every P term of a substantive estimand by its recovered form, if all are recoverable. */
  function recoverFactors(graph, expr) {
    const parts = [];
    const memo = new Map();
    const go = (e) => {
      if (e.t === "P") {
        const target = e.vars.map(([c]) => c);
        const given = e.given.map(([c]) => c);
        // symbols in the substantive estimand are the variable names (or a renamed copy, like x')
        const k = JSON.stringify([e.vars, e.given]);
        if (!memo.has(k)) {
          const r = MG.missing.recover(graph, target, given);
          memo.set(k, r);
          parts.push(r);
        }
        const r = memo.get(k);
        if (r.recoverable !== true) throw new Error("factor not recoverable");
        return renameSymbols(r.expr, Object.fromEntries([...e.vars, ...e.given].map(([c, v]) => [c, v])));
      }
      if (e.t === "sum") return { ...e, body: go(e.body) };
      if (e.t === "prod") return { ...e, factors: e.factors.map(go) };
      if (e.t === "frac") return { ...e, num: go(e.num), den: go(e.den) };
      return e;
    };
    try {
      return { expr: go(expr), parts };
    } catch (err) {
      if (err instanceof MG.TimeUp) throw err; // out of time: not a verdict
      return null;
    }
  }

  /**
   * Rename free symbols (a recovered factor uses the variable names as symbols). Bound symbols
   * that would capture a new name are renamed first (alpha-renaming).
   */
  function renameSymbols(e, map) {
    const targets = new Set(Object.values(map).filter((v) => typeof v === "string"));
    let fresh = 0;
    const go = (x, ren) => {
      const val = (v) => (typeof v !== "string" ? v : ren.has(v) ? ren.get(v) : v);
      if (x.t === "P") {
        const f = (list) => list.map(([c, v]) => [c, val(v)]);
        return { ...x, vars: f(x.vars), given: f(x.given), do: f(x.do) };
      }
      if (x.t === "sum") {
        const inner = new Map(ren);
        const over = x.over.map((s) => {
          let name = s;
          if (targets.has(s)) name = `${s}~${++fresh}`;
          inner.set(s, name);
          return name;
        });
        return { ...x, over, body: go(x.body, inner) };
      }
      if (x.t === "prod") return { ...x, factors: x.factors.map((f) => go(f, ren)) };
      if (x.t === "frac") return { ...x, num: go(x.num, ren), den: go(x.den, ren) };
      return x;
    };
    return go(e, new Map(Object.entries(map)));
  }

  /**
   * Recovery by intervention (Section 3.3; Example 6, Example 10): R has no children among the
   * substantive variables, so P(Y | do(X), Z) = P(Y* | do(X), do(R = 0), Z*), which is an
   * identification problem in the graph where partially observed variables are latent.
   * Tries the indicators of the query's variables first, then all indicators.
   */
  function interventionRoute(graph, Y, X, Z, { only = null } = {}) {
    const pm = graph.partiallyObserved;
    if (X.some((x) => pm.has(x))) return null; // a partially observed treatment is handled by MG.hybrid
    // proxies the query does not use are left out (unobserved sinks), so no proxy sits next to an
    // indicator that is not intervened on: that pair would break ID's positivity assumption
    const queried = new Set([...Y, ...Z].filter((v) => pm.has(v)).map((v) => v + MG.PROXY_SUFFIX));
    const keep = graph.ids.filter((v) => !graph.latent.has(v) && !pm.has(v) && (!graph.proxies.has(v) || queried.has(v)));
    const G = MG.ADMG.project(graph, keep);
    const col = (v) => (pm.has(v) ? v + MG.PROXY_SUFFIX : v);
    const needed = [...new Set([...Y, ...Z].filter((v) => pm.has(v)).map((v) => MG.R_PREFIX + v))];
    const all = MG.sorted(graph.indicators);
    const choices = only ? [only] : MG.setKey(new Set(needed)) === MG.setKey(new Set(all)) ? [needed] : [needed, all];
    for (const Rset of choices) {
      const constants = Object.fromEntries(Rset.map((r) => [r, 0]));
      const symbol = (v) => (v.endsWith(MG.PROXY_SUFFIX) && pm.has(v.slice(0, -MG.PROXY_SUFFIX.length)) ? v.slice(0, -MG.PROXY_SUFFIX.length) : v);
      try {
        const Ycols = Y.map(col), Zcols = Z.map(col);
        const r = idc(G, Ycols, [...X, ...Rset], Zcols, { constants, symbol });
        return { expr: r.expr, trace: [{ line: "§3.3", depth: 0, text: `Since no indicator causes a substantive variable, the query equals P(${Ycols.map(MG.expr.colName).join(", ")} | do(${[...X, ...Rset.map((r) => r + " = 0")].join(", ")})${Zcols.length ? ", " + Zcols.map(MG.expr.colName).join(", ") : ""}) in the graph where partially observed variables are latent.` }, ...r.trace], R: Rset };
      } catch (e) {
        if (e instanceof MG.TimeUp) throw e; // out of time: not a verdict
        if (!(e instanceof NotIdentifiable)) throw e;
      }
    }
    return null;
  }

  MG.causal = { renameSymbols, id, idc, NotIdentifiable, doRule, adjustment, adjustmentFormula, minimalSetSeparators, frontDoor, frontDoorFormula, instruments, pathsBetween, effect, interventionRoute, recoverFactors };
})(globalThis.MG);
