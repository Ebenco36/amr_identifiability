/* Namespace and small helpers shared by every module.
 *
 * Modules attach to the global MG namespace so that the page works as one offline file
 * (opened from disk, ES modules are blocked) and so that Node can load the same files for
 * tests and for figure export from Python. Load order is set in viz/page.py.
 */
(function (root) {
  "use strict";
  const MG = (root.MG = root.MG || {});

  MG.R_PREFIX = "R_";
  MG.PROXY_SUFFIX = "_star";

  /** Sorted copy of an iterable of strings (code-unit order, the same as Python's sorted). */
  MG.sorted = (items) => Array.from(items).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  /** Compare two sets for equality. */
  MG.setEq = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

  /** a is a proper subset of b. */
  MG.properSubset = (a, b) => a.size < b.size && [...a].every((v) => b.has(v));

  MG.subset = (a, b) => [...a].every((v) => b.has(v));

  /** Order separating sets as Python does: by size, then by sorted members. */
  MG.compareSets = (a, b) => {
    if (a.size !== b.size) return a.size - b.size;
    const sa = MG.sorted(a), sb = MG.sorted(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
    return 0;
  };

  MG.setKey = (s) => MG.sorted(s).join("\u0001");

  MG.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  MG.escapeXml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * A time limit for the recovery and identification searches. null (the default, and what the
   * tests and Python use) means no limit. The page sets one around a question so that no graph can
   * freeze it; a search that runs out of time throws MG.TimeUp, which the page reports as "no verdict
   * yet", never as "not recoverable". Nothing is cached from a search that was cut short.
   */
  MG.deadline = null;
  MG.TimeUp = class TimeUp extends Error {
    constructor() {
      super("the search ran out of time");
      this.name = "TimeUp";
    }
  };
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  MG.checkTime = () => {
    if (MG.deadline !== null && now() > MG.deadline) throw new MG.TimeUp();
  };
  MG.withDeadline = (ms, fn) => {
    const before = MG.deadline;
    MG.deadline = now() + ms;
    try {
      return fn();
    } finally {
      MG.deadline = before;
    }
  };

  MG.plural = (n, word, many) => `${n.toLocaleString("en-US")} ${n === 1 ? word : many || word + "s"}`;
})(typeof globalThis !== "undefined" ? globalThis : window);
