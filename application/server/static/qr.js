// Desenha um QR code como SVG a partir do texto, com o qrcode.js embutido (global qrcode). Sempre preto sobre branco,
// com a margem de 4 módulos da norma, em qualquer tema: leitores de QR precisam do contraste e da margem

const QUIET = 4;
const SVG_NS = "http://www.w3.org/2000/svg";

// Matriz de módulos do QR (true = escuro). Nível de correção M, versão mínima que couber
export function qrMatrix(text) {
  const qr = globalThis.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

export function qrSvg(text, label) {
  const m = qrMatrix(text);
  const size = m.length + 2 * QUIET;
  let d = "";
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) if (m[r][c]) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}
