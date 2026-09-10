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
): number[][] {
  const x0 = originX + c0 * res, x1 = originX + (c1 + 1) * res;
  const y1 = originY - r0 * res, y0 = originY - (r1 + 1) * res;
  const inv = (x: number, y: number) => proj4(utmDef, 'EPSG:4326', [x, y]) as [number, number];
  const ring = [inv(x0, y0), inv(x1, y0), inv(x1, y1), inv(x0, y1)].map(([lon, lat]) => [
    Math.min(180, Math.max(-180, lon)), Math.min(90, Math.max(-90, lat)),
  ]);
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
  for (const k of comps) {
    try {
      const corners = traceContour(mask, W, H, k.c0, k.r0, k.c1, k.r1);
      polys.push([corners.map(([x, y]) => toLonLat(x, y))]);
    } catch {
      polys.push([pixelBboxToRing(k.c0, k.r0, k.c1, k.r1, originX, originY, res, utmDef)]);
    }
  }
  return { type: 'MultiPolygon', coordinates: polys };
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
