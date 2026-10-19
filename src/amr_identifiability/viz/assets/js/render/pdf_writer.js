/* Scene -> vector PDF (PDF 1.4, one page, built-in Helvetica, no dependencies).
 *
 * Returns a "binary string" (one char per byte, all < 256); MG.pdfWriter.toBytes converts it to
 * a Uint8Array for download. Text uses WinAnsi encoding; characters outside it are replaced.
 */
(function (MG) {
  "use strict";

  const WINANSI_EXTRA = { "–": "\x96", "—": "\x97", "‘": "\x91", "’": "\x92", "“": "\x93", "”": "\x94", "•": "\x95", "·": "\xB7", "×": "\xD7", "…": "\x85" };
  const ASCII_SWAP = { "→": "->", "←": "<-", "⊥⊥": "_||_", "⫫": "_||_", "⊥": "_|_", "≤": "<=", "≥": ">=", "✓": "", "✗": "x" };

  function encodeText(s) {
    let t = String(s);
    for (const [k, v] of Object.entries(ASCII_SWAP)) t = t.split(k).join(v);
    let out = "";
    for (const ch of t) {
      const c = ch.codePointAt(0);
      let b;
      if (c >= 32 && c <= 126) b = ch;
      else if (WINANSI_EXTRA[ch]) b = WINANSI_EXTRA[ch];
      else if (c >= 0xa0 && c <= 0xff) b = String.fromCharCode(c);
      else b = "?";
      if (b === "(" || b === ")" || b === "\\") b = "\\" + b;
      out += b;
    }
    return out;
  }

  function rgb(hex) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => +(v / 255).toFixed(4)).join(" ");
  }

  const num = (v) => +(+v).toFixed(2);

  function toPdf(scene, { title = "", producer = "amr-identifiability" } = {}) {
    const H = scene.height;
    const gstates = new Map();
    const gs = (opacity) => {
      const o = +(opacity === undefined ? 1 : opacity).toFixed(3);
      if (o >= 1) return "";
      if (!gstates.has(o)) gstates.set(o, `GS${gstates.size}`);
      return `/${gstates.get(o)} gs `;
    };
    const ops = [];
    for (const it of scene.items) {
      if (it.kind === "path") {
        let s = "q " + gs(it.opacity);
        if (it.fill) s += `${rgb(it.fill)} rg `;
        if (it.stroke) s += `${rgb(it.stroke)} RG ${num(it.width || 1)} w 1 j 1 J `;
        s += it.dash ? `[${it.dash.map(num).join(" ")}] 0 d ` : "";
        for (const c of it.d) {
          if (c[0] === "M") s += `${num(c[1])} ${num(H - c[2])} m `;
          else if (c[0] === "L") s += `${num(c[1])} ${num(H - c[2])} l `;
          else if (c[0] === "C") s += `${num(c[1])} ${num(H - c[2])} ${num(c[3])} ${num(H - c[4])} ${num(c[5])} ${num(H - c[6])} c `;
          else if (c[0] === "Z") s += "h ";
        }
        s += it.fill && it.stroke ? "B" : it.fill ? "f" : "S";
        ops.push(s + " Q");
      } else if (it.kind === "text") {
        const w = MG.metrics.textWidth(it.text, it.size, it.bold);
        const x = it.anchor === "middle" ? it.x - w / 2 : it.anchor === "end" ? it.x - w : it.x;
        ops.push(`q ${gs(it.opacity)}${rgb(it.fill)} rg BT /${it.bold ? "F2" : "F1"} ${num(it.size)} Tf ${num(x)} ${num(H - it.y)} Td (${encodeText(it.text)}) Tj ET Q`);
      }
    }
    const content = ops.join("\n");
    const ext = [...gstates].map(([o, name]) => `/${name} << /ca ${o} /CA ${o} >>`).join(" ");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${scene.width} ${scene.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /ExtGState << ${ext} >> >> /Contents 6 0 R >>`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Title (${encodeText(title)}) /Producer (${encodeText(producer)}) >>`,
    ];
    let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) pdf += String(o).padStart(10, "0") + " 00000 n \n";
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return pdf;
  }

  function toBytes(binary) {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 255;
    return bytes;
  }

  MG.pdfWriter = { toPdf, toBytes, encodeText };
})(globalThis.MG);
