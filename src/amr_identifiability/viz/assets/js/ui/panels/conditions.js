/* Conditions tab: the independences the graph implies between recorded nodes, explained in words.
 *
 *   Minimal sets   for each pair, the smallest sets of nodes that make them independent
 *   Every set      every set that makes them independent, minimal or not (checked one by one:
 *                  adding a node can break an independence, so supersets are not automatic)
 *
 * Each row says what the claim means in words and, when recorded data can check it, how.
 * The list is virtualised (only visible rows are in the DOM).
 */
(function (MG) {
  "use strict";
  const { h, icon, statementText, debounce } = MG.ui;

  const H_GROUP = 34, H_NEVER = 32, H_MORE = 30;
  // rows wrap; their heights are computed from the text and the list's width (see _layout)
  const ROW_PAD = 14, ROW_FOOT = 24, LINE_STMT = 18, LINE_TEXT = 16;
  const EVERY_MAX_NODES = 16;   // above this many recorded nodes, "Every set" asks for one node first
  const EVERY_MAX_SETS = 200;   // per pair
  const EVERY_MAX_CHECKS = 40000; // per pair

  class ConditionsPanel {
    constructor(store, app) {
      this.store = store;
      this.app = app;
      this._entries = [];
      this._onScroll = () => this._paint();
    }

    get title() {
      return "Conditions";
    }

    count() {
      return this.store.catalogue().summary().sets;
    }

    shouldRender(changed) {
      return ["modelKey", "edits", "filters"].some((k) => changed.has(k)) || changed.has("statement");
    }

    render(body) {
      const store = this.store;
      const graph = store.graph();
      const cat = store.catalogue(graph);
      const f = store.state.filters;
      const sum = cat.summary();
      this.body = body;
      const prevScroll = this._keepScroll ? body.scrollTop : 0;
      const hadFocus = this.search && document.activeElement === this.search;
      const caret = hadFocus ? this.search.selectionStart : null;

      const search = h("input", { class: "input mono grow", type: "search", placeholder: "Filter: node names or text", value: f.search, "aria-label": "Filter statements" });
      this.search = search;
      search.addEventListener("input", debounce((e) => { this._keepScroll = false; store.setFilters({ search: e.target.value }); }, 120));
      const nodeSel = h("select", { class: "select", "aria-label": "Only pairs involving" },
        h("option", { value: "" }, "All nodes"),
        cat.nodes.map((n) => h("option", { value: n, selected: f.node === n }, n)));
      nodeSel.addEventListener("change", (e) => store.setFilters({ node: e.target.value }));
      const tog = (key, label, title) => h("label", { class: "toggle", title }, h("input", { type: "checkbox", checked: !!f[key], onChange: (e) => store.setFilters({ [key]: e.target.checked }) }), label);
      const mode = h("div", { class: "segmented", role: "group", "aria-label": "Which sets" },
        h("button", { type: "button", "aria-pressed": String(!f.every), title: "For each pair, the smallest sets that make it independent", onClick: () => store.setFilters({ every: false }) }, "Minimal sets"),
        h("button", { type: "button", "aria-pressed": String(!!f.every), title: "Every set that makes the pair independent, minimal or not", onClick: () => store.setFilters({ every: true }) }, "Every set"));

      this.countEl = h("span", { class: "muted", style: { fontSize: "12px" } }, "");
      const head = [
        h("div", { class: "panel-section" },
          h("h3", null, "What the graph claims", h("span", { class: "aside" }, graph.name)),
          h("div", { class: "stat-grid" },
            stat(sum.separable, `of ${sum.pairs} pairs can be made independent`),
            stat(sum.sets, "minimal ways to do it"),
            stat(sum.testable, "checkable in your data"),
            stat(sum.adjacent + sum.inseparable, "pairs never independent")),
          guide()),
        h("div", { class: "panel-section list-head" },
          h("div", { class: "filters" }, mode),
          h("div", { class: "filters", style: { marginTop: "8px" } }, search, nodeSel),
          h("div", { class: "filters", style: { marginTop: "8px" } },
            tog("testableOnly", "Checkable only", "Only claims you can check in recorded data"),
            tog("showNever", "Show pairs never independent"),
            tog("hideProxies", "Hide proxies", "Leave out the recorded proxies X_star")),
          h("div", { class: "filters", style: { marginTop: "8px", justifyContent: "space-between" } },
            this.countEl,
            h("button", { class: "btn small", title: "Download the list shown, with a plain-language column", onClick: () => this._csv(cat) }, icon("download"), "CSV")))];

      let region;
      if (!f.every) {
        this._entries = this._build(cat, f, null);
        region = this._list();
      } else if (cat.nodes.length > EVERY_MAX_NODES && !f.node) {
        this._entries = [];
        region = h("div", { class: "panel-section" }, h("div", { class: "problem" },
          h("b", null, "Pick a node first. "),
          `This graph has ${cat.nodes.length} recorded nodes, so a pair can have millions of separating sets. Choose a node in the menu above to list every set for the pairs it is in.`));
        this.countEl.textContent = "";
      } else {
        const key = `every:${f.node || "*"}`;
        region = MG.ui.deferred.slot(graph, key, () => this._every(cat, f.node), (entry, retry) => {
          if (entry.timeUp) return h("div", { class: "panel-section" }, MG.ui.deferred.timeUp(entry, retry, "every set"));
          if (entry.error) return h("div", { class: "panel-section" }, h("p", { class: "muted" }, entry.error.message));
          this._entries = this._build(cat, f, entry.value);
          const el = this._list();
          requestAnimationFrame(() => this._paint());
          return el;
        }, { label: "Checking every set…" });
      }
      body.replaceChildren(...head, region);
      body.removeEventListener("scroll", this._onScroll);
      body.addEventListener("scroll", this._onScroll, { passive: true });
      body.scrollTop = prevScroll;
      this._keepScroll = true;
      if (hadFocus) {
        search.focus();
        search.setSelectionRange(caret, caret);
      }
      this._paint();
    }

    /** The virtual list for this._entries, or a message when nothing matches. */
    _list() {
      const nRows = this._entries.filter((e) => e.type === "row").length;
      const nPairs = this._entries.filter((e) => e.type === "group").length;
      if (this.countEl) this.countEl.textContent = `${MG.plural(nRows, "claim")} about ${MG.plural(nPairs, "pair")}`;
      if (!nRows && !this._entries.length) return h("div", { class: "empty" }, h("p", null, "Nothing matches these filters."));
      this.list = h("div", { class: "vlist", role: "list" });
      this.inner = h("div", { class: "vlist-inner" });
      this.list.appendChild(this.inner);
      this._width = null;
      this._layout();
      if (this._resize) this._resize.disconnect();
      this._resize = new ResizeObserver(() => {
        if (this.list && this.list.isConnected && Math.abs(this.list.clientWidth - (this._width || 0)) > 1) {
          this._layout();
          this._paint();
        }
      });
      this._resize.observe(this.list);
      return this.list;
    }

    /** Every separating set for each pair (or each pair with `node`). */
    _every(cat, node) {
      const out = new Map();
      for (const p of cat.pairs) {
        if (node && p.x !== node && p.y !== node) continue;
        if (p.adjacent || !p.separable) continue;
        out.set(p, MG.separators.allDSeparators(cat.graph, p.x, p.y, { allowed: cat.graph.recorded, maxSets: EVERY_MAX_SETS, maxChecks: EVERY_MAX_CHECKS }));
      }
      return out;
    }

    _build(cat, f, every) {
      const graph = cat.graph;
      const terms = f.search.trim().toLowerCase().split(/[\s,|]+/).filter(Boolean);
      const out = [];
      for (const p of cat.pairs) {
        if (f.node && p.x !== f.node && p.y !== f.node) continue;
        if (f.hideProxies && (graph.proxies.has(p.x) || graph.proxies.has(p.y))) continue;
        const x = f.node && p.y === f.node ? p.y : p.x;
        const y = x === p.x ? p.y : p.x;
        let rows = [];
        let more = false;
        if (every) {
          const r = every.get(p);
          if (r) {
            rows = r.sets.map((z) => ({ z, minimal: p.separators.some((s) => MG.setEq(s, z)) }));
            more = !r.complete;
          }
        } else if (f.testableOnly) rows = p.testable.map((z) => ({ z, minimal: true }));
        else {
          rows = p.separators.map((z) => ({ z, minimal: true }));
          for (const z of p.testable) if (!p.separators.some((s) => MG.setEq(s, z))) rows.push({ z, extra: true });
        }
        rows = rows.map((r) => {
          const st = new MG.Statement([x], [y], r.z);
          const testable = MG.Statement.testable(graph, st);
          const recorded = testable ? MG.Statement.recordedForm(graph, st) : null;
          return { ...r, st, testable, recorded, showRecorded: !!recorded && recorded !== st.toString(), why: testable ? null : MG.Statement.whyNotTestable(graph, st) };
        });
        if (f.testableOnly) rows = rows.filter((r) => r.testable);
        if (terms.length) rows = rows.filter((r) => matches(terms, r.st.toString() + " " + (r.recorded || "")));
        if (!rows.length) {
          if (f.showNever && !p.separators.length && !terms.length) out.push({ type: "never", pair: p, x, y });
          continue;
        }
        out.push({ type: "group", pair: p, x, y, n: rows.length, more, every: !!every });
        for (const r of rows) out.push({ type: "row", pair: p, ...r });
        if (more) out.push({ type: "more", pair: p, n: rows.length });
      }
      return out;
    }

    _layout() {
      // text width inside a row: list width less the row's insets (8 px each side) and padding
      const listW = this.list.clientWidth || (this.body && this.body.clientWidth) || 400;
      this._width = this.list.clientWidth;
      const w = Math.max(120, listW - 16 - 20);
      const fonts = measureFonts();
      let y = 0;
      for (const e of this._entries) {
        e.top = y;
        if (e.type === "row") {
          e.text = e.text || e.st.pretty() + (e.st.z.size ? "" : "  (marginal)");
          e.wordsText = e.wordsText || words(e.st);
          let hgt = ROW_PAD + ROW_FOOT;
          hgt += LINE_STMT * lineCount(e.text, fonts.stmt, w);
          hgt += LINE_TEXT * lineCount(e.wordsText, fonts.text, w);
          if (e.showRecorded) hgt += LINE_TEXT * lineCount("Check in data: " + e.recorded.replace(/ _\|\|_ /g, " ⊥⊥ "), fonts.text, w);
          e.h = hgt;
        } else e.h = e.type === "group" ? H_GROUP : e.type === "never" ? H_NEVER : H_MORE;
        y += e.h;
      }
      this.total = y + 12;
      this.list.style.height = this.total + "px";
    }

    _paint() {
      if (!this.list || !this.list.isConnected) return;
      const body = this.body;
      const top = body.scrollTop - this.list.offsetTop;
      const view = body.clientHeight;
      const lo = top - 300, hi = top + view + 300;
      let i = lowerBound(this._entries, lo);
      const nodes = [];
      for (; i < this._entries.length && this._entries[i].top < hi; i++) nodes.push(this._entry(this._entries[i]));
      this.inner.replaceChildren(...nodes);
    }

    _entry(e) {
      const style = { position: "absolute", top: e.top + "px", left: "8px", right: "8px", height: e.h + "px" };
      if (e.type === "group")
        return h("div", { class: "group-label", style },
          h("button", { class: "chip", title: `Select ${e.x}`, onClick: () => this.app.selectNode(e.x) }, e.x), "and",
          h("button", { class: "chip", title: `Select ${e.y}`, onClick: () => this.app.selectNode(e.y) }, e.y),
          h("span", { class: "faint", style: { marginLeft: "auto", fontWeight: 500 } },
            e.every ? `independent given ${MG.plural(e.n, "set")}${e.more ? " or more" : ""}` : `independent in ${MG.plural(e.n, "way")}`));
      if (e.type === "never")
        return h("div", { class: "group-label", style, title: e.pair.adjacent ? "An arrow joins them: no set of nodes can make them independent." : "Every set of recorded nodes leaves some path between them open." },
          h("span", { class: "mono" }, `${e.x} · ${e.y}`),
          h("span", { class: "tag never" }, e.pair.adjacent ? "joined by an arrow" : "never independent"));
      if (e.type === "more")
        return h("div", { class: "more-row", style }, `Only the first ${e.n} sets, smallest first, are listed. Filter by a node or open the pair in Query for the rest.`);
      const text = e.st.toString();
      const active = this.store.state.statement === text;
      const tip = [text, words(e.st), e.testable ? `Check in data: ${e.recorded}` : `Not checkable in recorded data: ${e.why}`].join("\n");
      return h("div", { class: ["stmt-row", "wrapped", active ? "is-active" : null], style, role: "listitem", tabindex: 0, title: tip,
          onClick: () => this.app.showStatement(text, { stay: true }),
          onKeydown: (ev) => ev.key === "Enter" && this.app.showStatement(text, { stay: true }) },
        h("div", { class: "stmt-main" },
          statementText(e.st),
          h("div", { class: "in-words" }, words(e.st)),
          e.showRecorded ? h("div", { class: "sub" }, "Check in data: ", recordedText(e.recorded)) : null),
        h("div", { class: "row-tools" },
          e.testable ? h("span", { class: "tag testable", title: "Recorded data can check this claim" }, "checkable") : h("span", { class: "tag never", title: e.why || "" }, "not checkable"),
          e.extra ? h("span", { class: "tag", title: "Not minimal: indicators added so the claim can be checked in recorded data" }, "+ indicators") : null,
          e.minimal === false ? h("span", { class: "tag", title: "Not minimal: a smaller set also works" }, "larger set") : null,
          h("button", { class: "row-btn", title: "Copy", "aria-label": "Copy statement", onClick: (ev) => { ev.stopPropagation(); MG.ui.copyText(text); } }, icon("copy")),
          h("button", { class: "row-btn", title: "Why? Open it in Query to see every path", "aria-label": "Open in Query", onClick: (ev) => { ev.stopPropagation(); this.app.showStatement(text); } }, icon("arrow"))));
    }

    _csv(cat) {
      const lines = ["x,y,given,statement,in_words,minimal,checkable_in_data,how_to_check"];
      for (const e of this._entries) if (e.type === "row")
        lines.push([[...e.st.x][0], [...e.st.y][0], MG.sorted(e.st.z).join(", "), e.st.toString(), words(e.st), e.minimal === false ? "no" : "yes", e.testable ? "yes" : "no", e.testable ? e.recorded : e.why || ""].map(csvCell).join(","));
      MG.ui.download(`${slug(cat.graph.name)}-conditions.csv`, lines.join("\n") + "\n", "text/csv");
      MG.ui.toast(`Saved ${MG.plural(lines.length - 1, "claim")}`);
    }
  }

  /** Fonts of a statement line and of a text line, read from the stylesheet once. */
  let fontCache = null;
  function measureFonts() {
    if (fontCache) return fontCache;
    const probe = (cls) => {
      const el = h("div", { class: cls, style: { position: "absolute", visibility: "hidden" } }, "x");
      const host = h("div", { class: "stmt-row wrapped" }, el);
      document.body.appendChild(host);
      const cs = getComputedStyle(el);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      host.remove();
      return font;
    };
    fontCache = { stmt: probe("stmt"), text: probe("in-words") };
    return fontCache;
  }

  const canvas = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  /** Lines a text takes at a width when it wraps at spaces (and anywhere inside a word too long for a line). */
  function lineCount(text, font, width) {
    canvas.font = font;
    const space = canvas.measureText(" ").width;
    let lines = 1, x = 0;
    for (const word of text.split(" ")) {
      let wlen = canvas.measureText(word).width;
      if (x > 0 && x + space + wlen <= width) {
        x += space + wlen;
        continue;
      }
      if (x > 0) lines++;
      while (wlen > width) {
        lines++;
        wlen -= width;
      }
      x = wlen;
    }
    return lines;
  }

  /** The claim in plain words. */
  function words(st) {
    const list = (s) => {
      const a = MG.sorted(s);
      return a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
    };
    const X = list(st.x), Y = list(st.y);
    if (!st.z.size) return `${X} and ${Y} are independent: knowing one tells you nothing about the other.`;
    return `Once you know ${list(st.z)}, ${X} tells you nothing more about ${Y}.`;
  }

  function recordedText(text) {
    return h("span", { class: "mono" }, text.replace(/ _\|\|_ /g, " ⊥⊥ "));
  }

  /** How to read the list, for someone new to graphs. */
  function guide() {
    const li = (b, rest) => h("li", null, h("b", null, b), " ", rest);
    return h("details", { class: "guide" },
      h("summary", null, "New here? How to read and use this list"),
      h("ul", null,
        li("Each line is a claim the graph makes.", h("span", null, "“A ⊥⊥ B | C” reads “A is independent of B once C is known”: ⊥⊥ means independent, | means given.")),
        li("Minimal sets", "are the smallest sets that make a pair independent: drop any node and the claim fails."),
        li("Every set", "also lists larger sets. They are checked one by one, because adding a node can break an independence (conditioning on a common effect opens a path)."),
        li("Checkable", "claims use only values your data records. To check one, look within each combination of the given values: the two variables should show no association (for example a chi-square test or a regression coefficient near zero). A checkable claim your data reject means the graph is wrong somewhere."),
        li("Not checkable", "claims involve values that are missing in a way the data cannot reveal (Mohan & Pearl 2021, Theorem 4), or an unmeasured variable."),
        li("What to do:", "click a line, or its arrow, to see why it holds path by path in Query. Turn on “Checkable only” and download the CSV for a checklist to run on your data.")));
  }

  function matches(terms, text) {
    const t = text.toLowerCase();
    return terms.every((term) => t.includes(term));
  }

  function lowerBound(entries, y) {
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].top + entries[mid].h < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function csvCell(v) {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "graph";
  }

  function stat(value, label) {
    return h("div", { class: "stat" }, h("b", null, value.toLocaleString("en-US")), h("span", null, label));
  }

  MG.ui.ConditionsPanel = ConditionsPanel;
  MG.ui.slug = slug;
  MG.ui.statementWords = words;
})(globalThis.MG);
