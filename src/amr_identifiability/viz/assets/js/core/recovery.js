/* Recoverability checks; mirrors amr_identifiability.recovery.
 *
 * orderedFactorisation  Mohan & Pearl (2021) Theorem 1, checked step by step
 * findRecovery          smallest covariate set, helper set and ordering that recover a target
 * rFactorisationProblems  failures of the sufficient conditions for R-factorisation
 */
(function (MG) {
  "use strict";

  const R = (v) => MG.R_PREFIX + v;

  function combinations(items, k) {
    const out = [];
    const rec = (start, acc) => {
      if (acc.length === k) return out.push(acc.slice());
      for (let i = start; i < items.length; i++) {
        acc.push(items[i]);
        rec(i + 1, acc);
        acc.pop();
      }
    };
    rec(0, []);
    return out;
  }

  function permutations(items) {
    if (items.length <= 1) return [items.slice()];
    const out = [];
    // lexicographic by position, matching itertools.permutations
    const rec = (acc, rest) => {
      if (!rest.length) return out.push(acc);
      for (let i = 0; i < rest.length; i++) rec(acc.concat(rest[i]), rest.slice(0, i).concat(rest.slice(i + 1)));
    };
    rec([], items);
    return out;
  }

  function orderedFactorisation(graph, order, covariates = []) {
    order = order.slice();
    covariates = MG.sorted(covariates);
    if (!order.length) throw new Error("the order must contain at least the target");
    if (new Set(order).size !== order.length) throw new Error("the order repeats a variable");
    const notPartial = order.filter((v) => !graph.partiallyObserved.has(v));
    if (notPartial.length) throw new Error(`variables in the order must be partially observed: ${MG.sorted(notPartial).join(", ")}`);
    const bad = covariates.filter((v) => !graph.fullyObserved.has(v));
    if (bad.length) throw new Error(`covariates must be fully observed: ${MG.sorted(bad).join(", ")}`);
    const steps = order.map((variable, i) => {
      const earlier = order.slice(0, i);
      const given = earlier.concat(covariates);
      const indicators = earlier.concat(variable).map(R);
      const st = new MG.Statement([variable], indicators, given);
      return { variable, given, requires: st, holds: MG.dsep.dSeparated(graph, st.x, st.y, st.z) };
    });
    return makeRecovery(order[order.length - 1], order, covariates, steps);
  }

  function makeRecovery(target, order, covariates, steps) {
    const recoverable = steps.every((s) => s.holds);
    const factors = steps.map((s) => {
      const zeros = MG.sorted(s.requires.y).map((r) => `${r} = 0`);
      return `P(${s.variable} | ${s.given.concat(zeros).join(", ")})`;
    });
    const helpers = order.filter((v) => v !== target);
    const lhs = covariates.length ? `P(${target} | ${covariates.join(", ")})` : `P(${target})`;
    const functional = `${lhs} = ${helpers.length ? `sum over ${helpers.join(", ")} of ` : ""}${factors.join(" * ")}`;
    return { target, order, covariates, steps, recoverable, functional };
  }

  function findRecovery(graph, target, { helpers = null, covariates = null, maxHelpers = 4, maxCovariates = 4, limit = 10 } = {}) {
    if (!graph.partiallyObserved.has(target)) throw new Error(`${target} is not partially observed`);
    const helperPool = MG.sorted(helpers ? new Set(helpers) : [...graph.partiallyObserved].filter((v) => v !== target));
    const covPool = MG.sorted(covariates ? new Set(covariates) : graph.fullyObserved);
    const memo = new Map();
    const sep = (x, ys, zs) => {
      const k = x + "|" + MG.setKey(ys) + "|" + MG.setKey(zs);
      if (!memo.has(k)) memo.set(k, MG.dsep.dSeparated(graph, [x], ys, zs));
      return memo.get(k);
    };
    const found = [];
    let best = null;
    for (let nCov = 0; nCov <= Math.min(maxCovariates, covPool.length); nCov++) {
      for (const cov of combinations(covPool, nCov)) {
        for (let nHelp = 0; nHelp <= Math.min(maxHelpers, helperPool.length); nHelp++) {
          if (best !== null && nCov + nHelp > best) break;
          for (const chosen of combinations(helperPool, nHelp)) {
            const last = sep(target, new Set(chosen.concat(target).map(R)), new Set(chosen.concat(cov)));
            if (!last) continue;
            for (const order of permutations(chosen)) {
              const ok = order.every((v, i) => sep(v, new Set(order.slice(0, i + 1).map(R)), new Set(order.slice(0, i).concat(cov))));
              if (ok) {
                found.push(orderedFactorisation(graph, order.concat(target), cov));
                best = nCov + nHelp;
                break;
              }
            }
            if (found.length >= limit) return found;
          }
        }
      }
      if (best !== null && nCov >= best) break;
    }
    return found;
  }

  function rFactorisationProblems(graph, variables = null) {
    variables = MG.sorted(variables ? new Set(variables) : graph.partiallyObserved);
    const problems = [];
    const masking = graph.selfMasking();
    for (const v of variables) if (masking[v]) problems.push(`self-masking: ${masking[v]}`);
    const indicators = new Set(variables.map(R));
    const ind = MG.sorted(indicators);
    for (const a of ind) for (const b of ind) if (a !== b && graph.hasEdge(a, b)) problems.push(`indicator ${a} is a parent of indicator ${b}`);
    // an all-collider path has exactly one inner node: v -> c <- R_v with c recorded
    const recorded = new Set([...graph.fullyObserved, ...graph.partiallyObserved]);
    for (const v of variables) {
      const r = R(v);
      for (const c of MG.sorted(graph.children(v))) if (graph.children(r).has(c) && recorded.has(c)) problems.push(`all-collider path ${v} - ${c} - ${r}`);
    }
    const links = MG.sorted(graph.latentLinks());
    for (const link of links) {
      const [a, b] = link.split("\u0001");
      if (indicators.has(a) && indicators.has(b)) problems.push(`unrecorded common cause of ${a} and ${b}`);
    }
    return problems;
  }

  MG.recovery = { orderedFactorisation, findRecovery, rFactorisationProblems };
})(globalThis.MG);
