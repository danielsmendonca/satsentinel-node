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

/** Bbox de pixels -> anel lon/lat fechado. */
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
  return {
    type: 'MultiPolygon',
    coordinates: comps.map((k) => [pixelBboxToRing(k.c0, k.r0, k.c1, k.r1, originX, originY, res, utmDef)]),
  };
}
