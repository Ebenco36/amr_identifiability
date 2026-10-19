/* Typeset probability expressions (MG.expr trees) as HTML: stacked fractions, Σ with the summed
 * variables underneath, proxies as X*, indicators as R with a subscript. */
(function (MG) {
  "use strict";
  const { h } = MG.ui;
  const STAR = MG.PROXY_SUFFIX;

  /** A variable or column name: R_X -> R with subscript X; X_star -> X*; Yj1 -> Yj1. */
  function name(c, { lower = false } = {}) {
    let star = false;
    if (c.endsWith(STAR)) {
      star = true;
      c = c.slice(0, -STAR.length);
    }
    const primes = (c.match(/′+$/) || [""])[0];
    c = c.slice(0, c.length - primes.length).replace(/~\d+$/, "");
    const base = lower ? c.toLowerCase() : c;
    const m = base.match(/^([Rr])_(.+)$/);
    const parts = m ? [m[1], h("sub", null, m[2])] : [base];
    return h("span", { class: "mv" }, ...parts, star ? h("sup", null, "*") : null, primes || null);
  }

  /** An entry inside P(...): "Y*", "R_X = 0", or "X = x′" when the symbol differs. */
  function entry([c, v]) {
    if (typeof v === "number") return h("span", { class: "me" }, name(c), " = ", String(v));
    const base = c.endsWith(STAR) ? c.slice(0, -STAR.length) : c;
    if (v === base) return name(c);
    return h("span", { class: "me" }, name(c), " = ", name(v, { lower: true }));
  }

  function join(items) {
    const out = [];
    items.forEach((it, i) => {
      if (i) out.push(h("span", { class: "mc" }, ", "));
      out.push(it);
    });
    return out;
  }

  function render(e) {
    switch (e.t) {
      case "one":
        return h("span", null, "1");
      case "P": {
        const right = [];
        if (e.do.length) right.push(h("span", null, "do(", ...join(e.do.map(entry)), ")"));
        right.push(...e.given.map(entry));
        return h("span", { class: "mp" }, h("span", { class: "mP" }, "P"), "(", ...join(e.vars.map(entry)), right.length ? h("span", { class: "mbar" }, " | ") : null, ...join(right), ")");
      }
      case "sum":
        return h("span", { class: "ms" },
          h("span", { class: "msig" }, h("span", { class: "msym" }, "Σ"), h("span", { class: "msub" }, ...join(e.over.map((s) => name(s, { lower: true }))))),
          wrapSum(e.body));
      case "prod":
        return h("span", { class: "mprod" }, ...e.factors.map((f) => (f.t === "sum" ? h("span", { class: "mgroup" }, "[", render(f), "]") : render(f))));
      case "frac":
        return h("span", { class: "mfrac" }, h("span", { class: "mnum" }, render(e.num)), h("span", { class: "mden" }, render(e.den)));
    }
    return h("span", null, "?");
  }

  function wrapSum(body) {
    return render(body);
  }

  /** A typeset formula with copy buttons for text and LaTeX. */
  function formula(e, { lhs = null } = {}) {
    const box = h("div", { class: "formula-box" },
      h("div", { class: "math" }, lhs ? [h("span", { class: "mlhs" }, lhs), h("span", { class: "meq" }, " = ")] : null, render(e)),
      h("div", { class: "formula-tools" },
        h("button", { class: "btn small", onClick: () => MG.ui.copyText(MG.expr.toText(e)) }, MG.ui.icon("copy"), "Text"),
        h("button", { class: "btn small", onClick: () => MG.ui.copyText(MG.expr.toLatex(e)) }, MG.ui.icon("copy"), "LaTeX"),
        h("details", { class: "estimator" }, h("summary", null, "Estimator from counts"),
          h("p", { class: "muted" }, "Replace each probability by its sample frequency (Remark 1): # counts records with those values; N is the number of records."),
          h("div", { class: "mono", style: { overflowWrap: "anywhere" } }, MG.expr.estimatorText(e)))));
    return box;
  }

  /** A query such as P(Y | do(X), Z) as typeset text. */
  function query(target, given = [], doSet = []) {
    return render(MG.expr.P(target, [...given], [...doSet]));
  }

  MG.ui.math = { render, formula, name, query };
})(globalThis.MG);
