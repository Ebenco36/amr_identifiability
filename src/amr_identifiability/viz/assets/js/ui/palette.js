/* Drag-and-drop palette, shown in the Build panel: drag a kind of node onto the canvas to add it,
 * or onto a node to give it a missingness indicator, or to mark it as exposure or outcome.
 * A click without dragging adds a node at the centre of the view, or applies to the selected
 * node. Works with mouse, touch and keyboard. */
(function (MG) {
  "use strict";
  const { h } = MG.ui;

  const ITEMS = [
    { kind: "variable", label: "Variable", short: "Variable", role: "fully observed", hint: "A recorded variable. Drop on the canvas." },
    { kind: "partial", label: "Partially observed", short: "Partial", role: "partially observed", hint: "A variable that can be missing: its indicator R and proxy are added. Drop on the canvas." },
    { kind: "latent", label: "Latent", short: "Latent", role: "latent", hint: "An unmeasured variable. Drop on the canvas." },
    { kind: "indicator", label: "Missingness R", short: "Missing R", role: "missingness indicator", hint: "Drop on a variable that can be missing: adds its indicator R_X and proxy X*." },
    { kind: "exposure", label: "Exposure", short: "Exposure", role: null, hint: "Drop on a node to make it the default treatment." },
    { kind: "outcome", label: "Outcome", short: "Outcome", role: null, hint: "Drop on a node to make it the default outcome." },
  ];

  class Palette {
    constructor(store, app, container) {
      this.store = store;
      this.app = app;
      this.el = h("div", { class: "palette", role: "toolbar", "aria-label": "Drag to add" }, ITEMS.map((it) => this._item(it)));
      container.appendChild(this.el);
    }

    _item(it) {
      const glyph = it.role ? MG.ui.roleGlyph(it.role, 17, 11) : h("span", { class: `flag-glyph ${it.kind}` }, it.kind === "exposure" ? "do" : "Y");
      const el = h("button", { type: "button", class: "palette-item", title: it.hint, "aria-label": `${it.label}: ${it.hint}` }, glyph, h("span", null, it.short || it.label));
      el.addEventListener("pointerdown", (e) => this._start(e, it));
      // keyboard: Enter adds a node at the centre of the view
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        this._click(it);
      });
      return el;
    }

    /** A click without a drag: a new node mid-view, or the selected node for the other items. */
    _click(it) {
      if (["variable", "partial", "latent"].includes(it.kind)) {
        const r = this.app.view.svg.getBoundingClientRect();
        return this._dropOnCanvas(it, r.left + r.width / 2, r.top + r.height / 2);
      }
      const sel = this.store.state.node;
      if (sel && this.store.graph().has(sel)) return this._dropOnNode(it, sel);
      MG.ui.toast(`Drag ${it.label} onto a node, or select a node and click ${it.label}`);
    }

    _start(e, it) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      let dragging = false;
      const ghost = h("div", { class: "drag-ghost" }, it.label);
      const move = (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          dragging = true;
          document.body.appendChild(ghost);
        }
        ghost.style.left = ev.clientX + 12 + "px";
        ghost.style.top = ev.clientY + 10 + "px";
        const target = this._nodeAt(ev.clientX, ev.clientY);
        this.app.view.setDropTarget(target && this._accepts(it, target) ? target : null);
        ghost.classList.toggle("is-invalid", !!target && !this._accepts(it, target));
      };
      const up = (ev) => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (!dragging) return this._click(it);
        ghost.remove();
        this.app.view.setDropTarget(null);
        const overCanvas = this.app.view.svg.contains(document.elementFromPoint(ev.clientX, ev.clientY));
        if (!overCanvas) return;
        const target = this._nodeAt(ev.clientX, ev.clientY);
        if (target) this._dropOnNode(it, target);
        else this._dropOnCanvas(it, ev.clientX, ev.clientY);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    }

    _nodeAt(x, y) {
      const el = document.elementFromPoint(x, y);
      const n = el && el.closest && el.closest(".graph .node");
      return n ? n.dataset.id : null;
    }

    _accepts(it, id) {
      const g = this.store.graph();
      const role = g.role(id);
      if (it.kind === "indicator") return role === "fully observed";
      if (it.kind === "exposure" || it.kind === "outcome") return role === "fully observed" || role === "partially observed";
      return false;
    }

    _dropOnNode(it, id) {
      const g = this.store.graph();
      if (it.kind === "indicator") {
        if (g.role(id) !== "fully observed") return MG.ui.toast(g.partiallyObserved.has(id) ? `${id} already has an indicator` : `${id} cannot have a missingness indicator`, "error");
        if (this.store.makePartial(id)) MG.ui.toast(`${id} is now partially observed: added R_${id} and ${id}_star`);
        return;
      }
      if (it.kind === "exposure" || it.kind === "outcome") {
        if (!this._accepts(it, id)) return MG.ui.toast(`${id} cannot be ${it.kind === "exposure" ? "an exposure" : "an outcome"}`, "error");
        this.store.setNodeFlag(id, it.kind, true);
        this.store.state.causalQuery = null;
        MG.ui.toast(`${id} marked as ${it.kind}`);
        return;
      }
      MG.ui.toast("Drop it on empty space to add a new node", "");
    }

    _dropOnCanvas(it, clientX, clientY) {
      if (!["variable", "partial", "latent"].includes(it.kind)) return MG.ui.toast(`Drop ${it.label} onto a node`);
      const pt = this.app.view.toGraph(clientX, clientY);
      this.app._askNodeName(pt, { clientX, clientY }, (name) => {
        if (it.kind === "partial") this.store.makePartial(name);
        if (it.kind === "latent") this.store.toggleLatent(name);
      });
    }
  }

  MG.ui.Palette = Palette;
})(globalThis.MG);
