/**
 * Fetcher COG com cache LRU + coalescing (GDD Sec 2/15).
 * Node busca RASTER direto do S3; server nunca proxya.
 */
export interface RangeGet { (url: string, start: number, end: number): Promise<Uint8Array>; }

const defaultRangeGet: RangeGet = async (url, start, end) => {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (r.status !== 206 && r.status !== 200) throw new Error(`range ${r.status} em ${url}`);
  return new Uint8Array(await r.arrayBuffer());
};

export class ChunkCache {
  private map = new Map<string, { data: Uint8Array; at: number }>();
  constructor(private maxEntries = 128) {}
  get(k: string): Uint8Array | undefined {
    const e = this.map.get(k);
    if (e) { e.at = Date.now(); return e.data; }
    return undefined;
  }
  set(k: string, data: Uint8Array): void {
    if (this.map.size >= this.maxEntries) {
      let oldest = ''; let t = Infinity;
      for (const [k2, v] of this.map) if (v.at < t) { t = v.at; oldest = k2; }
      this.map.delete(oldest);
    }
    this.map.set(k, { data, at: Date.now() });
  }
}

/** Le N ranges coalescendo vizinhos com gap < 256KB em 1 request. */
export async function coalescedGet(
  url: string, ranges: Array<[number, number]>, get: RangeGet = defaultRangeGet, cache = new ChunkCache(),
): Promise<Uint8Array[]> {
  const GAP = 256 * 1024;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const groups: Array<[number, number, number[]]> = []; // [start,end,idxs]
  for (let i = 0; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = groups[groups.length - 1];
    if (last && s - last[1] <= GAP) last[1] = Math.max(last[1], e);
    else groups.push([s, e, []]);
  }
  const out: Uint8Array[] = new Array(ranges.length);
  const indexOf = new Map(ranges.map((r, i) => [`${r[0]}-${r[1]}`, i]));
  // fast-path: tudo em cache por range individual
  let allHit = true;
  for (const [s, e] of ranges) {
    const hit = cache.get(`${url}|${s}-${e}`);
    if (hit) out[indexOf.get(`${s}-${e}`)!] = hit;
    else allHit = false;
  }
  if (allHit) return out;
  for (const [gs, ge] of groups) {
    const key = `${url}|${gs}-${ge}`;
    let blob = cache.get(key);
    if (!blob) {
      let attempt = 0;
      for (;;) {
        try { blob = await get(url, gs, ge); break; }
        catch (err) {
          if (++attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      cache.set(key, blob);
    }
    for (const [s, e] of sorted) {
      if (s >= gs && e <= ge) {
        const slice = blob.slice(s - gs, e - gs + 1);
        out[indexOf.get(`${s}-${e}`)!] = slice;
        cache.set(`${url}|${s}-${e}`, slice); // cache por range pedido (hit futuro)
      }
    }
  }
  return out;
}
