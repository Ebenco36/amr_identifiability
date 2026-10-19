/* Node shapes and edge geometry.
 *
 * Shapes are lists of path commands (["M",x,y], ["L",x,y], ["C",x1,y1,x2,y2,x,y], ["Z"]) relative
 * to the node centre, so the SVG writer, the PDF writer and the live view draw the same outline.
 * Each role has its own shape, so a role never depends on colour alone:
 *
 *   fully observed        rounded rectangle
 *   partially observed    rounded rectangle with a second, inner outline
 *   missingness indicator hexagon with pointed ends
 *   recorded proxy        stadium (fully rounded ends)
 *   latent                ellipse, dashed outline
 */
(function (MG) {
  "use strict";

  const LABEL_SIZE = 13;
  const HEIGHT = 28;
  const PAD_X = 11;
  const K = 0.5522847498; // cubic Bezier circle constant

  function nodeSize(id, role) {
    const w = Math.max(38, MG.metrics.textWidth(id, LABEL_SIZE) + 2 * PAD_X);
    if (role === "latent") return { w: w + 10, h: HEIGHT + 6 };
    if (role === "missingness indicator") return { w: w + 10, h: HEIGHT };
    return { w, h: HEIGHT };
  }

  function roundedRect(w, h, r) {
    const x = -w / 2, y = -h / 2;
    r = Math.min(r, w / 2, h / 2);
    const c = r * (1 - K);
    return [
      ["M", x + r, y],
      ["L", x + w - r, y],
      ["C", x + w - c, y, x + w, y + c, x + w, y + r],
      ["L", x + w, y + h - r],
      ["C", x + w, y + h - c, x + w - c, y + h, x + w - r, y + h],
      ["L", x + r, y + h],
      ["C", x + c, y + h, x, y + h - c, x, y + h - r],
      ["L", x, y + r],
      ["C", x, y + c, x + c, y, x + r, y],
      ["Z"],
    ];
  }

  function ellipse(rx, ry) {
    const kx = rx * K, ky = ry * K;
    return [
      ["M", rx, 0],
      ["C", rx, ky, kx, ry, 0, ry],
      ["C", -kx, ry, -rx, ky, -rx, 0],
      ["C", -rx, -ky, -kx, -ry, 0, -ry],
      ["C", kx, -ry, rx, -ky, rx, 0],
      ["Z"],
    ];
  }

  function hexagon(w, h) {
    const d = h / 2.6, x = w / 2, y = h / 2;
    return [["M", -x + d, -y], ["L", x - d, -y], ["L", x, 0], ["L", x - d, y], ["L", -x + d, y], ["L", -x, 0], ["Z"]];
  }

  /** Outline commands, plus an optional inner outline for partially observed nodes. */
  function nodeShape(role, w, h) {
    switch (role) {
      case "latent":
        return { outline: ellipse(w / 2, h / 2) };
      case "missingness indicator":
        return { outline: hexagon(w, h) };
      case "recorded proxy":
        return { outline: roundedRect(w, h, h / 2) };
      case "partially observed":
        return { outline: roundedRect(w, h, 7), inner: roundedRect(w - 6, h - 6, 4.5) };
      default:
        return { outline: roundedRect(w, h, 7) };
    }
  }

  /** Flatten an outline into a polygon for ray intersection. */
  function flatten(cmds, steps = 8) {
    const pts = [];
    let cx = 0, cy = 0, sx = 0, sy = 0;
    for (const c of cmds) {
      if (c[0] === "M") {
        cx = sx = c[1];
        cy = sy = c[2];
        pts.push([cx, cy]);
      } else if (c[0] === "L") {
        cx = c[1];
        cy = c[2];
        pts.push([cx, cy]);
      } else if (c[0] === "C") {
        const [, x1, y1, x2, y2, x, y] = c;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, u = 1 - t;
          pts.push([
            u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
            u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
          ]);
        }
        cx = x;
        cy = y;
      } else if (c[0] === "Z") {
        cx = sx;
        cy = sy;
      }
    }
    return pts;
  }

  /** Distance from the centre to the outline along direction (dx, dy). */
  function rayDistance(poly, dx, dy) {
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (ax * ey - ay * ex) / den;
      const s = (ax * dy - ay * dx) / den;
      if (t > 0 && s >= -1e-6 && s <= 1 + 1e-6 && t < best) best = t;
    }
    return best === Infinity ? 0 : best;
  }

  /** Layout of one node: size, shape and the polygon used to clip edges. */
  function nodeLayout(id, role) {
    const { w, h } = nodeSize(id, role);
    const shape = nodeShape(role, w, h);
    return { id, role, w, h, shape, poly: flatten(shape.outline) };
  }

  const ARROW_LENGTH = 9;
  const ARROW_HALF = 4.4;
  const GAP = 2;

  /**
   * An edge between two placed nodes: the line (start, end) and the arrowhead triangle.
   * a, b are {x, y, layout}.
   */
  function edgeGeometry(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const da = rayDistance(a.layout.poly, ux, uy) + GAP;
    const db = rayDistance(b.layout.poly, -ux, -uy) + GAP;
    const sx = a.x + ux * da, sy = a.y + uy * da;
    const tx = b.x - ux * db, ty = b.y - uy * db;
    const bx = tx - ux * ARROW_LENGTH, by = ty - uy * ARROW_LENGTH;
    const px = -uy * ARROW_HALF, py = ux * ARROW_HALF;
    const head = [["M", tx, ty], ["L", bx + px, by + py], ["L", bx - px, by - py], ["Z"]];
    // the line stops inside the arrowhead so its end is hidden by the fill
    const ex = tx - ux * ARROW_LENGTH * 0.7, ey = ty - uy * ARROW_LENGTH * 0.7;
    return { x1: sx, y1: sy, x2: ex, y2: ey, tipX: tx, tipY: ty, head, visible: len > da + db + 1 };
  }

  function translate(cmds, x, y) {
    return cmds.map((c) => {
      if (c[0] === "Z") return c;
      const out = [c[0]];
      for (let i = 1; i < c.length; i += 2) out.push(c[i] + x, c[i + 1] + y);
      return out;
    });
  }

  function toSvgPath(cmds, digits = 2) {
    const f = (v) => +v.toFixed(digits);
    return cmds.map((c) => (c[0] === "Z" ? "Z" : c[0] + c.slice(1).map(f).join(" "))).join("");
  }

  MG.geometry = { LABEL_SIZE, HEIGHT, nodeLayout, nodeShape, edgeGeometry, translate, toSvgPath, rayDistance, flatten };
})(globalThis.MG);
