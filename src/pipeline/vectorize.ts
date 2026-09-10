/**
 * Mascara binaria -> MultiPolygon (bbox por componente conexa 4-vizinhanca).
 * Saida em EPSG:4326 via projecao inversa do grid UTM. Puro e testavel.
 */
import proj4 from 'proj4';

export interface BBoxPoly { ring: number[][]; px: number; }

export function components(
  mask: Uint8Array, W: number, H: number, minPx = 50, maxPolys = 50,
): Array<{ c0: number; r0: number; c1: number; r1: number; px: number }> {
  const seen = new Uint8Array(W * H);
  const out: Array<{ c0: number; r0: number; c1: number; r1: number; px: number }> = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || seen[i]) continue;
    let c0 = W, r0 = H, c1 = -1, r1 = -1, px = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length > 0) {
      const j = stack.pop()!;
      const c = j % W, r = (j / W) | 0;
      px++;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      if (c > 0 && mask[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
      if (c < W - 1 && mask[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
      if (r > 0 && mask[j - W] && !seen[j - W]) { seen[j - W] = 1; stack.push(j - W); }
      if (r < H - 1 && mask[j + W] && !seen[j + W]) { seen[j + W] = 1; stack.push(j + W); }
    }
    if (px >= minPx) out.push({ c0, r0, c1, r1, px });
  }
  out.sort((a, b) => b.px - a.px);
  return out.slice(0, maxPolys);
}

/** Bbox de pixels -> anel lon/lat fechado (fallback quando o traçado falha). */
export function pixelBboxToRing(
  c0: number, r0: number, c1: number, r1: number,
  originX: number, originY: number, res: number, utmDef: string,
): Array<[number, number]> {
  const x0 = originX + c0 * res, x1 = originX + (c1 + 1) * res;
  const y1 = originY - r0 * res, y0 = originY - (r1 + 1) * res;
  const inv = (x: number, y: number) => proj4(utmDef, 'EPSG:4326', [x, y]) as [number, number];
  const ring = [inv(x0, y0), inv(x1, y0), inv(x1, y1), inv(x0, y1)].map(
    ([lon, lat]): [number, number] => [
      Math.min(180, Math.max(-180, lon)), Math.min(90, Math.max(-90, lat)),
    ],
  );
  ring.push([...ring[0]]);
  return ring;
}

export function maskToMultiPolygon(
  mask: Uint8Array, W: number, H: number,
  originX: number, originY: number, res: number, utmDef: string, minPx = 50,
): { type: 'MultiPolygon'; coordinates: number[][][][] } | null {
  const comps = components(mask, W, H, minPx);
  if (comps.length === 0) return null;
  const toLonLat = (px: number, py: number): [number, number] => {
    const [lon, lat] = proj4(utmDef, 'EPSG:4326', [originX + px * res, originY - py * res]) as [number, number];
    return [Math.min(180, Math.max(-180, lon)), Math.min(90, Math.max(-90, lat))];
  };
  const polys: number[][][][] = [];
  let budget = 4000; // teto de vertices por task (protocolo: anel<=1000)
  for (const k of comps) {
    if (budget <= 0) break;
    try {
      let corners = traceContour(mask, W, H, k.c0, k.r0, k.c1, k.r1);
      // simplifica até caber no protocolo (anel<=1000 pts)
      let tol = 1.5;
      while (corners.length > 900 && tol < 32) {
        tol *= 2;
        corners = simplifyRing(corners, tol);
      }
      if (corners.length < 4 || corners.length > 1000) {
        corners = pixelBboxToRing(k.c0, k.r0, k.c1, k.r1, originX, originY, res, utmDef);
      }
      budget -= corners.length;
      polys.push([corners.map(([x, y]) => toLonLat(x, y))]);
    } catch {
      polys.push([pixelBboxToRing(k.c0, k.r0, k.c1, k.r1, originX, originY, res, utmDef)]);
    }
  }
  return polys.length > 0 ? { type: 'MultiPolygon', coordinates: polys } : null;
}

/**
 * Douglas-Peucker em anel fechado (unidades de pixel). Preserva 1o/ultimo.
 * Reduz milhares de vertices de contorno real para centenas sem mudar a forma.
 */
export function simplifyRing(ring: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (ring.length <= 8) return ring;
  const open = ring.slice(0, -1); // sem o fecho duplicado p/ simplificar
  const keep = new Uint8Array(open.length);
  keep[0] = 1;
  keep[open.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, open.length - 1]];
  const distToSeg = (p: [number, number], a: [number, number], b: [number, number]): number => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    if (e - s < 2) continue;
    let dmax = 0, imax = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSeg(open[i], open[s], open[e]);
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > tol && imax > 0) {
      keep[imax] = 1;
      stack.push([s, imax], [imax, e]);
    }
  }
  const kept = open.filter((_, i) => keep[i] === 1).map((p) => [...p] as [number, number]);
  // remove colineares em passadas ciclicas (a colinearidade do fecho so aparece no ciclo)
  let pts = kept;
  for (let sweep = 0; sweep < 5 && pts.length > 4; sweep++) {
    const next: Array<[number, number]> = [];
    let changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (Math.abs(cross) < 1e-9 && dot > 0) changed = true;
      else next.push(b);
    }
    pts = next;
    if (!changed) break;
  }
  pts.push([...pts[0]]);
  return pts;
}

/**
 * Traçado de contorno exato por cantos (wall follower, interior à direita).
 * Retorna cantos de pixel [x,y] fechados (primeiro == ultimo).
 * Area pelo shoelace == nº de pixels (sem inset). Sem furos (documentado).
 */
const DIRS4: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // E,S,W,N

export function traceContour(
  mask: Uint8Array, W: number, H: number,
  c0: number, r0: number, c1: number, r1: number,
): Array<[number, number]> {
  // pixel inicial: mais acima e à esquerda da componente (oeste garantido fundo)
  let sc = -1, sr = -1;
  outer: for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (mask[r * W + c]) { sc = c; sr = r; break outer; }
    }
  }
  if (sc < 0) throw new Error('componente vazia');
  const fg = (c: number, r: number): boolean =>
    c >= 0 && r >= 0 && c < W && r < H && mask[r * W + c] === 1;
  const scan = (c: number, r: number, back: number): number => {
    for (let k = 0; k < 4; k++) {
      const d = (back + 2 + k) % 4;
      const [dx, dy] = DIRS4[d];
      if (fg(c + dx, r + dy)) return d;
    }
    return -1;
  };
  const corners: Array<[number, number]> = [[sc, sr]];
  // Seguidor de parede (mão direita): tenta virar à direita, reto, esquerda.
  // Aresta válida = interior (fg) à direita E exterior (bg) à esquerda.
  let x = sc, y = sr, d = 0; // de frente para o leste
  const cap = 8 * W * H + 32;
  for (let step = 0; step < cap; step++) {
    let nd = -1;
    for (const f of [(d + 1) % 4, d, (d + 3) % 4]) {
      const s = sideCells(x, y, f);
      if (fg(s.right[0], s.right[1]) && !fg(s.left[0], s.left[1])) { nd = f; break; }
    }
    if (nd < 0) {
      if (corners.length === 1) return [[sc, sr], [sc + 1, sr], [sc + 1, sr + 1], [sc, sr + 1], [sc, sr]];
      throw new Error('contorno degenerado');
    }
    d = nd;
    const [dx, dy] = DIRS4[d];
    x += dx; y += dy;
    corners.push([x, y]);
    if (x === sc && y === sr) return corners; // anel simples: fecha uma vez só
  }
  throw new Error('contorno nao fechou (limite)');
}

function sideCells(x: number, y: number, d: number): { right: [number, number]; left: [number, number] } {
  if (d === 0) return { right: [x, y], left: [x, y - 1] }; // E
  if (d === 1) return { right: [x - 1, y], left: [x, y] }; // S
  if (d === 2) return { right: [x - 1, y - 1], left: [x - 1, y] }; // W
  return { right: [x, y - 1], left: [x - 1, y - 1] }; // N
}
