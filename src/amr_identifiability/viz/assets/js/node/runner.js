/* Node entry point: load the shared core and render modules, then run one job from stdin.
 *
 *   node runner.js <module files...> < job.json
 *
 * Jobs (job.action):
 *   "analyse"  catalogue, recovery and self-masking for each model, for the parity tests
 *   "figure"   a figure as SVG or PDF, for Explorer.save() in Python
 */
"use strict";
const fs = require("fs");
const vm = require("vm");

for (const file of process.argv.slice(2)) vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
const MG = globalThis.MG;
const job = JSON.parse(fs.readFileSync(0, "utf8"));

const setList = (s) => MG.sorted(s);

function analyse(model) {
  const g = MG.Graph.fromPayload(model);
  const cat = new MG.Catalogue(g);
  const pairs = cat.pairs.map((p) => ({
    x: p.x,
    y: p.y,
    adjacent: p.adjacent,
    separators: p.separators.map(setList),
    testable: p.testable.map(setList),
  }));
  const localMarkov = {};
  for (const n of cat.nodes) {
    const lm = cat.localMarkov(n);
    localMarkov[n] = lm ? lm.toString() : null;
  }
  const out = { key: model.key, pairs, localMarkov, selfMasking: g.selfMasking(), validate: g.validate() };
  out.rFactorisation = MG.recovery.rFactorisationProblems(g);
  if (g.partiallyObserved.has("Yk")) {
    out.recovery = MG.recovery
      .findRecovery(g, "Yk", { maxCovariates: 3, limit: 5 })
      .map((r) => ({ order: r.order, covariates: r.covariates, functional: r.functional }));
  }
  if (job.statements) {
    out.statements = job.statements.map((t) => {
      const s = MG.Statement.parse(t);
      try {
        s.check(g);
      } catch (e) {
        return null;
      }
      const implied = MG.dsep.implies(g, s);
      let open = null;
      if (s.x.size === 1 && s.y.size === 1) open = MG.dsep.paths(g, [...s.x][0], [...s.y][0], s.z, { onlyOpen: true, maxPaths: 1, maxLength: 64 }).paths.length;
      return { implied, open, testable: MG.Statement.testable(g, s), recorded: MG.Statement.recordedForm(g, s) };
    });
  }
  return out;
}

function figure() {
  const model = job.model || { ...MG.parse.graphText(job.text, { name: job.name }).spec, key: "text" };
  const g = MG.Graph.fromPayload(model);
  const positions = new Map(model.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const hidden = new Set(job.hiddenRoles || []);
  let highlight = null;
  const caption = [];
  if (job.statement) {
    const s = MG.Statement.parse(job.statement).check(g);
    const implied = MG.dsep.implies(g, s);
    const openEdges = new Set();
    let openCount = 0, truncated = false;
    if (!implied) {
      for (const a of s.x) for (const b of s.y) {
        const r = MG.dsep.paths(g, a, b, s.z, { onlyOpen: true, maxPaths: 200 });
        openCount += r.paths.length;
        truncated = truncated || r.truncated;
        for (const p of r.paths) for (let i = 0; i < p.path.length - 1; i++) {
          const [u, v] = p.forward[i] ? [p.path[i], p.path[i + 1]] : [p.path[i + 1], p.path[i]];
          openEdges.add(MG.scene.edgeKey(u, v));
        }
      }
    }
    highlight = { x: s.x, y: s.y, z: s.z, openEdges, dim: job.dim !== false };
    caption.push(...MG.scene.statementCaption(g, s, { implied, openCount, truncated }));
  }
  const scene = MG.scene.buildScene({ graph: g, positions, hiddenRoles: hidden, highlight, legend: job.legend !== false, title: job.title || null, caption: job.caption === false ? [] : caption, spacing: job.spacing === undefined ? "auto" : job.spacing });
  if (job.format === "svg") return MG.svgWriter.toSvg(scene, { title: job.title || g.name });
  if (job.format === "pdf") return MG.pdfWriter.toPdf(scene, { title: job.title || g.name });
  throw new Error(`unknown figure format ${job.format}`);
}

function parseTexts() {
  return job.texts.map((t) => {
    try {
      const r = MG.parse.graphText(t);
      return { format: r.format, spec: r.spec, warnings: r.warnings };
    } catch (e) {
      return { error: e.message };
    }
  });
}

function gallery() {
  return MG.gallery.ENTRIES.map((e) => {
    const spec = MG.gallery.load(e.key);
    return { key: e.key, group: e.group, name: e.name, expect: e.expect || {}, note: e.note || null, spec };
  });
}

/** A graph from a job: a gallery key, text, or a payload model. */
function graphOf(src) {
  if (src.gallery) return MG.Graph.fromPayload(MG.gallery.load(src.gallery));
  if (src.text) return MG.Graph.fromPayload(MG.parse.graphText(src.text).spec);
  return MG.Graph.fromPayload(src.model);
}

function recoverAll() {
  return job.items.map((item) => {
    const g = graphOf(item);
    const out = { classify: null, theorem2: null, testability: null, results: [] };
    try {
      const c = MG.missing.classify(g);
      out.classify = { mechanism: c.mechanism, mcar: c.mcar, vmar: c.vmar };
      const t2 = MG.missing.theorem2(g);
      out.theorem2 = { applies: t2.applies, recoverable: t2.recoverable, violations: t2.violations.map((v) => v.text) };
      const t = MG.missing.testability(g);
      out.testability = { untestable: t.untestable.map((u) => ({ statement: u.statement.toString(), theorem4: u.theorem4 })), vmar: t.vmar.testable, mcar: t.mcar.testable };
    } catch (e) {
      out.error = e.message;
    }
    for (const q of item.queries || []) {
      try {
        const r = MG.missing.recover(g, q.target, q.given || [], { ignoreTheorem3: !!job.ignoreTheorem3, deep: !!(job.deep || q.deep) });
        const proof = MG.missing.theorem3(g, new Set(q.target), new Set(q.given || []));
        out.results.push({ usesDo: !!(r.rfactorisation && r.rfactorisation.factors.some((f) => f.viaDo)), theorem3: proof ? proof.text : null, target: q.target, given: q.given || [], recoverable: r.recoverable, method: r.method, expr: r.expr || null, text: r.expr ? MG.expr.toText(r.expr) : null, reason: r.reason, completeCases: r.completeCases, availableCases: r.availableCases });
      } catch (e) {
        out.results.push({ target: q.target, given: q.given || [], error: e.message });
      }
    }
    return out;
  });
}

function effects() {
  const setList = (s) => MG.sorted(s);
  return job.items.map((item) => {
    const g = graphOf(item);
    return (item.queries || []).map((q) => {
      try {
        const r = MG.causal.effect(g, q.X, q.Y, q.Z || []);
        const out = { X: r.X, Y: r.Y, Z: r.Z, identifiable: r.identifiable, recoverable: r.recoverable, method: r.method || null,
          expr: r.expr || null, text: r.expr ? MG.expr.toText(r.expr) : null, idExpr: r.idExpr || null,
          hedge: r.hedge ? { F: setList(r.hedge.F), Fprime: setList(r.hedge.Fprime) } : null, trace: (r.trace || []).map((t) => `${t.line}: ${t.text}`) };
        if (r.adjustment) {
          out.adjustment = { exists: r.adjustment.exists, minimal: r.adjustment.minimal.map(setList), optimal: r.adjustment.optimal ? setList(r.adjustment.optimal) : null };
          out.adjustmentExprs = r.adjustment.minimal.map((Zs) => MG.causal.adjustmentFormula(r.X, r.Y, Zs));
          if (r.adjustment.optimal) out.optimalExpr = MG.causal.adjustmentFormula(r.X, r.Y, r.adjustment.optimal);
        }
        if (r.frontDoor) {
          out.frontDoor = r.frontDoor.map(setList);
          out.frontDoorExprs = r.frontDoor.map((M) => MG.causal.frontDoorFormula(r.X[0], r.Y[0], M));
        }
        if (r.instruments) out.instruments = r.instruments;
        return out;
      } catch (e) {
        return { X: q.X, Y: q.Y, Z: q.Z || [], error: e.message };
      }
    });
  });
}

function hybridSteps() {
  const g = graphOf(job);
  const r = MG.hybrid.recoverDo(g, job.A, job.B, job.D || [], job.opts || {});
  return r ? r.steps.map((st) => ({ rule: st.rule, query: st.query, A: st.A, B: st.B, D: st.D, expr: st.expr, text: MG.expr.toText(st.expr) })) : null;
}

function rawIdc() {
  const g = graphOf(job);
  const out = [];
  for (const S of job.observedSets) {
    const O = g.ids.filter((n) => {
      if (g.latent.has(n)) return false;
      if (g.partiallyObserved.has(n)) return S.includes(n);
      if (g.proxies.has(n)) return !S.includes(n.slice(0, -5)) && job.keepProxies.includes(n);
      return true;
    });
    const valueOf = new Map([...job.A, ...job.B, ...job.D]);
    const symbol = (n) => (valueOf.has(n) && typeof valueOf.get(n) === "string" ? valueOf.get(n) : MG.hybrid.defaultSymbol(g, n));
    const constants = Object.fromEntries([...job.A, ...job.B, ...job.D].filter(([, v]) => typeof v === "number"));
    try {
      const r = MG.causal.idc(MG.ADMG.project(g, O), job.A.map(([n]) => n), job.D.map(([n]) => n), job.B.map(([n]) => n), { symbol, constants, rank: (n) => (g.proxies.has(n) ? 1 : 0) });
      out.push({ S, O, expr: r.expr, text: MG.expr.toText(r.expr) });
    } catch (e) {
      out.push({ S, O, error: e.message });
    }
  }
  return out;
}

if (job.action === "rawidc") process.stdout.write(JSON.stringify(rawIdc()));
else if (job.action === "hybrid") process.stdout.write(JSON.stringify(hybridSteps()));
else if (job.action === "latex") process.stdout.write(JSON.stringify(job.exprs.map((e) => MG.expr.toLatex(e))));
else if (job.action === "effect") process.stdout.write(JSON.stringify(effects()));
else if (job.action === "recover") process.stdout.write(JSON.stringify(recoverAll()));
else if (job.action === "analyse") process.stdout.write(JSON.stringify(job.models.map(analyse)));
else if (job.action === "parse") process.stdout.write(JSON.stringify(parseTexts()));
else if (job.action === "gallery") process.stdout.write(JSON.stringify(gallery()));
else if (job.action === "figure") {
  const out = figure();
  process.stdout.write(job.format === "pdf" ? Buffer.from(MG.pdfWriter.toBytes(out)) : out);
}
else throw new Error(`unknown action ${job.action}`);
