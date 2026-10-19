/* MG.ui.deferred: long searches in the panels.
 *
 * A panel draws its question at once and leaves a placeholder; the search runs after the browser
 * has painted, under a time limit (MG.withDeadline), and its answer replaces the placeholder.
 * Answers are cached per graph object (a new object for every edit) and question, so switching
 * tabs or re-rendering is instant. A search that runs out of time is reported as "no verdict
 * yet" with a button to search longer; it is never shown as a negative answer.
 */
(function (MG) {
  "use strict";
  const { h, icon } = MG.ui;

  const QUICK_MS = 4000;
  const LONG_MS = 30000;
  const cache = new WeakMap(); // owner -> Map(key -> entry)

  function entries(owner) {
    if (!cache.has(owner)) cache.set(owner, new Map());
    return cache.get(owner);
  }

  /** Run fn under a time limit: {value} | {error} | {timeUp: ms}. Only finished answers are kept. */
  function run(owner, key, fn, ms) {
    let entry;
    try {
      entry = { value: MG.withDeadline(ms, fn) };
    } catch (e) {
      entry = e instanceof MG.TimeUp ? { timeUp: ms } : { error: e };
    }
    const prev = entries(owner).get(key);
    if (!entry.timeUp || !prev || !prev.value) entries(owner).set(key, entry);
    return entry;
  }

  /**
   * An element for one question. `render(entry, retry)` turns an entry into DOM; for a timed-out
   * entry, `retry()` searches again for up to 30 s.
   */
  function slot(owner, key, fn, render, { label = "Working it out…", ms = QUICK_MS } = {}) {
    const box = h("div", { class: "deferred" });
    const show = (entry) => box.replaceChildren(render(entry, () => start(LONG_MS, "Searching for up to 30 seconds…")));
    const start = (budget, text) => {
      box.replaceChildren(pending(text));
      // two frames: the placeholder is painted before the search blocks the page
      requestAnimationFrame(() => setTimeout(() => {
        if (!box.isConnected) return;
        show(run(owner, key, fn, budget));
      }, 0));
    };
    const hit = entries(owner).get(key);
    if (hit) show(hit);
    else start(ms, label);
    return box;
  }

  // ---------------------------------------------------------------- background worker

  /*
   * Searches that can take long (a causal effect with a partially observed treatment) run in a Web
   * Worker built from the page's own engine (the script element "mg-core"), so the page never freezes and
   * the user can cancel. Results are plain data. Without worker support the time-limited search
   * above runs instead.
   */
  const WORKER_MS = 120000;
  const WORKER_SRC = `
    const graphs = new Map();
    self.onmessage = (ev) => {
      const { id, kind, sig, model, args, ms } = ev.data;
      try {
        if (!graphs.has(sig)) graphs.set(sig, MG.Graph.fromPayload(model));
        const g = graphs.get(sig);
        const run = { effect: () => MG.causal.effect(g, ...args) }[kind];
        self.postMessage({ id, value: MG.withDeadline(ms, run) });
      } catch (e) {
        self.postMessage({ id, timeUp: e instanceof MG.TimeUp ? ms : 0, error: e instanceof MG.TimeUp ? null : String(e && e.message || e) });
      }
    };`;
  let worker = null, workerUrl = null, nextId = 1;
  const waiting = new Map();

  function getWorker() {
    if (worker) return worker;
    try {
      if (typeof Worker === "undefined") return null;
      const core = document.getElementById("mg-core");
      if (!core) return null;
      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([core.textContent, ";\n", WORKER_SRC], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
      worker.onmessage = (ev) => {
        const cb = waiting.get(ev.data.id);
        if (!cb) return;
        waiting.delete(ev.data.id);
        cb(ev.data);
      };
      worker.onerror = (ev) => {
        ev.preventDefault();
        reset({ error: new Error("The background search stopped unexpectedly.") });
      };
      return worker;
    } catch (e) {
      return null;
    }
  }

  /** Stop the worker (and with it every search in flight); each waiting caller hears `entry`. */
  function reset(entry) {
    if (worker) worker.terminate();
    worker = null;
    const cbs = [...waiting.values()];
    waiting.clear();
    for (const cb of cbs) cb(entry);
  }

  function modelOf(graph) {
    return { nodes: graph.ids.map((id) => ({ ...graph.meta.get(id), id, latent: graph.latent.has(id) })), edges: graph.edges };
  }

  /**
   * Like slot(), but the search runs in the background worker: `job` is {kind, args}. The
   * placeholder shows the elapsed time and a Cancel button. Leaving the tab does not stop the
   * search: coming back shows it still running, or its answer. Without worker support this is
   * slot() with `fn`.
   */
  const inflight = new Map(); // graph signature + key -> {id, t0, listeners}

  function slotInWorker(graph, key, job, fn, render, { label = "Working it out…" } = {}) {
    const hit = entries(graph).get(key);
    if (hit) return wrapRender(render, hit, null);
    if (!getWorker()) return slot(graph, key, fn, render, { label });
    const box = h("div", { class: "deferred" });
    const full = `${sigOf(graph)}|${key}`;
    const attach = () => {
      if (!getWorker()) return box.replaceChildren(slot(graph, key, fn, render, { label }));
      const f = inflight.get(full) || launch(graph, key, full, job);
      const clock = h("span", { class: "faint" }, "");
      const tick = () => (clock.textContent = ` ${Math.floor((performance.now() - f.t0) / 1000)} s`);
      tick();
      const timer = setInterval(() => (box.isConnected ? tick() : clearInterval(timer)), 500);
      box.replaceChildren(h("div", { class: "pending", role: "status", "aria-live": "polite" },
        h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, label, clock),
        h("button", { type: "button", class: "btn small", style: { marginLeft: "auto" }, onClick: () => reset({ cancelled: true }) }, "Cancel")));
      f.listeners.add((entry) => {
        clearInterval(timer);
        if (box.isConnected) box.replaceChildren(entry.cancelled ? cancelled(attach) : render(entry, null));
      });
    };
    attach();
    return box;
  }

  function launch(graph, key, full, job) {
    const id = nextId++;
    const f = { id, t0: performance.now(), listeners: new Set() };
    inflight.set(full, f);
    waiting.set(id, (msg) => {
      inflight.delete(full);
      const entry = msg.cancelled ? { cancelled: true } : msg.timeUp ? { timeUp: msg.timeUp }
        : msg.error ? { error: msg.error instanceof Error ? msg.error : new Error(msg.error) } : { value: msg.value };
      if (entry.value || (entry.error && !/stopped unexpectedly/.test(entry.error.message))) entries(graph).set(key, entry);
      for (const l of f.listeners) l(entry);
    });
    worker.postMessage({ id, kind: job.kind, sig: sigOf(graph), model: modelOf(graph), args: job.args, ms: WORKER_MS });
    return f;
  }

  function wrapRender(render, entry, retry) {
    const box = h("div", { class: "deferred" });
    box.appendChild(render(entry, retry));
    return box;
  }

  function cancelled(restart) {
    return h("div", { class: "verdict err" }, h("b", null, "Search cancelled"), h("span", { class: "why" }, "No verdict was reached."),
      h("button", { class: "btn small", style: { marginTop: "8px", justifySelf: "start" }, onClick: restart }, "Search again"));
  }

  const sigs = new WeakMap();
  function sigOf(graph) {
    if (!sigs.has(graph)) sigs.set(graph, `${graph.ids.join(",")}|${graph.edges.map((e) => e.join(">")).join(",")}|${MG.sorted(graph.latent).join(",")}`);
    return sigs.get(graph);
  }

  function pending(text) {
    return h("div", { class: "pending", role: "status", "aria-live": "polite" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", null, text));
  }

  /** The standard message for a search that ran out of time. */
  function timeUp(entry, retry, what = "this question") {
    const secs = Math.round(entry.timeUp / 1000);
    return h("div", { class: "verdict err" },
      h("b", null, `No verdict yet on ${what}`),
      h("span", { class: "why" }, `The search for a formula stopped after ${secs} s without finding one or proving there is none. That is not a negative answer.`),
      entry.timeUp < LONG_MS && retry ? h("button", { class: "btn small", style: { marginTop: "8px", justifySelf: "start" }, onClick: retry }, icon("search"), "Keep searching (up to 30 s)") : null);
  }

  MG.ui.deferred = { slot, slotInWorker, timeUp, run, reset, QUICK_MS, LONG_MS, WORKER_MS };
})(globalThis.MG);
