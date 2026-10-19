/* d-separation and path analysis.
 *
 * dSeparated: the reachability ("Bayes-ball") algorithm of Koller & Friedman (2009, Alg. 3.1).
 * paths:      simple paths in the skeleton, each marked open or blocked with the reason, using
 *             the same wording as MGraph.paths in Python.
 */
(function (MG) {
  "use strict";

  function dSeparated(graph, X, Y, Z = []) {
    X = new Set(X);
    Y = new Set(Y);
    Z = new Set(Z);
    const anc = graph.ancestralClosure(Z); // Z and its ancestors: colliders here are opened
    const visited = new Set();
    const queue = [];
    for (const x of X) queue.push([x, "up"]);
    while (queue.length) {
      const [n, dir] = queue.pop();
      const k = n + "|" + dir;
      if (visited.has(k)) continue;
      visited.add(k);
      if (!Z.has(n) && Y.has(n)) return false;
      if (dir === "up" && !Z.has(n)) {
        for (const p of graph.parents(n)) queue.push([p, "up"]);
        for (const c of graph.children(n)) queue.push([c, "down"]);
      } else if (dir === "down") {
        if (!Z.has(n)) for (const c of graph.children(n)) queue.push([c, "down"]);
        if (anc.has(n)) for (const p of graph.parents(n)) queue.push([p, "up"]);
      }
    }
    return true;
  }

  /** Is the statement implied by the graph? Checks node names and overlaps first. */
  function implies(graph, statement) {
    statement.check(graph);
    return dSeparated(graph, statement.x, statement.y, statement.z);
  }

  /** Status of one path given Z; forward[i] is true when the edge points path[i] -> path[i+1]. */
  function pathStatus(graph, path, Z) {
    const forward = [];
    for (let i = 0; i < path.length - 1; i++) forward.push(graph.hasEdge(path[i], path[i + 1]));
    for (let i = 1; i < path.length - 1; i++) {
      const node = path[i];
      const collider = forward[i - 1] && !forward[i];
      if (collider) {
        if (!Z.has(node) && ![...graph.descendants(node)].some((d) => Z.has(d)))
          return { path, forward, open: false, blocker: node, reason: `collider ${node} not conditioned on` };
      } else if (Z.has(node)) {
        return { path, forward, open: false, blocker: node, reason: `${node} conditioned on` };
      }
    }
    return { path, forward, open: true, blocker: null, reason: "no blocking node" };
  }

  /**
   * Simple paths between x and y with their status.
   * With onlyOpen, branches are pruned as soon as an inner node blocks, so open paths are found
   * quickly even in dense graphs. Results are sorted shortest first.
   */
  function paths(graph, x, y, Z = [], { onlyOpen = false, maxPaths = 300, maxLength = 14 } = {}) {
    Z = new Set(Z);
    const zAnc = graph.ancestralClosure(Z);
    const out = [];
    let truncated = false;
    const path = [x];
    const forward = [];
    const onPath = new Set([x]);

    const innerBlocks = (i) => {
      // the inner node path[i], with edges forward[i-1] and forward[i]
      const node = path[i];
      const collider = forward[i - 1] && !forward[i];
      return collider ? !zAnc.has(node) : Z.has(node);
    };

    const step = (n) => {
      if (out.length >= maxPaths) {
        truncated = true;
        return;
      }
      for (const [m, fwd] of neighbourEdges(n)) {
        if (onPath.has(m)) continue;
        path.push(m);
        forward.push(fwd);
        const i = path.length - 2; // n is now an inner node when it is not x
        const prunable = onlyOpen && i >= 1 && innerBlocks(i);
        if (!prunable) {
          if (m === y) {
            const st = pathStatus(graph, path.slice(), Z);
            if (st.open || !onlyOpen) out.push(st);
          } else if (path.length <= maxLength) {
            onPath.add(m);
            step(m);
            onPath.delete(m);
          }
        }
        path.pop();
        forward.pop();
        if (out.length >= maxPaths) {
          truncated = true;
          return;
        }
      }
    };

    const neighbourEdges = (n) => {
      const list = [];
      for (const c of MG.sorted(graph.children(n))) list.push([c, true]);
      for (const p of MG.sorted(graph.parents(n))) list.push([p, false]);
      return list;
    };

    step(x);
    out.sort((a, b) => a.path.length - b.path.length || (a.path.join() < b.path.join() ? -1 : 1));
    return { paths: out, truncated };
  }

  /** Text form used by the Python CLI: "Yk <- U_B -> Yj1". */
  function formatPath(p) {
    const parts = [];
    for (let i = 0; i < p.path.length - 1; i++) parts.push(p.path[i], p.forward[i] ? "→" : "←");
    parts.push(p.path[p.path.length - 1]);
    return parts.join(" ");
  }

  MG.dsep = { dSeparated, implies, pathStatus, paths, formatPath };
})(globalThis.MG);
