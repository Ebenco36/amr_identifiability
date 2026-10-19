/* MG.ui.GraphView: the live, interactive graph.
 *
 * Draws with the same geometry as the figure exporter (MG.geometry) and takes colours from
 * CSS tokens, so it follows the theme. Interaction:
 *   drag background / two-finger scroll   pan          wheel, pinch, ctrl+scroll   zoom
 *   drag a node                            move it      double-click background     fit
 *   click a node                           select       shift+click                 toggle in Z
 *   drag a node's + handle onto a node     join them (any tool but Erase)
 *   Arrow or Common cause tool: drag from anywhere on a node onto another node to join them
 * While a link is dragged, the target is checked with MG.Graph.edgeProblem and the reason is
 * shown before the drop. Node clicks are passed to onNodeClick so the app decides what they mean
 * (select, pick a query slot, join two nodes, or erase).
 */
(function (MG) {
  "use strict";
  const { s, h } = MG.ui;
  const G = MG.geometry;
  const edgeKey = MG.scene.edgeKey;
  const ROLE_CLASS = MG.ui.ROLE_CLASS;

  class GraphView {
    constructor(root, store, { onNodeClick, onEdgeClick, onBackgroundClick, onBackgroundDblClick, onConnect, onConnectToEmpty } = {}) {
      this.root = root;
      this.store = store;
      this.onNodeClick = onNodeClick || (() => {});
      this.onEdgeClick = onEdgeClick || (() => {});
      this.onBackgroundClick = onBackgroundClick || (() => {});
      this.onBackgroundDblClick = onBackgroundDblClick || null;
      this.onConnect = onConnect || (() => {});
      this.onConnectToEmpty = onConnectToEmpty || (() => {});
      this.view = { k: 1, tx: 0, ty: 0 };
      this.nodeEls = new Map();
      this.edgeEls = new Map();
      this._graph = null;
      this._hiddenSig = null;
      this._pointers = new Map();
      this._raf = null;
      this._anim = null;

      this.svg = s("svg", { class: "graph", role: "img", "aria-label": "m-graph" });
      const defs = s("defs");
      defs.appendChild(s("marker", { id: "mg-ghost-head", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, orient: "auto-start-reverse" }, s("path", { d: "M0 0L10 5L0 10Z", style: "fill:var(--accent)" })));
      this.pattern = s("pattern", { id: "mg-dots", width: 22, height: 22, patternUnits: "userSpaceOnUse" }, s("circle", { cx: 1, cy: 1, r: 1, style: "fill:var(--canvas-dot)" }));
      defs.appendChild(this.pattern);
      this.bg = s("rect", { class: "bg", x: 0, y: 0, width: "100%", height: "100%" });
      this.viewport = s("g", { class: "viewport" });
      this.edgeLayer = s("g", { class: "edges" });
      this.nodeLayer = s("g", { class: "nodes" });
      this.ghost = s("path", { class: "ghost", d: "", "marker-end": "url(#mg-ghost-head)" });
      this.viewport.append(this.edgeLayer, this.ghost, this.nodeLayer);
      this.svg.append(defs, this.bg, this.viewport);
      root.prepend(this.svg);
      this.tooltip = root.querySelector("#tooltip");

      this._bind();
      store.on((changed) => this._onChange(changed));
      new ResizeObserver(() => this._onResize()).observe(root);
      this.sync();
      if (store.state.view && store.state.view.key === store.state.modelKey) {
        this._userView = true;
        this.setView(store.state.view, false);
      }
      else requestAnimationFrame(() => this.fit(false));
    }

    // ---------------------------------------------------------------- building

    sync() {
      const graph = this.store.graph();
      const hidden = new Set(this.store.state.hiddenRoles);
      if (this.store.state.filters.hideProxies) hidden.add("recorded proxy");
      const sig = [...hidden].sort().join("|");
      if (graph !== this._graph || sig !== this._hiddenSig) {
        this._build(graph, hidden);
        this._graph = graph;
        this._hiddenSig = sig;
      }
      this.updatePositions();
      this.updateClasses();
    }

    _build(graph, hidden) {
      this.edgeLayer.replaceChildren();
      this.nodeLayer.replaceChildren();
      this.nodeEls.clear();
      this.edgeEls.clear();
      this.visible = new Set(graph.ids.filter((id) => !hidden.has(graph.role(id))));
      for (const id of graph.ids) {
        if (!this.visible.has(id)) continue;
        const role = graph.role(id);
        const layout = G.nodeLayout(id, role);
        const g = s("g", { class: `node role-${ROLE_CLASS[role]}`, "data-id": id, tabindex: -1 });
        const halo = s("path", { class: "halo", d: G.toSvgPath(G.nodeShape("fully observed", layout.w + 9, layout.h + 9).outline) });
        const blocker = s("path", { class: "blocker", d: G.toSvgPath(G.nodeShape("fully observed", layout.w + 9, layout.h + 9).outline) });
        const shape = s("path", { class: "shape", d: G.toSvgPath(layout.shape.outline) });
        g.append(halo, blocker, shape);
        if (layout.shape.inner) g.appendChild(s("path", { class: "inner", d: G.toSvgPath(layout.shape.inner) }));
        const label = s("text", { x: 0, y: 4.6, "text-anchor": "middle" }, id);
        g.appendChild(label);
        const badge = s("g", { class: "badge", transform: `translate(${layout.w / 2 - 2},${-layout.h / 2 - 2})`, style: "display:none" }, s("circle", { r: 7.5 }), s("text", { y: 3.5 }, ""));
        g.appendChild(badge);
        // drag from the handle to another node to draw an edge (edit mode)
        const handle = s("g", { class: "handle", transform: `translate(${layout.w / 2 + 9},0)` }, s("circle", { r: 7 }), s("path", { d: "M-3 0H3M0 -3V3" }));
        g.appendChild(handle);
        this.nodeLayer.appendChild(g);
        this.nodeEls.set(id, { g, layout, badge, badgeText: badge.querySelector("text") });
      }
      for (const [a, b] of graph.edges) {
        if (!this.visible.has(a) || !this.visible.has(b)) continue;
        const g = s("g", { class: "edge", "data-a": a, "data-b": b });
        const hit = s("path", { class: "hit" });
        const line = s("path", { class: "line" });
        const head = s("path", { class: "head" });
        g.append(line, head, hit);
        this.edgeLayer.appendChild(g);
        this.edgeEls.set(edgeKey(a, b), { g, line, head, hit, a, b });
      }
      this.svg.setAttribute("aria-label", `${graph.name}: ${graph.ids.length} nodes, ${graph.edgeCount} edges`);
    }

    // ---------------------------------------------------------------- drawing

    updatePositions() {
      const pos = this.store.positions();
      this._pos = pos;
      for (const [id, el] of this.nodeEls) {
        const p = pos.get(id);
        el.g.setAttribute("transform", `translate(${p.x},${p.y})`);
      }
      for (const el of this.edgeEls.values()) this._drawEdge(el);
    }

    _drawEdge(el) {
      const a = this._pos.get(el.a), b = this._pos.get(el.b);
      const geo = G.edgeGeometry({ ...a, layout: this.nodeEls.get(el.a).layout }, { ...b, layout: this.nodeEls.get(el.b).layout });
      const d = `M${geo.x1.toFixed(1)} ${geo.y1.toFixed(1)}L${geo.x2.toFixed(1)} ${geo.y2.toFixed(1)}`;
      el.line.setAttribute("d", d);
      el.hit.setAttribute("d", `M${geo.x1.toFixed(1)} ${geo.y1.toFixed(1)}L${geo.tipX.toFixed(1)} ${geo.tipY.toFixed(1)}`);
      el.head.setAttribute("d", G.toSvgPath(geo.head, 1));
      el.g.style.display = geo.visible ? "" : "none";
    }

    updateClasses() {
      const st = this.store.state;
      const tr = this.store.transient;
      const graph = this._graph;
      const a = this.store.analysis();
      const emph = tr.emphasis && !(a && a.statement) ? tr.emphasis : null;
      const valid = !!(a && a.statement);
      const S = valid ? a.statement : emph;
      const focus = tr.focusPath;
      const focusEdges = focus ? MG.ui.edgeSet([focus]) : new Set();
      const focusNodes = new Set(focus ? focus.path : []);
      const openNodes = new Set();
      if (valid) for (const k of a.openEdges) k.split("\u0001").forEach((n) => openNodes.add(n));
      const hover = !valid && !focus ? tr.hoverNode : null;
      const hoverNb = hover && graph.has(hover) ? graph.neighbours(hover) : null;

      for (const [id, el] of this.nodeEls) {
        const c = el.g.classList;
        const inX = S && S.x.has(id), inY = S && S.y.has(id), inZ = S && S.z.has(id);
        c.toggle("is-selected", st.node === id);
        c.toggle("is-xy", !!(inX || inY));
        c.toggle("is-z", !!inZ);
        const dim = focus ? !focusNodes.has(id) && !inX && !inY && !inZ : valid ? !inX && !inY && !inZ && !openNodes.has(id) : false;
        el.g.classList.toggle("is-do", !!(emph && inX));
        c.toggle("is-dim", dim);
        c.toggle("is-faded", !!(hoverNb && id !== hover && !hoverNb.has(id)));
        c.toggle("is-blocker", !!(focus && focus.blocker === id));
        c.toggle("is-pick-source", tr.editSource === id);
        const badge = inX ? (emph ? "do" : "X") : inY ? "Y" : inZ ? "Z" : null;
        el.badge.style.display = badge ? "" : "none";
        if (badge) {
          el.badgeText.textContent = badge;
          el.badge.classList.toggle("badge-z", badge === "Z");
        }
      }
      for (const [k, el] of this.edgeEls) {
        const c = el.g.classList;
        const open = valid && a.openEdges.has(k);
        const isFocus = focusEdges.has(k);
        c.toggle("is-open", !!open && !focus);
        c.toggle("is-focus", isFocus);
        c.toggle("is-dim", focus ? !isFocus : valid ? !open : false);
        c.toggle("is-neighbour", !!(hover && (el.a === hover || el.b === hover)));
        c.toggle("is-cut", !!(tr.cut && tr.cut.has(k)));
        c.toggle("is-faded", !!(hover && el.a !== hover && el.b !== hover));
      }
      this.svg.classList.toggle("is-editing", tr.editMode);
      for (const t of ["select", "arrow", "bidirected", "erase"]) this.svg.classList.toggle(`tool-${t}`, tr.tool === t);
    }

    // ---------------------------------------------------------------- view transform

    setView(v, animate = true) {
      const target = { k: MG.clamp(v.k, 0.12, 4), tx: v.tx, ty: v.ty };
      if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        cancelAnimationFrame(this._anim);
        this.view = target;
        this._applyView();
        return;
      }
      const from = { ...this.view };
      const t0 = performance.now();
      const dur = 320;
      cancelAnimationFrame(this._anim);
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - t, 3);
        this.view = { k: from.k + (target.k - from.k) * e, tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e };
        this._applyView();
        if (t < 1) this._anim = requestAnimationFrame(tick);
      };
      this._anim = requestAnimationFrame(tick);
    }

    _applyView() {
      const { k, tx, ty } = this.view;
      const t = `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${k.toFixed(4)})`;
      this.viewport.setAttribute("transform", t);
      this.pattern.setAttribute("patternTransform", t);
      this.store.state.view = { ...this.view, key: this.store.state.modelKey };
      if (this.onViewChange) this.onViewChange(this.view);
    }

    bounds() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [id, el] of this.nodeEls) {
        const p = this._pos.get(id);
        x0 = Math.min(x0, p.x - el.layout.w / 2);
        x1 = Math.max(x1, p.x + el.layout.w / 2);
        y0 = Math.min(y0, p.y - el.layout.h / 2 - 10);
        y1 = Math.max(y1, p.y + el.layout.h / 2);
      }
      return x0 === Infinity ? { x0: -200, y0: -150, x1: 200, y1: 150 } : { x0, y0, x1, y1 };
    }

    fit(animate = true, nodes = null) {
      if (animate) this._userView = !!(nodes && nodes.length);
      const W = this.svg.clientWidth, H = this.svg.clientHeight;
      if (!W || !H) return;
      let b = this.bounds();
      if (nodes && nodes.length) {
        const pts = nodes.filter((n) => this._pos.has(n)).map((n) => this._pos.get(n));
        if (pts.length) b = { x0: Math.min(...pts.map((p) => p.x)) - 60, x1: Math.max(...pts.map((p) => p.x)) + 60, y0: Math.min(...pts.map((p) => p.y)) - 50, y1: Math.max(...pts.map((p) => p.y)) + 50 };
      }
      const padL = 32, padR = 70, padT = 40, padB = 70;
      const k = Math.min((W - padL - padR) / (b.x1 - b.x0), (H - padT - padB) / (b.y1 - b.y0), 1.6);
      const tx = padL + (W - padL - padR - (b.x1 - b.x0) * k) / 2 - b.x0 * k;
      const ty = padT + (H - padT - padB - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
      this.setView({ k, tx, ty }, animate);
    }

    zoomBy(factor, cx, cy, animate = true) {
      this._userView = true;
      const W = this.svg.clientWidth, H = this.svg.clientHeight;
      cx = cx === undefined ? W / 2 : cx;
      cy = cy === undefined ? H / 2 : cy;
      const k = MG.clamp(this.view.k * factor, 0.12, 4);
      const f = k / this.view.k;
      this.setView({ k, tx: cx - (cx - this.view.tx) * f, ty: cy - (cy - this.view.ty) * f }, animate);
    }

    centerOn(id) {
      const p = this._pos && this._pos.get(id);
      if (!p) return;
      const W = this.svg.clientWidth, H = this.svg.clientHeight;
      const x = p.x * this.view.k + this.view.tx, y = p.y * this.view.k + this.view.ty;
      if (x > 60 && x < W - 80 && y > 60 && y < H - 80) return; // already in view
      this.setView({ k: this.view.k, tx: W / 2 - p.x * this.view.k, ty: H / 2 - p.y * this.view.k });
    }

    toGraph(clientX, clientY) {
      const r = this.svg.getBoundingClientRect();
      return { x: (clientX - r.left - this.view.tx) / this.view.k, y: (clientY - r.top - this.view.ty) / this.view.k };
    }

    _onResize() {
      // keep the whole graph in view until the user pans or zooms
      if (!this._userView) this.fit(false);
    }

    // ---------------------------------------------------------------- events

    _onChange(changed) {
      const structural = changed.has("modelKey") || changed.has("edits") || changed.has("hiddenRoles") || changed.has("filters");
      if (structural) {
        const modelChanged = changed.has("modelKey");
        this.sync();
        if (modelChanged) requestAnimationFrame(() => this.fit(true));
        return;
      }
      if (changed.has("layout")) this.updatePositions();
      this.updateClasses();
    }

    _bind() {
      const svg = this.svg;
      svg.addEventListener("pointerdown", (e) => this._down(e));
      svg.addEventListener("pointermove", (e) => this._move(e));
      svg.addEventListener("pointerup", (e) => this._up(e));
      svg.addEventListener("pointercancel", (e) => this._up(e, true));
      svg.addEventListener("pointerleave", () => this._hideTooltip());
      svg.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
      svg.addEventListener("dblclick", (e) => {
        if (e.target.closest(".node") || e.target.closest(".edge")) return;
        if (this.store.transient.editMode && this.onBackgroundDblClick) this.onBackgroundDblClick(this.toGraph(e.clientX, e.clientY), e);
        else this.fit(true);
      });
      svg.addEventListener("pointerover", (e) => {
        const n = e.target.closest(".node");
        const ed = e.target.closest(".edge");
        if (n) this.store.setTransient({ hoverNode: n.dataset.id });
        else if (ed) this.store.setTransient({ hoverEdge: edgeKey(ed.dataset.a, ed.dataset.b) });
      });
      svg.addEventListener("pointerout", (e) => {
        const n = e.target.closest(".node");
        if (n && !n.contains(e.relatedTarget)) this.store.setTransient({ hoverNode: null });
        const ed = e.target.closest(".edge");
        if (ed && !ed.contains(e.relatedTarget)) this.store.setTransient({ hoverEdge: null });
      });
    }

    _down(e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      try {
        this.svg.setPointerCapture(e.pointerId);
      } catch (err) {
        /* the pointer is gone already (or the event was synthetic): carry on without capture */
      }
      if (e.pointerType !== "touch") this._pointers.clear();
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const nodeEl = e.target.closest(".node");
      const edgeEl = e.target.closest(".edge");
      if (this._pointers.size === 2) {
        const [p, q] = [...this._pointers.values()];
        this._gesture = { type: "pinch", dist: Math.hypot(p.x - q.x, p.y - q.y), view: { ...this.view }, cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2 };
        return;
      }
      if (nodeEl && e.target.closest(".handle")) {
        this._gesture = { type: "connect", id: nodeEl.dataset.id, sx: e.clientX, sy: e.clientY, moved: true };
        this.store.setTransient({ editSource: nodeEl.dataset.id });
      } else if (nodeEl) {
        const id = nodeEl.dataset.id;
        const p = this._pos.get(id);
        const tool = this.store.transient.tool;
        const links = tool === "arrow" || tool === "bidirected";
        this._gesture = { type: links ? "node-link" : "node", id, sx: e.clientX, sy: e.clientY, x: p.x, y: p.y, moved: false, shift: e.shiftKey };
      } else if (edgeEl) {
        this._gesture = { type: "edge", a: edgeEl.dataset.a, b: edgeEl.dataset.b, sx: e.clientX, sy: e.clientY, moved: false, view: { ...this.view } };
      } else {
        this._gesture = { type: "pan", sx: e.clientX, sy: e.clientY, view: { ...this.view }, moved: false };
      }
    }

    _move(e) {
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      let g = this._gesture;
      const tr = this.store.transient;
      if (tr.editMode && tr.editSource && this._pos && (!g || g.type !== "connect")) {
        // click-click joining: the first node is chosen, the ghost follows the pointer
        const tid = this._nodeUnder(e, tr.editSource);
        this._drawLinkGhost(tr.editSource, tid, e);
        if (!g) return;
      }
      if (!g) return this._tooltipFor(e);
      if (g.type === "node-link" && !g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) >= 4) {
        // Arrow / Common cause tool: dragging off a node starts a link instead of a move
        this._gesture = g = { type: "connect", id: g.id, sx: g.sx, sy: g.sy, moved: true };
        this.store.setTransient({ editSource: g.id });
      }
      if (g.type === "connect") {
        this._drawLinkGhost(g.id, this._nodeUnder(e, g.id), e);
        return;
      }
      if (g.type === "pinch" && this._pointers.size === 2) {
        const [p, q] = [...this._pointers.values()];
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const r = this.svg.getBoundingClientRect();
        const k = MG.clamp(g.view.k * (dist / g.dist), 0.12, 4);
        const f = k / g.view.k;
        const cx = g.cx - r.left, cy = g.cy - r.top;
        const mx = (p.x + q.x) / 2 - g.cx, my = (p.y + q.y) / 2 - g.cy;
        this._userView = true;
        this.view = { k, tx: cx - (cx - g.view.tx) * f + mx, ty: cy - (cy - g.view.ty) * f + my };
        this._applyView();
        return;
      }
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      this._hideTooltip();
      if (g.type === "node") {
        const nx = g.x + dx / this.view.k, ny = g.y + dy / this.view.k;
        this.store.moveNode(g.id, nx, ny, { silent: true });
        this._schedulePositions();
      } else {
        if (g.type === "pan" || g.type === "edge") {
          this.svg.classList.add("is-panning");
          this._userView = true;
          this.view = { k: g.view.k, tx: g.view.tx + dx, ty: g.view.ty + dy };
          this._applyView();
        }
      }
    }

    _up(e, cancelled = false) {
      this._pointers.delete(e.pointerId);
      const g = this._gesture;
      this.svg.classList.remove("is-panning");
      if (!g) return;
      if (g.type === "pinch") {
        if (this._pointers.size === 0) this._gesture = null;
        return;
      }
      this._gesture = null;
      if (g.type === "connect") {
        const tid = this._dropTarget, problem = this._dropProblem;
        this.setDropTarget(null);
        this.clearGhost();
        this.store.setTransient({ editSource: e.shiftKey && !cancelled ? g.id : null });
        if (cancelled) return;
        if (tid && problem) MG.ui.toast(problem, "error");
        else if (tid) this.onConnect(g.id, tid, e);
        else if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 30) this.onConnectToEmpty(g.id, this.toGraph(e.clientX, e.clientY), e);
        return;
      }
      if (cancelled) return;
      if (g.type === "node-link") return this.onNodeClick(g.id, e);
      if (g.type === "node") {
        if (g.moved) this.store.set({ layout: { ...this.store.state.layout } });
        else this.onNodeClick(g.id, e);
      } else if (g.type === "edge" && !g.moved) {
        this.onEdgeClick(g.a, g.b, e);
      } else if (g.type === "pan" && !g.moved) {
        this.onBackgroundClick(e);
      }
    }

    _schedulePositions() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        this.updatePositions();
      });
    }

    _wheel(e) {
      e.preventDefault();
      this._userView = true;
      const r = this.svg.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || e.metaKey || mouseWheel) {
        const scale = e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.012 : 0.0022;
        const factor = Math.exp(-e.deltaY * scale);
        const k = MG.clamp(this.view.k * factor, 0.12, 4);
        const f = k / this.view.k;
        cancelAnimationFrame(this._anim);
        this.view = { k, tx: cx - (cx - this.view.tx) * f, ty: cy - (cy - this.view.ty) * f };
      } else {
        this.view = { ...this.view, tx: this.view.tx - e.deltaX, ty: this.view.ty - e.deltaY };
      }
      this._applyView();
    }

    // ---------------------------------------------------------------- tooltip

    _tooltipFor(e) {
      const n = e.target.closest && e.target.closest(".node");
      const ed = e.target.closest && e.target.closest(".edge");
      if (!n && !ed) return this._hideTooltip();
      const graph = this._graph;
      let html;
      if (n) {
        const id = n.dataset.id;
        const meta = graph.meta.get(id) || {};
        html = h("div", null,
          h("strong", null, id), " ", h("span", { class: "tt-role" }, graph.role(id)),
          meta.description ? h("div", { class: "tt-desc" }, meta.description) : null,
          h("div", { class: "tt-meta" }, `${graph.parents(id).size} parents · ${graph.children(id).size} children`),
          this.store.transient.tool === "erase" ? h("div", { class: "tt-bad" }, meta.bidirected ? "Click to delete this common cause" : "Click to delete this node") : null);
      } else {
        const tr = this.store.transient;
        const meta = graph.meta.get(ed.dataset.a) || {};
        const title = meta.bidirected ? `${meta.bidirected[0]} ↔ ${meta.bidirected[1]} (through ${ed.dataset.a})` : `${ed.dataset.a} → ${ed.dataset.b}`;
        html = h("div", null, h("strong", null, title), tr.editMode ? h("div", { class: "tt-desc" }, meta.bidirected ? "Click to delete this common cause" : "Click to delete this arrow") : null);
      }
      const r = this.root.getBoundingClientRect();
      this.tooltip.replaceChildren(html);
      this.tooltip.hidden = false;
      const tw = this.tooltip.offsetWidth, th = this.tooltip.offsetHeight;
      let x = e.clientX - r.left + 14, y = e.clientY - r.top + 16;
      if (x + tw > r.width - 8) x = e.clientX - r.left - tw - 14;
      if (y + th > r.height - 8) y = e.clientY - r.top - th - 12;
      this.tooltip.style.left = x + "px";
      this.tooltip.style.top = y + "px";
    }

    _hideTooltip() {
      if (this.tooltip) this.tooltip.hidden = true;
    }

    clearGhost() {
      this.ghost.setAttribute("d", "");
      this.ghost.classList.remove("is-invalid");
      this._hideTooltip();
    }

    /** The node under the pointer, other than `self`. */
    _nodeUnder(e, self) {
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const target = over && over.closest && over.closest(".graph .node");
      return target && target.dataset.id !== self ? target.dataset.id : null;
    }

    /** The dashed link from `src` to the pointer, snapped to `tid`, checked against the m-graph rules. */
    _drawLinkGhost(src, tid, e) {
      const a = this._pos.get(src);
      if (!a) return;
      const kind = this.store.transient.edgeKind === "bidirected" ? "bidirected" : "directed";
      const problem = tid ? this.store.graph().edgeProblem(src, tid, kind) : null;
      this.setDropTarget(tid, problem);
      let to = this.toGraph(e.clientX, e.clientY);
      if (tid) {
        const b = this._pos.get(tid);
        const geo = G.edgeGeometry({ ...a, layout: this.nodeEls.get(src).layout }, { ...b, layout: this.nodeEls.get(tid).layout });
        to = { x: geo.x2, y: geo.y2 };
      }
      this.ghost.setAttribute("d", `M${a.x} ${a.y}L${to.x} ${to.y}`);
      this.ghost.classList.toggle("bidirected", kind === "bidirected");
      this.ghost.classList.toggle("is-invalid", !!problem);
      this.ghost.setAttribute("marker-end", kind === "bidirected" ? "" : "url(#mg-ghost-head)");
      const text = problem || (tid ? (kind === "bidirected" ? `${src} ↔ ${tid}` : `${src} → ${tid}`) : kind === "bidirected" ? `${src} ↔ …` : `${src} → …  (drop on empty space for a new node)`);
      this._showTip(h("div", { class: problem ? "tt-bad" : null }, text), e);
    }

    _showTip(content, e) {
      const r = this.root.getBoundingClientRect();
      this.tooltip.replaceChildren(content);
      this.tooltip.hidden = false;
      const tw = this.tooltip.offsetWidth, th = this.tooltip.offsetHeight;
      let x = e.clientX - r.left + 14, y = e.clientY - r.top + 16;
      if (x + tw > r.width - 8) x = e.clientX - r.left - tw - 14;
      if (y + th > r.height - 8) y = e.clientY - r.top - th - 12;
      this.tooltip.style.left = x + "px";
      this.tooltip.style.top = y + "px";
    }

    /** Highlight the node a dragged item or link would land on; `problem` marks it as refused. */
    setDropTarget(id, problem = null) {
      this._dropProblem = id ? problem || null : null;
      if (this._dropTarget !== id) {
        if (this._dropTarget && this.nodeEls.has(this._dropTarget)) this.nodeEls.get(this._dropTarget).g.classList.remove("is-drop-target", "is-drop-invalid");
        this._dropTarget = id;
      }
      if (id && this.nodeEls.has(id)) {
        const c = this.nodeEls.get(id).g.classList;
        c.add("is-drop-target");
        c.toggle("is-drop-invalid", !!problem);
      }
    }
  }

  MG.ui.GraphView = GraphView;
})(globalThis.MG);
