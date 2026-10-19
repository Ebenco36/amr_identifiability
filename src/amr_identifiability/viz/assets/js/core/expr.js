/* MG.expr: probability expressions (estimands) as trees.
 *
 * Values are written with symbols. A symbol is the name of a substantive variable (Y, X, ...)
 * and stands for its value; sums range over the symbol's values. Each term says which observed
 * column carries the symbol, so the same tree can be printed and evaluated on data:
 *
 *   {t: "P", vars: [[column, value]], given: [[column, value]], do: [[column, value]]}
 *       value is a symbol (string) or a constant (number, e.g. R_X = 0)
 *   {t: "sum", over: [symbol], body}
 *   {t: "prod", factors: [...]}
 *   {t: "frac", num, den}
 *   {t: "one"}
 *
 * Example: P(Y* = y | X* = x, R_X = 0, R_Y = 0) is
 *   P([["Y_star", "Y"]], [["X_star", "X"], ["R_X", 0], ["R_Y", 0]])
 * Python's amr_identifiability.estimand.evaluate computes these trees on a probability table.
 */
(function (MG) {
  "use strict";

  const ONE = Object.freeze({ t: "one" });

  function P(vars, given = [], doSet = []) {
    return { t: "P", vars: norm(vars), given: norm(given), do: norm(doSet) };
  }

  function norm(list) {
    return list.map((x) => (Array.isArray(x) ? [x[0], x[1]] : [x, x]));
  }

  function sum(over, body) {
    over = [...over];
    if (!over.length) return body;
    if (body.t === "one") return body;
    if (body.t === "sum") return { t: "sum", over: [...over, ...body.over], body: body.body };
    return { t: "sum", over, body };
  }

  function prod(...factors) {
    const flat = [];
    for (const f of factors.flat()) {
      if (!f || f.t === "one") continue;
      if (f.t === "prod") flat.push(...f.factors);
      else flat.push(f);
    }
    if (!flat.length) return ONE;
    if (flat.length === 1) return flat[0];
    return { t: "prod", factors: flat };
  }

  function frac(num, den) {
    if (den.t === "one") return num;
    return { t: "frac", num, den };
  }

  // ---------------------------------------------------------------- inspection

  /** Symbols that are free (not bound by a sum). */
  function freeSymbols(e, bound = new Set()) {
    const out = new Set();
    const visit = (x, b) => {
      if (x.t === "P") for (const list of [x.vars, x.given, x.do]) for (const [, v] of list) if (typeof v === "string" && !b.has(v)) out.add(v);
      if (x.t === "sum") visit(x.body, new Set([...b, ...x.over]));
      if (x.t === "prod") x.factors.forEach((f) => visit(f, b));
      if (x.t === "frac") {
        visit(x.num, b);
        visit(x.den, b);
      }
    };
    visit(e, bound);
    return out;
  }

  function hasDo(e) {
    if (e.t === "P") return e.do.length > 0;
    if (e.t === "sum") return hasDo(e.body);
    if (e.t === "prod") return e.factors.some(hasDo);
    if (e.t === "frac") return hasDo(e.num) || hasDo(e.den);
    return false;
  }

  /** Every observed column the expression reads. */
  function columns(e, out = new Set()) {
    if (e.t === "P") for (const list of [e.vars, e.given, e.do]) for (const [c] of list) out.add(c);
    if (e.t === "sum") columns(e.body, out);
    if (e.t === "prod") e.factors.forEach((f) => columns(f, out));
    if (e.t === "frac") {
      columns(e.num, out);
      columns(e.den, out);
    }
    return out;
  }

  // ---------------------------------------------------------------- rendering

  const STAR = MG.PROXY_SUFFIX;

  /** Column name in the paper's notation: Y_star -> Y*. */
  function colName(c) {
    return c.endsWith(STAR) ? c.slice(0, -STAR.length) + "*" : c;
  }

  /** A term entry: "Y*" when the column carries its own symbol, "R_X = 0" for a constant. */
  function entry([c, v], { values = false } = {}) {
    const name = colName(c);
    if (typeof v === "number") return `${name} = ${v}`;
    const base = c.endsWith(STAR) ? c.slice(0, -STAR.length) : c;
    if (v === base && !values) return name;
    return `${name} = ${v.toLowerCase ? v.toLowerCase() : v}`;
  }

  function toText(e, opts = {}) {
    switch (e.t) {
      case "one":
        return "1";
      case "P": {
        const given = [...e.given.map((x) => entry(x, opts))];
        const left = e.vars.map((x) => entry(x, opts)).join(", ");
        const doPart = e.do.length ? `do(${e.do.map((x) => entry(x, opts)).join(", ")})` : null;
        const right = [doPart, ...given].filter(Boolean).join(", ");
        return right ? `P(${left} | ${right})` : `P(${left})`;
      }
      case "sum":
        return `Σ_{${e.over.join(", ")}} ${wrap(e.body, opts, "sum")}`;
      case "prod":
        return e.factors.map((f) => wrap(f, opts, "prod")).join(" ");
      case "frac":
        return `${wrap(e.num, opts, "frac")} / ${wrap(e.den, opts, "frac")}`;
      default:
        throw new Error(`unknown expression ${e.t}`);
    }
  }

  function wrap(e, opts, ctx) {
    const s = toText(e, opts);
    if (e.t === "P" || e.t === "one") return s;
    if (ctx === "sum" && e.t === "prod") return s;
    if (ctx === "prod" && e.t === "sum") return `[${s}]`;
    return `(${s})`;
  }

  /** Plain-ASCII form for files and the PDF: "sum_{a} P(Y* | X*, R_X = 0)". */
  function toAscii(e) {
    return toText(e).replace(/Σ_/g, "sum_").replace(/·/g, "*");
  }

  /** LaTeX, for papers. */
  function toLatex(e) {
    const name = (c) => {
      const star = c.endsWith(STAR);
      let base = star ? c.slice(0, -STAR.length) : c;
      base = base.replace(/^R_(.+)$/, "R_{$1}").replace(/^([A-Za-z]+)(\d+)$/, "$1_{$2}");
      return star ? `${base}^{*}` : base;
    };
    const ent = ([c, v]) => (typeof v === "number" ? `${name(c)}=${v}` : name(c));
    const go = (x, ctx) => {
      switch (x.t) {
        case "one":
          return "1";
        case "P": {
          const left = x.vars.map(ent).join(", ");
          const right = [x.do.length ? `\\mathrm{do}(${x.do.map(ent).join(", ")})` : null, ...x.given.map(ent)].filter(Boolean).join(", ");
          return right ? `P(${left} \\mid ${right})` : `P(${left})`;
        }
        case "sum":
          return `\\sum_{${x.over.map((s) => name(s).toLowerCase()).join(", ")}} ${go(x.body, "sum")}`;
        case "prod":
          return x.factors.map((f) => (f.t === "sum" ? `\\left[${go(f)}\\right]` : go(f))).join("\\,");
        case "frac":
          return `\\frac{${go(x.num)}}{${go(x.den)}}`;
      }
      return "";
    };
    return go(e);
  }

  /** The closed-form estimator: each P term becomes a ratio of counts (Remark 1 of the paper). */
  function estimatorText(e) {
    const count = (list) => `#(${list.map((x) => entry(x)).join(", ")})`;
    const go = (x) => {
      switch (x.t) {
        case "one":
          return "1";
        case "P":
          return x.given.length ? `${count([...x.vars, ...x.given])} / ${count(x.given)}` : `${count(x.vars)} / N`;
        case "sum":
          return `Σ_{${x.over.join(", ")}} ${go(x.body)}`;
        case "prod":
          return x.factors.map((f) => `[${go(f)}]`).join(" · ");
        case "frac":
          return `(${go(x.num)}) / (${go(x.den)})`;
      }
      return "";
    };
    return go(e);
  }

  // ---------------------------------------------------------------- simplification

  const key = (e) => JSON.stringify(e);

  /** Symbols a term depends on (free in it). */
  function deps(e) {
    return freeSymbols(e);
  }

  /**
   * Algebraic tidying that never changes the value:
   *   Σ_A P(A | B) ... = ...           when the symbols A appear in no other factor and not in B
   *   Σ_S c · f = c · Σ_S f            factors that do not depend on S leave the sum
   *   (c · a) / (c · b) = a / b        common factors cancel
   *   x / 1 = x
   */
  function simplify(e) {
    const go = (x) => {
      switch (x.t) {
        case "sum": {
          const body = go(x.body);
          let over = x.over.slice();
          const factors = body.t === "prod" ? body.factors.slice() : [body];
          // Σ_A P(A | B) = 1 when the symbols A are summed, appear nowhere else, and every proxy in
          // A has its indicator fixed at 0 in B (a proxy also takes the value "missing")
          let changed = true;
          while (changed) {
            changed = false;
            for (let i = 0; i < factors.length; i++) {
              const f = factors[i];
              if (f.t !== "P" || f.do.length || !f.vars.length) continue;
              const outs = f.vars.map(([, v]) => v);
              if (!outs.every((v) => typeof v === "string" && over.includes(v))) continue;
              if (new Set(outs).size !== outs.length) continue;
              if (f.given.some(([, v]) => outs.includes(v))) continue;
              const proxyOk = f.vars.every(([c]) => !c.endsWith(STAR) || f.given.some(([g, v]) => g === MG.R_PREFIX + c.slice(0, -STAR.length) && v === 0));
              if (!proxyOk) continue;
              if (factors.some((g, j) => j !== i && outs.some((v) => deps(g).has(v)))) continue;
              factors.splice(i, 1);
              over = over.filter((v) => !outs.includes(v));
              changed = true;
              break;
            }
          }
          const used = new Set();
          for (const f of factors) for (const v of deps(f)) used.add(v);
          // a summed symbol that nothing uses would multiply by its number of values: keep as is
          if (over.some((v) => !used.has(v))) return { t: "sum", over: x.over, body };
          // factors that do not depend on the summed symbols leave the sum
          const outside = factors.filter((f) => ![...deps(f)].some((v) => over.includes(v)));
          const inside = factors.filter((f) => !outside.includes(f));
          return prod(...outside, over.length ? sum(over, prod(...inside)) : prod(...inside));
        }
        case "prod":
          return prod(...x.factors.map(go));
        case "frac": {
          const num = go(x.num), den = go(x.den);
          if (den.t === "one") return num;
          let nf = num.t === "prod" ? num.factors.slice() : [num];
          let df = den.t === "prod" ? den.factors.slice() : [den];
          for (let i = nf.length - 1; i >= 0; i--) {
            const j = df.findIndex((d) => key(d) === key(nf[i]));
            if (j >= 0) {
              nf.splice(i, 1);
              df.splice(j, 1);
            }
          }
          const n2 = prod(...nf), d2 = prod(...df);
          if (key(n2) === key(d2)) return ONE;
          return frac(n2, d2);
        }
        default:
          return x;
      }
    };
    let prev, cur = e;
    for (let k = 0; k < 6 && key(cur) !== prev; k++) {
      prev = key(cur);
      cur = go(cur);
    }
    return cur;
  }

  /** Rename summation symbols that shadow a symbol of an enclosing scope: X -> X′. */
  function tidy(e) {
    const go = (x, inScope) => {
      if (x.t === "sum") {
        const ren = {};
        const over = x.over.map((s) => {
          if (!inScope.has(s)) return s;
          let n = s + "′";
          while (inScope.has(n)) n += "′";
          ren[s] = n;
          return n;
        });
        let body = Object.keys(ren).length ? renameFree(x.body, ren) : x.body;
        return { ...x, over, body: go(body, new Set([...inScope, ...over])) };
      }
      if (x.t === "prod") return { ...x, factors: x.factors.map((f) => go(f, inScope)) };
      if (x.t === "frac") return { ...x, num: go(x.num, inScope), den: go(x.den, inScope) };
      return x;
    };
    return go(e, freeSymbols(e));
  }

  /** Rename free occurrences of symbols (bound ones are left alone). */
  function renameFree(e, map) {
    const go = (x, bound) => {
      const val = (v) => (typeof v === "string" && !bound.has(v) && map[v] !== undefined ? map[v] : v);
      if (x.t === "P") {
        const f = (list) => list.map(([c, v]) => [c, val(v)]);
        return { ...x, vars: f(x.vars), given: f(x.given), do: f(x.do) };
      }
      if (x.t === "sum") return { ...x, body: go(x.body, new Set([...bound, ...x.over])) };
      if (x.t === "prod") return { ...x, factors: x.factors.map((f) => go(f, bound)) };
      if (x.t === "frac") return { ...x, num: go(x.num, bound), den: go(x.den, bound) };
      return x;
    };
    return go(e, new Set());
  }

  /** The form shown to people: simplified, with shadowed sum variables renamed. */
  function present(e) {
    return tidy(simplify(e));
  }

  MG.expr = { P, sum, prod, frac, ONE, freeSymbols, hasDo, columns, toText, toAscii, toLatex, estimatorText, colName, simplify, tidy, present, renameFree };
})(globalThis.MG);
