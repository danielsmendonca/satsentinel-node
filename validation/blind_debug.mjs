/**
 * Debug dos 2 blinds Fase 0 (count=0 em ceu limpo): ha queda de NDVI no
 * footprint do alerta? O gate a mata? As baselines ja estao desmatadas?
 * Uso: node ./validation/blind_debug.mjs <alert.json> <scene_id> [FOREST_GATE=1]
 * alert.json = feature GeoJSON do DETER (properties.view_date).
 */
import { readFileSync } from 'node:fs';
import { ndvi, detectWindow, median3 } from '../dist/src/pipeline/ndvi.js';
import { forestMask, isValidScl } from '../dist/src/pipeline/scl.js';
import { readBandWindow, resampleNearest } from '../dist/src/fetcher/windows.js';
import { parseMgrsTile, utmFromMgrs } from '../dist/src/fetcher/mgrs.js';
import { latLngToCell, cellToBoundary } from 'h3-js';
import proj4 from 'proj4';

const alertPath = process.argv[2];
const sceneId = process.argv[3];
const GATE = process.env.FOREST_GATE !== '0';
const alert = JSON.parse(readFileSync(alertPath, 'utf8').replace(/^\uFEFF/, ''));
const ring = alert.geometry.coordinates[0][0];
let lon = 0, lat = 0;
for (const p of ring) { lon += p[0]; lat += p[1]; }
lon /= ring.length; lat /= ring.length;
let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
for (const p of ring) {
  if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
  if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
}
console.log(`alerta ${alert.properties.gid} ${alert.properties.classname} ${alert.properties.view_date} area=${alert.properties.areamunkm}km2 centro=${lat.toFixed(4)},${lon.toFixed(4)} bbox=${x0.toFixed(4)},${y0.toFixed(4)},${x1.toFixed(4)},${y1.toFixed(4)}`);

const stacSearch = async (body) => {
  const r = await fetch('https://earth-search.aws.element84.com/v1/search',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`STAC ${r.status}`);
  return (await r.json()).features ?? [];
};
const pick = (assets, ...keys) => {
  for (const k of keys) if (assets[k]?.href) return assets[k].href;
  return undefined;
};
// t0 = cena exata do benchmark (via ids), baselines = mesma logica do deter_smoke
const t0f = await stacSearch({ collections: ['sentinel-2-l2a'], ids: [sceneId], limit: 1 });
if (!t0f.length) throw new Error('cena t0 nao encontrada no STAC');
const t0 = t0f[0];
const t0dt = t0.properties.datetime;
console.log(`t0: ${t0.id} ${t0dt.slice(0, 10)} cloud=${t0.properties['eo:cloud_cover']}`);
const since = new Date(new Date(t0dt).getTime() - 60 * 864e5).toISOString();
const prev = await stacSearch({
  collections: ['sentinel-2-l2a'],
  intersects: { type: 'Point', coordinates: [lon, lat] },
  datetime: `${since}/${t0dt}`,
  query: { 'eo:cloud_cover': { lt: 30 } },
  sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  limit: 6,
});
const bases = prev.filter((p) => p.id !== t0.id)
  .filter((p) => process.env.SAME_TILE !== '1' || (p.id.match(/_(\d{2}[A-Z]{3})_/)?.[1] ?? '') === (t0.id.match(/_(\d{2}[A-Z]{3})_/)?.[1] ?? ''))
  .slice(0, 3);
console.log('bases:', bases.map((b) => `${b.id.slice(0, 24)} ${b.properties.datetime.slice(0, 10)}`).join(' | '));

const mgrs = parseMgrsTile(t0.id, {});
const { def: utmDef } = utmFromMgrs(mgrs);
const h3 = latLngToCell(lat, lon, 6);
const bnd = cellToBoundary(h3);
let w = 180, s = 90, e = -180, n = -90;
for (const [la, lo] of bnd) {
  if (lo < w) w = lo; if (lo > e) e = lo;
  if (la < s) s = la; if (la > n) n = la;
}
const extent = [w, s, e, n];
const haloM = 1280;
const ref = await readBandWindow(pick(t0.assets, 'nir', 'nir08', 'B08', 'b08'), extent, utmDef, haloM);
const onGrid = async (url) => {
  const g = await readBandWindow(url, extent, utmDef, haloM);
  if (g.width === ref.width && g.height === ref.height) return new Float32Array(g.data);
  return Float32Array.from(resampleNearest({ data: g.data, width: g.width, height: g.height, res: g.res, originX: g.originX, originY: g.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res));
};
const red = await onGrid(pick(t0.assets, 'red', 'B04', 'b04'));
const nir = ref.data;
const sclRaw = await readBandWindow(pick(t0.assets, 'scl', 'SCL', 'scl'), extent, utmDef, haloM);
const scl = resampleNearest({ data: sclRaw.data, width: sclRaw.width, height: sclRaw.height, res: sclRaw.res, originX: sclRaw.originX, originY: sclRaw.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res);
const baseNdvis = [];
const baseScls = [];
for (const b of bases) {
  baseNdvis.push(ndvi(await onGrid(pick(b.assets, 'red', 'B04', 'b04')), await onGrid(pick(b.assets, 'nir', 'nir08', 'B08', 'b08'))));
  const bs = await readBandWindow(pick(b.assets, 'scl', 'SCL', 'scl'), extent, utmDef, haloM);
  baseScls.push(resampleNearest({ data: bs.data, width: bs.width, height: bs.height, res: bs.res, originX: bs.originX, originY: bs.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res));
}
const cur = ndvi(red, nir);
const med = baseNdvis.length >= 3 ? median3(baseNdvis[0], baseNdvis[1], baseNdvis[2]) : median3(baseNdvis[0], baseNdvis[1], baseNdvis[1]);
const fmask = forestMask(baseScls);

// footprint: bbox do alerta -> indices da grade (via proj4 p/ UTM)
const fwd = ([lo, la]) => proj4('EPSG:4326', utmDef, [lo, la]);
const [ax0] = [fwd([x0, y0])[0]], [ax1] = [fwd([x1, y1])[0]];
const ayTop = fwd([x0, y1])[1], ayBot = fwd([x0, y0])[1];
const c0 = Math.max(0, Math.floor((Math.min(ax0, ax1) - ref.originX) / ref.res));
const c1 = Math.min(ref.width - 1, Math.ceil((Math.max(ax0, ax1) - ref.originX) / ref.res));
const r0 = Math.max(0, Math.floor((ref.originY - Math.max(ayTop, ayBot)) / ref.res));
const r1 = Math.min(ref.height - 1, Math.ceil((ref.originY - Math.min(ayTop, ayBot)) / ref.res));
console.log(`janela ${ref.width}x${ref.height} @${ref.res}m; footprint na grade: c[${c0},${c1}] r[${r0},${r1}]`);
// point-in-ring (anel externo) p/ recorte exato
const inRing = (lo, la) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inv = (c, r) => proj4(utmDef, 'EPSG:4326', [ref.originX + (c + 0.5) * ref.res, ref.originY - (r + 0.5) * ref.res]);
let st = { n: 0, ndviT0: 0, ndviBase: 0, dndvi: 0, drop: 0, valid: 0, forest: 0, anom: 0 };
for (let r = r0; r <= r1; r++) {
  for (let c = c0; c <= c1; c++) {
    const [lo, la] = inv(c, r);
    if (!inRing(lo, la)) continue;
    const i = r * ref.width + c;
    st.n++;
    st.ndviT0 += cur[i]; st.ndviBase += med[i];
    const d = cur[i] - med[i];
    st.dndvi += d;
    if (d < -0.15) st.drop++;
    if (isValidScl(scl[i], 'DEFORESTATION')) st.valid++;
    if (fmask[i]) st.forest++;
    if (d < -0.15) st.anom++;
  }
}
const f = (v) => (v / Math.max(1, st.n));
console.log(`footprint: ${st.n}px (${(st.n * 100 / 1e6).toFixed(3)}km2 @10m)`);
console.log(`  NDVI t0 medio=${(st.ndviT0 / Math.max(1, st.n)).toFixed(3)} | baseline mediana=${(st.ndviBase / Math.max(1, st.n)).toFixed(3)} | dNDVI medio=${(st.dndvi / Math.max(1, st.n)).toFixed(3)}`);
console.log(`  fracao com queda<-0.15: ${(f(st.drop) * 100).toFixed(1)}% | validos: ${(f(st.valid) * 100).toFixed(1)}% | gate-floresta: ${(f(st.forest) * 100).toFixed(1)}%`);
// deteccao global com/sem gate (replica R5b: TH=-0.15 MINPX=50)
for (const g of [true, false]) {
  const det = detectWindow(red, nir, scl, baseNdvis, 'DEFORESTATION',
    { dndviThreshold: -0.15, minPx: 50, ...(g ? { requireForest: true, forest: fmask } : {}) });
  console.log(`  global gate=${g ? 'ON ' : 'OFF'}: valid=${(det.validFracT0 * 100).toFixed(1)}% count=${det.count} score=${det.uncalibrated.toFixed(2)}`);
}
