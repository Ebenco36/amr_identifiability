/* Figure scenes: a flat list of drawing primitives that the SVG and PDF writers both consume.
 *
 *   {kind: "path", d, fill, stroke, width, dash, opacity}
 *   {kind: "text", x, y, text, size, bold, fill, anchor, opacity}   y is the baseline
 *
 * buildScene takes plain data (graph, positions, highlight) and has no DOM dependency, so the
 * same code runs in the browser and in Node for figure export from Python.
 */
(function (MG) {
  "use strict";

  const G = () => MG.geometry;
  const edgeKey = (a, b) => a + "\u0001" + b;

  /**
   * @param {object} o
   * @param {MG.Graph} o.graph
   * @param {Map<string,{x:number,y:number}>} o.positions
   * @param {Set<string>} [o.hiddenRoles]
   * @param {object} [o.highlight]  {x, y, z: Set; openEdges, focusEdges: Set of edge keys; blockers: Set; dim: bool}
   * @param {boolean} [o.legend]
   * @param {string} [o.title]
   * @param {string[]} [o.caption]  lines of caption text
   */
  function buildScene({ graph, positions, hiddenRoles = new Set(), highlight = null, legend = true, title = null, caption = [], spacing = 1, palette = MG.palette.figure }) {
    const pal = palette;
    const items = [];
    const visible = graph.ids.filter((id) => !hiddenRoles.has(graph.role(id)) && positions.has(id));
    const layouts = new Map(visible.map((id) => [id, G().nodeLayout(id, graph.role(id))]));
    const factor = spacing === "auto" ? compactFactor(visible, positions, layouts) : +spacing || 1;
    if (factor !== 1) positions = new Map(visible.map((id) => [id, { x: positions.get(id).x * factor, y: positions.get(id).y * factor }]));

    // bounds of the drawn graph
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of visible) {
      const p = positions.get(id), l = layouts.get(id);
      minX = Math.min(minX, p.x - l.w / 2 - 12);
      maxX = Math.max(maxX, p.x + l.w / 2 + 12);
      minY = Math.min(minY, p.y - l.h / 2 - 14);
      maxY = Math.max(maxY, p.y + l.h / 2 + 8);
    }
    if (!visible.length) minX = minY = 0, maxX = maxY = 100;

    const M = 28;
    const graphW = maxX - minX;
    const titleH = title ? 30 : 0;
    const legendItems = legend ? legendEntries(graph, hiddenRoles) : [];
    const width = Math.max(graphW + 2 * M, legend ? 420 : 0);
    const textWidth = width - 2 * M;
    const capLines = [];
    for (const line of caption || []) for (const l of MG.metrics.wrap(line, 11.5, textWidth)) capLines.push(l);
    const legendRows = layoutLegend(legendItems, textWidth);
    const ox = M - minX + (width - 2 * M - graphW) / 2;
    const oy = M + titleH - minY;
    const graphBottom = maxY + oy;
    let y = graphBottom + 18;
    const capY = y;
    y += capLines.length ? capLines.length * 16 + 8 : 0;
    const legendY = y;
    y += legendRows.length ? legendRows.length * 24 + 4 : 0;
    const height = y + M - 14;

    const pos = (id) => ({ x: positions.get(id).x + ox, y: positions.get(id).y + oy });
    const hl = highlight || {};
    const inStatement = (id) => (hl.x && hl.x.has(id)) || (hl.y && hl.y.has(id)) || (hl.z && hl.z.has(id));
    const onOpen = new Set();
    for (const k of hl.openEdges || []) k.split("\u0001").forEach((n) => onOpen.add(n));
    for (const k of hl.focusEdges || []) k.split("\u0001").forEach((n) => onOpen.add(n));
    const dimNode = (id) => hl.dim && !inStatement(id) && !onOpen.has(id);

    items.push({ kind: "path", d: rect(0, 0, width, height), fill: pal.ground, stroke: null });
    if (title) items.push({ kind: "text", x: M, y: M + 12, text: title, size: 15, bold: true, fill: pal.ink, anchor: "start" });

    // edges: normal first, then highlighted ones on top
    const edges = graph.edges.filter(([a, b]) => layouts.has(a) && layouts.has(b));
    const ordered = edges.slice().sort((e1, e2) => rank(e1) - rank(e2));
    function rank([a, b]) {
      const k = edgeKey(a, b);
      return (hl.focusEdges && hl.focusEdges.has(k) ? 2 : 0) + (hl.openEdges && hl.openEdges.has(k) ? 1 : 0);
    }
    for (const [a, b] of ordered) {
      const k = edgeKey(a, b);
      const geo = G().edgeGeometry({ ...pos(a), layout: layouts.get(a) }, { ...pos(b), layout: layouts.get(b) });
      if (!geo.visible) continue;
      const focus = hl.focusEdges && hl.focusEdges.has(k);
      const open = hl.openEdges && hl.openEdges.has(k);
      const color = focus ? pal.focus : open ? pal.open : pal.edge;
      const dim = hl.dim && !open && !focus;
      const opacity = dim ? 0.22 : 1;
      items.push({ kind: "path", d: [["M", geo.x1, geo.y1], ["L", geo.x2, geo.y2]], fill: null, stroke: color, width: open || focus ? 2.6 : 1.3, opacity });
      items.push({ kind: "path", d: geo.head, fill: color, stroke: null, opacity });
    }

    // nodes
    for (const id of visible) {
      const l = layouts.get(id);
      const p = pos(id);
      const style = pal.roles[l.role];
      const isZ = hl.z && hl.z.has(id);
      const isXY = (hl.x && hl.x.has(id)) || (hl.y && hl.y.has(id));
      const opacity = dimNode(id) ? 0.3 : 1;
      items.push({
        kind: "path",
        d: G().translate(l.shape.outline, p.x, p.y),
        fill: isZ ? pal.conditionedFill : style.fill,
        stroke: isXY ? pal.ink : isZ ? pal.conditionedFill : style.stroke,
        width: isXY ? 2.6 : 1.5,
        dash: l.role === "latent" && !isZ ? style.dash : null,
        opacity,
      });
      if (l.shape.inner)
        items.push({ kind: "path", d: G().translate(l.shape.inner, p.x, p.y), fill: null, stroke: isZ ? pal.conditionedText : style.stroke, width: 1, opacity });
      items.push({ kind: "text", x: p.x, y: p.y + 4.6, text: id, size: G().LABEL_SIZE, bold: false, fill: isZ ? pal.conditionedText : pal.ink, anchor: "middle", opacity });
      if (hl.blockers && hl.blockers.has(id)) {
        items.push({ kind: "path", d: G().translate(roundedOutline(l.w + 8, l.h + 8), p.x, p.y), fill: null, stroke: pal.focus, width: 1.4, dash: [3, 2.5], opacity });
      }
      const badge = hl.x && hl.x.has(id) ? "X" : hl.y && hl.y.has(id) ? "Y" : hl.z && hl.z.has(id) ? "Z" : null;
      if (badge) {
        const bx = p.x + l.w / 2 - 2, by = p.y - l.h / 2 - 2;
        items.push({ kind: "path", d: G().translate(circle(7.5), bx, by), fill: badge === "Z" ? pal.ground : pal.ink, stroke: pal.ink, width: 1.2 });
        items.push({ kind: "text", x: bx, y: by + 3.5, text: badge, size: 9.5, bold: true, fill: badge === "Z" ? pal.ink : pal.ground, anchor: "middle" });
      }
    }

    // caption
    capLines.forEach((line, i) =>
      items.push({ kind: "text", x: M, y: capY + 11 + i * 16, text: line, size: 11.5, bold: i === 0, fill: i === 0 ? pal.ink : pal.muted, anchor: "start" })
    );

    // legend
    legendRows.forEach((row, r) => {
      for (const e of row) {
        const cy = legendY + 10 + r * 24;
        const sample = sampleShape(e, pal);
        for (const s of sample(M + e.x + 13, cy)) items.push(s);
        items.push({ kind: "text", x: M + e.x + 30, y: cy + 4, text: e.label, size: 11, bold: false, fill: pal.muted, anchor: "start" });
      }
    });

    return { width: Math.ceil(width), height: Math.ceil(height), items };
  }

  /**
   * The smallest scale of the layout (node sizes unchanged) at which no two nodes overlap,
   * leaving a gap of at least 14 px, between 0.4 and 1.
   */
  function compactFactor(ids, positions, layouts) {
    const fits = (f) => {
      for (let i = 0; i < ids.length; i++) {
        const a = positions.get(ids[i]), la = layouts.get(ids[i]);
        for (let j = i + 1; j < ids.length; j++) {
          const b = positions.get(ids[j]), lb = layouts.get(ids[j]);
          const dx = Math.abs(a.x - b.x) * f, dy = Math.abs(a.y - b.y) * f;
          if (dx < (la.w + lb.w) / 2 + 14 && dy < (la.h + lb.h) / 2 + 14) return false;
        }
      }
      return true;
    };
    if (!fits(1)) return 1;
    let lo = 0.4, hi = 1;
    if (fits(lo)) return lo;
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return Math.round(hi * 1000) / 1000;
  }

  function legendEntries(graph, hiddenRoles) {
    const roles = MG.ROLES.filter((r) => !hiddenRoles.has(r) && graph.ids.some((id) => graph.role(id) === r));
    return roles.map((r) => ({ type: "role", role: r, label: r }));
  }

  function layoutLegend(entries, maxWidth) {
    const rows = [];
    let row = [], x = 0;
    for (const e of entries) {
      const w = 34 + MG.metrics.textWidth(e.label, 11) + 18;
      if (row.length && x + w > maxWidth) {
        rows.push(row);
        row = [];
        x = 0;
      }
      row.push({ ...e, x });
      x += w;
    }
    if (row.length) rows.push(row);
    return rows;
  }

  function sampleShape(entry, pal) {
    return (cx, cy) => {
      const style = pal.roles[entry.role];
      const shape = G().nodeShape(entry.role, 24, 14);
      const out = [{ kind: "path", d: G().translate(shape.outline, cx, cy), fill: style.fill, stroke: style.stroke, width: 1.3, dash: style.dash || null }];
      if (shape.inner) out.push({ kind: "path", d: G().translate(G().nodeShape(entry.role, 19, 9).outline, cx, cy), fill: null, stroke: style.stroke, width: 0.9 });
      return out;
    };
  }

  function rect(x, y, w, h) {
    return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
  }

  function circle(r) {
    const k = r * 0.5522847498;
    return [["M", r, 0], ["C", r, k, k, r, 0, r], ["C", -k, r, -r, k, -r, 0], ["C", -r, -k, -k, -r, 0, -r], ["C", k, -r, r, -k, r, 0], ["Z"]];
  }

  function roundedOutline(w, h) {
    return G().nodeShape("fully observed", w, h).outline;
  }

  /** "X _||_ Y | Z" in words, for figure captions (the PDF fonts have no ⊥ glyph). */
  function inWords(text) {
    return String(text).replace(" _||_ ", " independent of ").replace(" | ", " given ");
  }

  /** Caption lines for a figure of one statement; shared by the page and the Python export. */
  function statementCaption(graph, st, { implied, openCount = 0, truncated = false } = {}) {
    const recorded = MG.Statement.recordedForm(graph, st);
    const lines = [`${inWords(st.toString())}: ${implied ? "implied" : "NOT implied"} by ${graph.name}.`];
    lines.push(recorded ? `Testable in recorded data as: ${inWords(recorded)}.` : `Not testable: ${MG.Statement.whyNotTestable(graph, st)}.`);
    lines.push(implied ? "Every path is blocked. X and Y outlined; conditioned nodes (Z) filled."
      : `${openCount}${truncated ? "+" : ""} open path${openCount === 1 ? "" : "s"} in orange. X and Y outlined; conditioned nodes (Z) filled.`);
    return lines;
  }

  MG.scene = { buildScene, edgeKey, compactFactor, statementCaption, inWords };
})(globalThis.MG);
