/* Automatic layout for graphs that come without coordinates.
 *
 * A compact layered (Sugiyama-style) layout:
 *   1. layers by longest path from the sources, so every edge points downward
 *   2. dummy nodes on long edges, then barycentre sweeps to reduce crossings
 *   3. x positions pulled towards the neighbours' median, keeping a minimum gap
 * Proxies are placed one layer below the lower of their two parents, so each sits under its
 * variable and indicator.
 */
(function (MG) {
  "use strict";

  function layered(ids, edges, { layerGap = 115, nodeGap = 34, roleOf = () => "fully observed" } = {}) {
    const parents = new Map(ids.map((n) => [n, []]));
    const children = new Map(ids.map((n) => [n, []]));
    for (const [a, b] of edges) {
      children.get(a).push(b);
      parents.get(b).push(a);
    }
    // 1. layers
    const order = topo(ids, parents, children);
    const layer = new Map();
    for (const n of order) layer.set(n, Math.max(-1, ...parents.get(n).map((p) => layer.get(p))) + 1);
    // pull sources down towards their children, so roots do not all crowd the top row
    for (const n of order.slice().reverse()) {
      const ch = children.get(n);
      if (ch.length && !parents.get(n).length) layer.set(n, Math.min(...ch.map((c) => layer.get(c))) - 1);
    }
    const nLayers = Math.max(0, ...layer.values()) + 1;

    // 2. dummy chains for edges that skip layers
    const rows = Array.from({ length: nLayers }, () => []);
    for (const n of order) rows[layer.get(n)].push(n);
    const up = new Map(ids.map((n) => [n, []]));
    const down = new Map(ids.map((n) => [n, []]));
    let dummy = 0;
    const isDummy = new Set();
    for (const [a, b] of edges) {
      let prev = a;
      for (let l = layer.get(a) + 1; l < layer.get(b); l++) {
        const d = `\u0000d${dummy++}`;
        isDummy.add(d);
        rows[l].push(d);
        up.set(d, [prev]);
        down.set(d, []);
        down.get(prev).push(d);
        prev = d;
      }
      down.get(prev).push(b);
      up.get(b).push(prev);
    }
    const pos = new Map();
    const reindex = () => rows.forEach((r) => r.forEach((n, i) => pos.set(n, i)));
    reindex();
    const bary = (n, nbrs) => {
      const list = nbrs.get(n);
      return list.length ? list.reduce((s, m) => s + pos.get(m), 0) / list.length : pos.get(n);
    };
    for (let it = 0; it < 12; it++) {
      const downward = it % 2 === 0;
      const seq = downward ? rows.slice(1) : rows.slice(0, -1).reverse();
      for (const r of seq) {
        const keyed = r.map((n) => [bary(n, downward ? up : down), pos.get(n), n]);
        keyed.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
        r.splice(0, r.length, ...keyed.map((k) => k[2]));
        r.forEach((n, i) => pos.set(n, i));
      }
    }

    // 3. coordinates
    const width = (n) => (isDummy.has(n) ? 10 : MG.geometry ? MG.geometry.nodeLayout(n, roleOf(n)).w : 60);
    const x = new Map();
    for (const r of rows) {
      let cursor = 0;
      for (const n of r) {
        const w = width(n);
        x.set(n, cursor + w / 2);
        cursor += w + nodeGap;
      }
      const shift = cursor / 2;
      for (const n of r) x.set(n, x.get(n) - shift);
    }
    for (let it = 0; it < 24; it++) {
      for (const r of it % 2 ? rows : rows.slice().reverse()) {
        const target = r.map((n) => {
          const nb = [...up.get(n), ...down.get(n)].map((m) => x.get(m)).sort((p, q) => p - q);
          return nb.length ? (nb[(nb.length - 1) >> 1] + nb[nb.length >> 1]) / 2 : x.get(n);
        });
        r.forEach((n, i) => x.set(n, x.get(n) * 0.5 + target[i] * 0.5));
        // restore order and gaps, left to right then right to left
        for (let i = 1; i < r.length; i++) {
          const min = x.get(r[i - 1]) + (width(r[i - 1]) + width(r[i])) / 2 + nodeGap;
          if (x.get(r[i]) < min) x.set(r[i], min);
        }
        for (let i = r.length - 2; i >= 0; i--) {
          const max = x.get(r[i + 1]) - (width(r[i + 1]) + width(r[i])) / 2 - nodeGap;
          if (x.get(r[i]) > max) x.set(r[i], max);
        }
      }
    }
    const out = new Map();
    for (const n of ids) out.set(n, { x: +x.get(n).toFixed(1), y: layer.get(n) * layerGap });
    return out;
  }

  function topo(ids, parents, children) {
    const indeg = new Map(ids.map((n) => [n, parents.get(n).length]));
    const queue = ids.filter((n) => !indeg.get(n));
    const out = [];
    while (queue.length) {
      const n = queue.shift();
      out.push(n);
      for (const c of children.get(n)) {
        indeg.set(c, indeg.get(c) - 1);
        if (!indeg.get(c)) queue.push(c);
      }
    }
    if (out.length !== ids.length) throw new Error("the graph has a cycle");
    return out;
  }

  /**
   * The nearest free spot to (x, y): tries rings of candidate offsets until the node's box
   * (with a margin) overlaps no placed node. `placed` is a list of {id, x, y}.
   */
  function freeSpot(placed, x, y, { id = "", w = 70, h = 34, margin = 16, roleOf = () => "fully observed" } = {}) {
    const size = (n) => (MG.geometry ? MG.geometry.nodeLayout(n.id, roleOf(n.id)) : { w: 60, h: 30 });
    const mine = MG.geometry && id ? MG.geometry.nodeLayout(id, roleOf(id)) : { w, h };
    const clear = (cx, cy) => placed.every((n) => {
      if (!Number.isFinite(n.x)) return true;
      const o = size(n);
      return Math.abs(n.x - cx) >= (o.w + mine.w) / 2 + margin || Math.abs(n.y - cy) >= (o.h + mine.h) / 2 + margin;
    });
    if (clear(x, y)) return { x, y };
    for (let ring = 1; ring <= 12; ring++) {
      const r = ring * 46;
      const steps = 8 * ring;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * 2 * Math.PI + Math.PI / 2; // start below
        const cx = x + Math.cos(a) * r * 1.4, cy = y + Math.sin(a) * r;
        if (clear(cx, cy)) return { x: +cx.toFixed(1), y: +cy.toFixed(1) };
      }
    }
    return { x, y };
  }

  MG.layout = { layered, freeSpot };
})(globalThis.MG);
