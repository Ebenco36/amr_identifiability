/* DOM helpers: element builder, icons, downloads, clipboard, toasts. */
(function (MG) {
  "use strict";
  const ui = (MG.ui = MG.ui || {});
  const SVG_NS = "http://www.w3.org/2000/svg";

  /** h("div", {class: "x", onClick: fn, dataset: {...}, style: {...}}, ...children) */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    applyProps(el, props);
    append(el, children);
    return el;
  }

  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
    append(el, children);
    return el;
  }

  function applyProps(el, props) {
    if (!props) return;
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "value") el.value = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  const ICONS = {
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    layout: '<circle cx="4" cy="4" r="1.8"/><circle cx="12" cy="4" r="1.8"/><circle cx="8" cy="12" r="1.8"/><path d="M5.3 5.3l1.6 4.9M10.7 5.3L9.1 10.2"/>',
    undo: '<path d="M5.5 3.5L2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 010 8H7"/>',
    redo: '<path d="M10.5 3.5l3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 000 8H9"/>',
    edit: '<path d="M10.5 2.5l3 3-8 8h-3v-3z"/><path d="M9 4l3 3"/>',
    download: '<path d="M8 2.5v8M4.5 7L8 10.5 11.5 7"/><path d="M2.5 12.5v1h11v-1"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
    moon: '<path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z"/>',
    auto: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" /><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none"/>',
    help: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.3a1.9 1.9 0 013.6.7c0 1.3-1.8 1.6-1.8 2.7"/><path d="M8 11.6v.1"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 014 2.5h7"/>',
    check: '<path d="M3 8.5l3 3 7-7"/>',
    cross: '<path d="M4 4l8 8M12 4l-8 8"/>',
    arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
    target: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    query: '<path d="M2.5 4h11M2.5 8h7M2.5 12h4"/><circle cx="12" cy="11" r="2"/><path d="M13.5 12.5L15 14"/>',
    pointer: '<path d="M3.5 2.5l9 5.2-4 1.1-1.9 3.9z"/>',
    link: '<circle cx="3.5" cy="8" r="1.8"/><path d="M5.3 8h7.2M10 5.5l2.5 2.5-2.5 2.5"/>',
    bidir: '<path d="M2.5 8h11M5 5.5L2.5 8 5 10.5M11 5.5l2.5 2.5-2.5 2.5"/>',
    erase: '<path d="M6.5 13.5h7M9.8 3.2l3 3-6.3 6.3H3.6L2.5 11.4z"/><path d="M6.4 6.6l3 3"/>',
    panel: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/>',
  };

  function icon(name) {
    const el = document.createElementNS(SVG_NS, "svg");
    el.setAttribute("viewBox", "0 0 16 16");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = ICONS[name] || "";
    return el;
  }

  function iconButton(name, label, props = {}) {
    const { text, class: cls, ...rest } = props;
    const classes = ["icon-btn", text ? "labelled" : null, cls].filter(Boolean).join(" ");
    return h("button", { type: "button", title: label, "aria-label": label, ...rest, class: classes }, icon(name), text ? h("span", null, text) : null);
  }

  function download(filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: filename, style: { display: "none" } });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = h("textarea", { style: { position: "fixed", opacity: "0" } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("Copied");
  }

  function toast(message, kind = "") {
    const box = document.getElementById("toasts");
    if (!box) return;
    const el = h("div", { class: ["toast", kind] }, message);
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity 200ms";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 220);
    }, kind === "error" ? 4200 : 1800);
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  /** A small inline SVG showing the shape and colour of a role (legend, inspector). */
  const ROLE_CLASS = {
    "fully observed": "full",
    "partially observed": "part",
    "missingness indicator": "ind",
    "recorded proxy": "proxy",
    latent: "lat",
  };

  function roleGlyph(role, w = 24, h2 = 15) {
    const shape = MG.geometry.nodeShape(role, w, h2);
    const el = s("svg", { viewBox: `${-w / 2 - 2} ${-h2 / 2 - 2} ${w + 4} ${h2 + 4}`, width: w + 4, height: h2 + 4, class: "glyph", "aria-hidden": "true" });
    const cls = ROLE_CLASS[role];
    const style = (fill, stroke, dash) => `fill:var(--r-${fill}-fill);stroke:var(--r-${stroke});stroke-width:1.4${dash ? ";stroke-dasharray:3 2" : ""}`;
    el.appendChild(s("path", { d: MG.geometry.toSvgPath(shape.outline), style: style(cls, cls, role === "latent") }));
    if (shape.inner) el.appendChild(s("path", { d: MG.geometry.toSvgPath(MG.geometry.nodeShape(role, w - 5, h2 - 5).outline), style: `fill:none;stroke:var(--r-${cls});stroke-width:0.9` }));
    return el;
  }

  /** Statement text with the conditioning part muted. */
  function statementText(st) {
    const f = (set) => MG.sorted(set).join(", ");
    const head = `${f(st.x)} ⊥⊥ ${f(st.y)}`;
    if (!st.z.size) return h("span", { class: "stmt" }, head, h("span", { class: "given" }, "  (marginal)"));
    return h("span", { class: "stmt" }, head, h("span", { class: "given" }, " | " + f(st.z)));
  }

  Object.assign(ui, { h, s, icon, iconButton, download, copyText, toast, debounce, roleGlyph, statementText, ROLE_CLASS });
})(globalThis.MG);
