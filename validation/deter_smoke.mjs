/**
 * Smoke de validacao Fase 0 (NÃO é validação: n=3, IoU em bbox).
 * Cruza alertas DETER reais (INPE/TerraBrasilis) com o pipeline real do no:
 * para cada alerta, busca cena Sentinel-2 posterior + 2 baselines (Element84),
 * roda NDVI/dNDVI/vetorizacao e compara IoU>=0.5 (TP) contra o poligono DETER.
 * Uso: node ./validation/deter_smoke.mjs
 */
import { ndvi, detectWindow } from '../dist/src/pipeline/ndvi.js';
import { maskToMultiPolygon } from '../dist/src/pipeline/vectorize.js';
import { readBandWindow, resampleNearest } from '../dist/src/fetcher/windows.js';
import { parseMgrsTile, utmFromMgrs } from '../dist/src/fetcher/mgrs.js';
import { latLngToCell, cellToBoundary } from 'h3-js';

const pick = (assets, ...keys) => {
  for (const k of keys) if (assets[k]?.href) return assets[k].href;
  return undefined;
};
const bboxOf = (coords) => {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
      return;
    }
    c.forEach(walk);
  };
  walk(coords);
  return [x0, y0, x1, y1];
};
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u <= 0 ? 0 : inter / u;
};
const centroid = (ring) => {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
};

async function stacSearch(body) {
  const r = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`STAC ${r.status}`);
  return (await r.json()).features ?? [];
}

async function runSample(alert, idx) {
  const ring = alert.geometry.coordinates[0][0];
  const [lon, lat] = centroid(ring);
  const refBox = bboxOf(alert.geometry.coordinates);
  console.log(`\n[${idx}] DETER ${alert.properties.classname} ${alert.properties.view_date} ${alert.properties.areamunkm?.toFixed?.(3)}km2 @ ${lat.toFixed(3)},${lon.toFixed(3)}`);
  // cena posterior mais próxima com pouco cloud
  const after = await stacSearch({
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    datetime: `${alert.properties.view_date}T00:00:00Z/2026-09-09T00:00:00Z`,
    query: { 'eo:cloud_cover': { lt: 30 } },
    sortby: [{ field: 'properties.datetime', direction: 'asc' }],
    limit: 5,
  });
  if (!after.length) { console.log('  SKIP: sem cena posterior limpa'); return 'skip'; }
  const t0 = after[0];
  const t0dt = t0.properties.datetime;
  console.log(`  t0: ${t0.id} ${t0dt.slice(0, 10)}`);
  const since = new Date(new Date(t0dt).getTime() - 60 * 864e5).toISOString();
  const prev = await stacSearch({
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    datetime: `${since}/${t0dt}`,
    query: { 'eo:cloud_cover': { lt: 30 } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 6,
  });
  const bases = prev.filter((p) => p.id !== t0.id).slice(0, 3);
  if (bases.length < 2) { console.log('  SKIP: sem 2 baselines'); return 'skip'; }
  console.log(`  bases: ${bases.map((b) => b.id.slice(0, 21)).join(', ')}`);
  const urls = (f) => ({ B04: pick(f.assets, 'red', 'B04', 'b04'), B08: pick(f.assets, 'nir', 'nir08', 'B08', 'b08'), SCL: pick(f.assets, 'scl', 'SCL', 'scl') });
  const t0u = urls(t0);
  const bu = bases.map(urls);
  if (!t0u.B04 || !t0u.B08 || !t0u.SCL || bu.some((b) => !b.B04 || !b.B08 || !b.SCL)) {
    console.log('  SKIP: assets incompletos');
    return 'skip';
  }
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
  const ref = await readBandWindow(t0u.B08, extent, utmDef, haloM);
  const onGrid = async (url) => {
    const g = await readBandWindow(url, extent, utmDef, haloM);
    if (g.width === ref.width && g.height === ref.height) return new Float32Array(g.data);
    const up = resampleNearest({ data: g.data, width: g.width, height: g.height, res: g.res, originX: g.originX, originY: g.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res);
    return Float32Array.from(up);
  };
  const red = await onGrid(t0u.B04);
  const nir = ref.data;
  const sclRaw = await readBandWindow(t0u.SCL, extent, utmDef, haloM);
  const scl = resampleNearest({ data: sclRaw.data, width: sclRaw.width, height: sclRaw.height, res: sclRaw.res, originX: sclRaw.originX, originY: sclRaw.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res);
  const baseNdvis = [];
  for (const b of bu) baseNdvis.push(ndvi(await onGrid(b.B04), await onGrid(b.B08)));
  const det = detectWindow(red, nir, scl, baseNdvis, 'DEFORESTATION',
    { dndviThreshold: Number(process.env.TH ?? -0.15) });
  console.log(`  valid=${(det.validFracT0 * 100).toFixed(0)}% px_anomalos=${det.count} score=${det.uncalibrated.toFixed(2)}`);
  if (det.count === 0) { console.log('  -> FN (nada detectado)'); return 'fn'; }
  const mp = maskToMultiPolygon(det.mask, ref.width, ref.height, ref.originX, ref.originY, ref.res, utmDef);
  let best = 0;
  const boxes = [];
  for (const poly of mp?.coordinates ?? []) {
    const bb = bboxOf(poly);
    boxes.push(bb);
    best = Math.max(best, iou(bb, refBox));
  }
  if (process.env.DEBUG_BOX) {
    console.log(`  alertBox=${refBox.map((v) => v.toFixed(4)).join(',')}`);
    boxes.slice(0, 5).forEach((b, i) => console.log(`  det${i}=${b.map((v) => v.toFixed(4)).join(',')}`));
  }
  console.log(`  -> IoU=${best.toFixed(2)} ${best >= 0.5 ? 'TP' : 'FN'}`);
  return best >= 0.5 ? 'tp' : 'fn';
}

const WFS = 'https://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=deter-amz:deter_amz&outputFormat=application%2Fjson&maxFeatures=200&bbox=-52.5,-7.5,-51,-6';
const feats = (await (await fetch(WFS)).json()).features ?? [];
const cands = feats
  .filter((f) => f.properties.classname === 'DESMATAMENTO_CR' && f.properties.view_date >= '2026-05-01' && (f.properties.areamunkm ?? 0) >= 0.08)
  .sort((a, b) => (b.properties.areamunkm ?? 0) - (a.properties.areamunkm ?? 0))
  .slice(0, 5);
console.log(`candidatos DETER desmate 2026: ${cands.length}`);
const res = { tp: 0, fn: 0, skip: 0 };
let i = 0;
for (const c of cands) {
  if (res.tp + res.fn >= 3) break;
  if (process.env.ONLY_FIRST && (res.tp + res.fn) >= 1) break;
  i++;
  try {
    res[await runSample(c, i)]++;
  } catch (e) {
    console.log(`  ERRO: ${e.message}`);
    res.skip++;
  }
}
const { tp, fn } = res;
const r = tp + fn === 0 ? 0 : tp / (tp + fn);
console.log(`\nSMOKE n=${tp + fn} (skips=${res.skip}): TP=${tp} FN=${fn} recall=${r.toFixed(2)} (precision N/A: amostra só tem positivos)`);
console.log('NOTA: smoke ilustrativo, NAO validacao (Fase 0 exige n>=30, 2 biomas, 2 estacoes).');
