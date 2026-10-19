/* Text measurement with the standard Helvetica metrics (Adobe AFM, characters 32-126).
 *
 * The live view, the SVG and the PDF all size labels with these widths, so a figure has the
 * same geometry in every format. PDF uses the built-in Helvetica fonts, which need no embedding.
 */
(function (MG) {
  "use strict";

  // prettier-ignore
  const REGULAR = [278,278,355,556,556,889,667,222,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,222,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  // prettier-ignore
  const BOLD = [278,333,474,556,556,889,722,278,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,278,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

  function textWidth(text, size, bold = false) {
    const table = bold ? BOLD : REGULAR;
    let w = 0;
    for (const ch of String(text)) {
      const c = ch.codePointAt(0);
      w += c >= 32 && c <= 126 ? table[c - 32] : 556;
    }
    return (w * size) / 1000;
  }

  /** Greedy word wrap to a maximum width. */
  function wrap(text, size, maxWidth, bold = false) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const next = line ? line + " " + w : w;
      if (line && textWidth(next, size, bold) > maxWidth) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  MG.metrics = { textWidth, wrap, FONT_FAMILY: "Helvetica, Arial, sans-serif" };
})(globalThis.MG);
