/* MG.Statement: the independence X _||_ Y | Z, with parsing, testability and the recorded form.
 * Mirrors amr_identifiability.mgraph.Independence and MGraph.is_testable / recorded_form.
 */
(function (MG) {
  "use strict";

  const SEPARATORS = /\s*(?:_\|\|_|⊥⊥|⫫|⊥)\s*/;

  class Statement {
    constructor(x, y, z = []) {
      this.x = new Set(x);
      this.y = new Set(y);
      this.z = new Set(z);
    }

    /** Parse "X, Y _||_ Z | A, B". Also accepts ⊥⊥ or ⫫ in place of _||_. */
    static parse(text) {
      const t = String(text || "").trim();
      const m = t.split(SEPARATORS);
      if (m.length !== 2) throw new Error("write it as  X _||_ Y | Z");
      const [left, rest] = m;
      const bar = rest.indexOf("|");
      const right = bar === -1 ? rest : rest.slice(0, bar);
      const given = bar === -1 ? "" : rest.slice(bar + 1);
      const names = (s) => s.split(/[,\s]+/).filter(Boolean);
      const x = names(left), y = names(right);
      if (!x.length || !y.length) throw new Error("both sides of _||_ need at least one variable");
      return new Statement(x, y, names(given));
    }

    /** Like parse, but never throws: missing parts come back empty (for building a query). */
    static parseLoose(text) {
      const t = String(text || "").trim();
      const names = (s) => s.split(/[,\s]+/).filter(Boolean);
      const m = t.split(SEPARATORS);
      if (m.length < 2) return new Statement(names(t.split("|")[0]), [], []);
      const rest = m.slice(1).join(" ");
      const bar = rest.indexOf("|");
      return new Statement(names(m[0]), names(bar === -1 ? rest : rest.slice(0, bar)), bar === -1 ? [] : names(rest.slice(bar + 1)));
    }

    /** Text for a possibly incomplete statement. */
    toLooseString() {
      const f = (s) => MG.sorted(s).join(", ");
      let t = `${f(this.x)} _||_ ${f(this.y)}`.trim();
      if (this.z.size) t += ` | ${f(this.z)}`;
      return t;
    }

    get involved() {
      return new Set([...this.x, ...this.y, ...this.z]);
    }

    /** Check against a graph: unknown nodes and overlaps. Throws with a readable message. */
    check(graph) {
      graph.require(this.involved);
      const both = [...this.x].filter((n) => this.y.has(n));
      if (both.length) throw new Error(`${MG.sorted(both).join(", ")} on both sides`);
      const zx = [...this.z].filter((n) => this.x.has(n) || this.y.has(n));
      if (zx.length) throw new Error(`${MG.sorted(zx).join(", ")} is also conditioned on`);
      return this;
    }

    toString() {
      const f = (s) => MG.sorted(s).join(", ");
      const head = `${f(this.x)} _||_ ${f(this.y)}`;
      return this.z.size ? `${head} | ${f(this.z)}` : head;
    }

    /** Typeset form for the screen. */
    pretty() {
      const f = (s) => MG.sorted(s).join(", ");
      const head = `${f(this.x)} ⊥⊥ ${f(this.y)}`;
      return this.z.size ? `${head} | ${f(this.z)}` : head;
    }

    key() {
      return this.toString();
    }

    equals(other) {
      return other && MG.setEq(this.x, other.x) && MG.setEq(this.y, other.y) && MG.setEq(this.z, other.z);
    }
  }

  /** Sufficient condition for testability (Mohan & Pearl 2014); mirrors MGraph.is_testable. */
  Statement.testable = function (graph, s) {
    return Statement.whyNotTestable(graph, s) === null;
  };

  Statement.whyNotTestable = function (graph, s) {
    const involved = s.involved;
    const latent = [...involved].filter((n) => graph.latent.has(n));
    if (latent.length) return `involves latent ${MG.sorted(latent).join(", ")}`;
    const proxies = [...involved].filter((n) => graph.proxies.has(n));
    if (proxies.length) return `involves proxy ${MG.sorted(proxies).join(", ")}; use the variable and its indicator instead`;
    const needed = [...involved].filter((n) => graph.partiallyObserved.has(n)).map((n) => MG.R_PREFIX + n);
    const own = needed.filter((r) => s.x.has(r) || s.y.has(r));
    if (own.length)
      return `${MG.sorted(own).map((r) => r.slice(MG.R_PREFIX.length)).join(", ")} is only recorded where ${MG.sorted(own).join(", ")} = 0, so its independence from its own indicator cannot be checked in recorded data`;
    const missing = needed.filter((r) => !s.z.has(r));
    if (missing.length) return `needs ${MG.sorted(missing).join(", ")} in the conditioning set`;
    return null;
  };

  Statement.recordedForm = function (graph, s) {
    if (!Statement.testable(graph, s)) return null;
    const rename = (n) => (graph.partiallyObserved.has(n) ? n + MG.PROXY_SUFFIX : n);
    const fixed = new Set([...s.involved].filter((n) => graph.partiallyObserved.has(n)).map((n) => MG.R_PREFIX + n));
    const fmt = (nodes) => MG.sorted([...nodes].map(rename)).join(", ");
    const rest = [...s.z].filter((n) => !fixed.has(n));
    const given = rest.length ? [fmt(rest)] : [];
    for (const r of MG.sorted(fixed)) given.push(`${r} = 0`);
    const head = `${fmt(s.x)} _||_ ${fmt(s.y)}`;
    return given.length ? `${head} | ${given.join(", ")}` : head;
  };

  MG.Statement = Statement;
})(globalThis.MG);
