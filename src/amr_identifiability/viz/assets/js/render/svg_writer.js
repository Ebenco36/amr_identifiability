/* Scene -> standalone SVG text. */
(function (MG) {
  "use strict";

  function toSvg(scene, { title = "" } = {}) {
    const esc = MG.escapeXml;
    const f = (v) => +(+v).toFixed(2);
    const out = [];
    out.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" font-family="${MG.metrics.FONT_FAMILY}">`
    );
    if (title) out.push(`<title>${esc(title)}</title>`);
    for (const it of scene.items) {
      const op = it.opacity !== undefined && it.opacity < 1 ? ` opacity="${f(it.opacity)}"` : "";
      if (it.kind === "path") {
        const fill = it.fill ? ` fill="${it.fill}"` : ` fill="none"`;
        const stroke = it.stroke ? ` stroke="${it.stroke}" stroke-width="${f(it.width || 1)}" stroke-linejoin="round" stroke-linecap="round"` : "";
        const dash = it.dash ? ` stroke-dasharray="${it.dash.join(" ")}"` : "";
        out.push(`<path d="${MG.geometry.toSvgPath(it.d)}"${fill}${stroke}${dash}${op}/>`);
      } else if (it.kind === "text") {
        const anchor = it.anchor && it.anchor !== "start" ? ` text-anchor="${it.anchor}"` : "";
        const weight = it.bold ? ` font-weight="bold"` : "";
        out.push(`<text x="${f(it.x)}" y="${f(it.y)}" font-size="${f(it.size)}" fill="${it.fill}"${anchor}${weight}${op}>${esc(it.text)}</text>`);
      }
    }
    out.push("</svg>");
    return out.join("\n");
  }

  MG.svgWriter = { toSvg };
})(globalThis.MG);
