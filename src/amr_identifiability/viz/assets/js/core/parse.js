/* Read a user's graph from text: DAGitty, Graphviz (digraph), JSON, or a plain edge list.
 *
 *   MG.parse.graphText(text, {name}) -> {spec, format, warnings}
 *
 * spec is the model format the explorer uses everywhere:
 *   {name, nodes: [{id, latent, x?, y?, exposure?, outcome?, adjusted?, description?}], edges: [[a, b]]}
 *
 * A bidirected edge a <-> b (an unrecorded common cause) becomes a latent node L_a_b with
 * edges to a and b, as in the Python reader. Names that the statement syntax cannot carry
 * (spaces, commas, |) are rewritten with underscores, with a warning.
 */
(function (MG) {
  "use strict";

  class ParseError extends Error {}

  function graphText(text, { name = "" } = {}) {
    const t = String(text || "").replace(/^﻿/, "").trim();
    if (!t) throw new ParseError("the text is empty");
    let out;
    if (/^\s*[{[]/.test(t)) out = { ...json(t), format: "JSON" };
    else if (/^\s*(strict\s+)?(di)?graph\b[^{]*\{/i.test(t)) out = { ...graphviz(t), format: "Graphviz" };
    else if (/^\s*(dag|pdag|mag|pag)\s*(\w+\s*)?\{/i.test(t)) out = { ...dagitty(t), format: "DAGitty" };
    else out = { ...edgeList(t), format: "edge list" };
    out.spec.name = name || out.spec.name || "Imported graph";
    finish(out);
    return out;
  }

  // ---------------------------------------------------------------- tokenizer shared by DAGitty and Graphviz

  function tokenize(body) {
    const tokens = [];
    // a name may contain "-" except where it starts an edge operator (A->B without spaces)
    const re = /\s+|\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"\\]|\\.)*)"|(<->|->|<-|--|\[|\]|\{|\}|;|,|=)|([^\s\[\]{};,="<>\-](?:[^\s\[\]{};,="<>\-]|-(?![>-]))*)/gy;
    let m;
    re.lastIndex = 0;
    while (re.lastIndex < body.length) {
      const start = re.lastIndex;
      m = re.exec(body);
      if (!m) throw new ParseError(`cannot read the text near: ${body.slice(start, start + 30)}`);
      if (m[1] !== undefined) tokens.push({ t: "name", v: m[1].replace(/\\"/g, '"'), quoted: true });
      else if (m[2]) tokens.push({ t: m[2] });
      else if (m[3]) tokens.push({ t: "name", v: m[3] });
    }
    return tokens;
  }

  /** Statements: node lists joined by edge operators, with an optional [attribute list]. */
  function statements(tokens) {
    const out = [];
    let i = 0;
    const readGroup = () => {
      if (tokens[i] && tokens[i].t === "{") {
        i++;
        const names = [];
        while (i < tokens.length && tokens[i].t !== "}") {
          if (tokens[i].t === "name") names.push(tokens[i].v);
          else if (tokens[i].t !== "," && tokens[i].t !== ";") throw new ParseError(`unexpected "${tokens[i].t}" inside { }`);
          i++;
        }
        if (tokens[i] && tokens[i].t === "}") i++;
        return names;
      }
      if (tokens[i] && tokens[i].t === "name") return [tokens[i++].v];
      return null;
    };
    while (i < tokens.length) {
      if (tokens[i].t === ";" || tokens[i].t === ",") {
        i++;
        continue;
      }
      const first = readGroup();
      if (!first) throw new ParseError(`unexpected "${tokens[i].t === "name" ? tokens[i].v : tokens[i].t}"`);
      if (tokens[i] && tokens[i].t === "=") {
        // a graph setting such as rankdir=LR or bb="..."; not a node
        i += 2;
        continue;
      }
      const parts = [first];
      const ops = [];
      while (tokens[i] && ["->", "<-", "<->", "--"].includes(tokens[i].t)) {
        ops.push(tokens[i++].t);
        const next = readGroup();
        if (!next) throw new ParseError(`an edge "${ops[ops.length - 1]}" has nothing after it`);
        parts.push(next);
      }
      let attrs = null;
      if (tokens[i] && tokens[i].t === "[") {
        i++;
        attrs = {};
        while (i < tokens.length && tokens[i].t !== "]") {
          if (tokens[i].t === "name") {
            const key = tokens[i++].v.toLowerCase();
            if (tokens[i] && tokens[i].t === "=") {
              i++;
              attrs[key] = tokens[i] ? tokens[i++].v : "";
            } else attrs[key] = true;
          } else i++;
        }
        i++;
      }
      out.push({ parts, ops, attrs });
    }
    return out;
  }

  function collect(stmts, { allowUndirected = false } = {}) {
    const nodes = new Map();
    const edges = [];
    const bidirected = [];
    const add = (id) => {
      if (!nodes.has(id)) nodes.set(id, { id });
      return nodes.get(id);
    };
    for (const s of stmts) {
      if (!s.ops.length) {
        for (const id of s.parts[0]) {
          const n = add(id);
          if (s.attrs) applyAttrs(n, s.attrs);
        }
        continue;
      }
      for (let k = 0; k < s.ops.length; k++) {
        const op = s.ops[k];
        for (const a of s.parts[k]) for (const b of s.parts[k + 1]) {
          add(a);
          add(b);
          if (op === "->") edges.push([a, b]);
          else if (op === "<-") edges.push([b, a]);
          else if (op === "<->") bidirected.push([a, b]);
          else if (!allowUndirected) throw new ParseError(`undirected edge ${a} -- ${b}: an m-graph needs every edge directed (use -> or <->)`);
          else edges.push([a, b]);
        }
      }
    }
    return { nodes, edges, bidirected };
  }

  function applyAttrs(n, attrs) {
    if (attrs.latent || attrs.unobserved) n.latent = true;
    if (attrs.exposure) n.exposure = true;
    if (attrs.outcome) n.outcome = true;
    if (attrs.adjusted) n.adjusted = true;
    if (typeof attrs.pos === "string") {
      const m = attrs.pos.match(/^\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*!?\s*$/);
      if (m) {
        n.x = parseFloat(m[1]);
        n.y = parseFloat(m[2]);
      }
    }
    if (typeof attrs.label === "string" && attrs.label) n.description = attrs.label;
  }

  // ---------------------------------------------------------------- formats

  function dagitty(t) {
    const open = t.indexOf("{"), close = t.lastIndexOf("}");
    if (open < 0 || close < open) throw new ParseError("DAGitty text needs { ... } around the graph");
    const kind = t.slice(0, open).trim().split(/\s+/)[0].toLowerCase();
    if (kind !== "dag") throw new ParseError(`"${kind}" graphs are not DAGs; only "dag { }" can be an m-graph`);
    const body = t.slice(open + 1, close);
    const { nodes, edges, bidirected } = collect(statements(tokenize(body)));
    // DAGitty labels may be written as "X: description"
    const rename = new Map();
    for (const id of nodes.keys()) {
      const m = id.match(/^([^:]+):\s*(.+)$/);
      if (m) rename.set(id, { id: m[1].trim(), description: m[2].trim() });
    }
    return build(nodes, edges, bidirected, rename, { positions: "dagitty" });
  }

  function graphviz(t) {
    const open = t.indexOf("{"), close = t.lastIndexOf("}");
    const head = t.slice(0, open).trim();
    if (!/digraph/i.test(head)) throw new ParseError("an undirected 'graph { }' cannot be an m-graph; use 'digraph { }'");
    const body = t.slice(open + 1, close);
    const stmts = statements(tokenize(body)).filter((s) => !(s.ops.length === 0 && ["graph", "node", "edge"].includes(s.parts[0][0])));
    const { nodes, edges, bidirected } = collect(stmts);
    return build(nodes, edges, bidirected, new Map(), { positions: "graphviz" });
  }

  function json(t) {
    let data;
    try {
      data = JSON.parse(t);
    } catch (e) {
      throw new ParseError(`not valid JSON: ${e.message}`);
    }
    if (Array.isArray(data)) data = { edges: data };
    const nodes = new Map();
    for (const n of data.nodes || []) {
      const node = typeof n === "string" ? { id: n } : { ...n, id: String(n.id ?? n.name) };
      if (!node.id || node.id === "undefined") throw new ParseError("every node needs an id");
      nodes.set(node.id, { id: node.id, latent: !!node.latent, x: num(node.x), y: num(node.y), description: node.description || node.label || undefined, exposure: !!node.exposure, outcome: !!node.outcome });
    }
    for (const l of data.latent || []) {
      if (!nodes.has(l)) nodes.set(l, { id: l });
      nodes.get(l).latent = true;
    }
    const edges = [], bidirected = [];
    for (const e of data.edges || []) {
      let a, b, type = "->";
      if (Array.isArray(e)) [a, b, type = "->"] = e;
      else {
        a = e.from ?? e.source;
        b = e.to ?? e.target;
        type = e.type || (e.bidirected ? "<->" : "->");
      }
      if (a === undefined || b === undefined) throw new ParseError("every edge needs two ends");
      a = String(a);
      b = String(b);
      for (const id of [a, b]) if (!nodes.has(id)) nodes.set(id, { id });
      if (type === "<->" || type === "bidirected") bidirected.push([a, b]);
      else edges.push([a, b]);
    }
    return build(nodes, edges, bidirected, new Map(), { positions: "json", name: data.name });
  }

  function edgeList(t) {
    const nodes = new Map();
    const edges = [], bidirected = [];
    const lines = t.split(/\r?\n/);
    let header = true;
    lines.forEach((raw, k) => {
      const line = raw.replace(/(#|\/\/).*$/, "").trim();
      if (!line) return;
      let m;
      if ((m = line.match(/^(.+?)\s*(<->|->|<-|--)\s*(.+?)\s*;?$/))) {
        const [, a, op, b] = m;
        const A = a.replace(/^"|"$/g, "").trim(), B = b.replace(/^"|"$/g, "").trim();
        for (const id of [A, B]) if (!nodes.has(id)) nodes.set(id, { id });
        if (op === "->") edges.push([A, B]);
        else if (op === "<-") edges.push([B, A]);
        else if (op === "<->") bidirected.push([A, B]);
        else throw new ParseError(`line ${k + 1}: undirected edge; use -> or <->`);
      } else if ((m = line.split(/\s*[,\t]\s*/)).length >= 2) {
        if (header && /^(from|source|parent|cause)$/i.test(m[0]) && /^(to|target|child|effect)$/i.test(m[1])) {
          header = false;
          return;
        }
        const [A, B] = m.map((s) => s.replace(/^"|"$/g, "").trim());
        if (!A || !B) throw new ParseError(`line ${k + 1}: expected "from, to"`);
        for (const id of [A, B]) if (!nodes.has(id)) nodes.set(id, { id });
        const kind = (m[2] || "").toLowerCase();
        if (kind === "<->" || kind === "bidirected") bidirected.push([A, B]);
        else edges.push([A, B]);
      } else if (/^[^\s,]+$/.test(line)) {
        if (!nodes.has(line)) nodes.set(line, { id: line });
      } else throw new ParseError(`line ${k + 1}: expected "A -> B", "A <-> B" or "A, B"`);
      header = false;
    });
    if (!nodes.size) throw new ParseError("no nodes or edges found");
    return build(nodes, edges, bidirected, new Map(), { positions: "none" });
  }

  // ---------------------------------------------------------------- assembling the spec

  function build(nodes, edges, bidirected, rename, { name } = {}) {
    const warnings = [];
    const idMap = new Map();
    const used = new Set();
    for (const id of nodes.keys()) {
      let clean = (rename.get(id) || { id }).id;
      const safe = clean.replace(/[\s,|]+/g, "_");
      if (safe !== clean) warnings.push(`renamed "${clean}" to ${safe} (names cannot contain spaces, commas or |)`);
      clean = safe;
      if (used.has(clean)) throw new ParseError(`two nodes are both called ${clean}`);
      used.add(clean);
      idMap.set(id, clean);
    }
    const outNodes = [];
    for (const [id, n] of nodes) {
      const r = rename.get(id);
      outNodes.push({ ...n, id: idMap.get(id), description: n.description || (r && r.description) || undefined });
    }
    const outEdges = edges.map(([a, b]) => [idMap.get(a), idMap.get(b)]);
    for (const [a0, b0] of bidirected) {
      const a = idMap.get(a0), b = idMap.get(b0);
      let l = `L_${a}_${b}`;
      for (let k = 2; used.has(l); k++) l = `L_${a}_${b}_${k}`;
      used.add(l);
      outNodes.push({ id: l, latent: true, description: `unrecorded common cause of ${a} and ${b}`, bidirected: [a, b] });
      outEdges.push([l, a], [l, b]);
    }
    const seen = new Set();
    const unique = [];
    for (const e of outEdges) {
      const k = e[0] + "\u0001" + e[1];
      if (e[0] === e[1]) throw new ParseError(`${e[0]} has an edge to itself`);
      if (!seen.has(k)) {
        seen.add(k);
        unique.push(e);
      } else warnings.push(`duplicate edge ${e[0]} -> ${e[1]} ignored`);
    }
    return { spec: { name, nodes: outNodes, edges: unique }, warnings };
  }

  /** Checks shared by every format: acyclic, proxies present for every indicator, positions. */
  function finish(out) {
    const spec = out.spec;
    const ids = new Set(spec.nodes.map((n) => n.id));
    // every R_X with X present needs the proxy X_star (the paper often leaves proxies out of the figure)
    for (const n of spec.nodes.slice()) {
      if (!n.id.startsWith(MG.R_PREFIX)) continue;
      const v = n.id.slice(MG.R_PREFIX.length);
      if (!ids.has(v)) {
        out.warnings.push(`${n.id} looks like a missingness indicator but there is no variable ${v}; it is treated as an ordinary node`);
        continue;
      }
      const star = v + MG.PROXY_SUFFIX;
      if (!ids.has(star)) {
        spec.nodes.push({ id: star, description: `recorded proxy of ${v} (added: ${v} when ${n.id} = 0, missing otherwise)`, added: true });
        spec.edges.push([v, star], [n.id, star]);
        ids.add(star);
        out.warnings.push(`added the proxy ${star} with edges ${v} -> ${star} and ${n.id} -> ${star}`);
      }
    }
    new MG.Graph({ nodes: spec.nodes, edges: spec.edges, latent: spec.nodes.filter((n) => n.latent).map((n) => n.id) }); // throws on a cycle
    placeNodes(spec);
  }

  /** Give every node page coordinates: rescale given positions, lay out the rest. */
  function placeNodes(spec) {
    const given = spec.nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
    const missing = spec.nodes.filter((n) => !(Number.isFinite(n.x) && Number.isFinite(n.y)));
    // nodes added here (proxies, latent common causes) go next to the nodes they belong to
    const parentsOf = (id) => spec.edges.filter((e) => e[1] === id).map((e) => e[0]);
    const childrenOf = (id) => spec.edges.filter((e) => e[0] === id).map((e) => e[1]);
    const placeable = (n) => {
      const anchors = (n.latent ? childrenOf(n.id) : parentsOf(n.id)).map((id) => spec.nodes.find((m) => m.id === id));
      return anchors.length && anchors.every((m) => m && Number.isFinite(m.x));
    };
    if (given.length > 1 && missing.length && missing.every(placeable)) {
      rescale(given);
      for (const n of missing) {
        const anchors = (n.latent ? childrenOf(n.id) : parentsOf(n.id)).map((id) => spec.nodes.find((m) => m.id === id));
        const cx = anchors.reduce((s, m) => s + m.x, 0) / anchors.length;
        const cy = anchors.reduce((s, m) => s + m.y, 0) / anchors.length;
        const role = roleFinder(spec);
        const spot = MG.layout.freeSpot(spec.nodes.filter((m) => m !== n), cx + (n.latent ? 0 : 26), cy + (n.latent ? -62 : 78), { id: n.id, roleOf: role });
        n.x = spot.x;
        n.y = spot.y;
      }
      return;
    }
    if (given.length === spec.nodes.length && given.length > 1) {
      rescale(given);
      return;
    }
    if (given.length === spec.nodes.length && given.length === 1) {
      given[0].x = 0;
      given[0].y = 0;
      return;
    }
    const pos = MG.layout.layered(spec.nodes.map((n) => n.id), spec.edges, { roleOf: roleFinder(spec) });
    for (const n of spec.nodes) {
      const p = pos.get(n.id);
      n.x = p.x;
      n.y = p.y;
    }
  }

  /** Scale given coordinates so the median nearest-neighbour distance is about 120 px. */
  function rescale(given) {
    const d = given.map((a) => Math.min(...given.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y))));
    d.sort((p, q) => p - q);
    const med = d[Math.floor(d.length / 2)] || 1;
    const s = 120 / med;
    for (const n of given) {
      n.x = +(n.x * s).toFixed(1);
      n.y = +(n.y * s).toFixed(1);
    }
  }

  function roleFinder(spec) {
    const g = new MG.Graph({ nodes: spec.nodes, edges: spec.edges, latent: spec.nodes.filter((n) => n.latent).map((n) => n.id) });
    return (id) => g.role(id);
  }

  function num(v) {
    return v === undefined || v === null || v === "" ? undefined : +v;
  }

  /**
   * Quick links typed by hand: "A -> B", "A <- B", "A <-> B", chains "A -> B -> C", groups
   * "X -> {R_Y W}", and bare names (a node with no edge yet), separated by new lines, ";" or ",".
   * Returns {nodes, edges, bidirected} in the order written; nothing is checked against a graph.
   */
  function links(text) {
    if (!text || !text.trim()) throw new ParseError("type a link such as  X -> R_Y  or  U <-> Y");
    const { nodes, edges, bidirected } = collect(statements(tokenize(text)));
    return { nodes: [...nodes.keys()], edges, bidirected };
  }

  MG.parse = { graphText, ParseError, placeNodes, links };
})(globalThis.MG);
