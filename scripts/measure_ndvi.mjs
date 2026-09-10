// Vigor mediano (NDVI) de UMA celula H3 via Sentinel-2 (100% gratuito) -> POST camada NDVI.
// Uso: node ./scripts/measure_ndvi.mjs <lat> <lon>
import { latLngToCell, cellToBoundary } from 'h3-js';
import { readBandWindow } from '../dist/src/fetcher/windows.js';
import { ndvi } from '../dist/src/pipeline/ndvi.js';
import { parseMgrsTile, utmFromMgrs } from '../dist/src/fetcher/mgrs.js';
import { medianOf } from '../dist/src/thermal/landsat.js';
import { getSession } from '../dist/src/runner.js';

const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error('uso: node ./scripts/measure_ndvi.mjs <lat> <lon>');
  process.exit(1);
}
const pick = (assets, ...keys) => {
  for (const k of keys) if (assets[k]?.href) return assets[k].href;
  return undefined;
};
const items = await (await fetch('https://earth-search.aws.element84.com/v1/search', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    datetime: `${new Date(Date.now() - 60 * 864e5).toISOString()}/${new Date().toISOString()}`,
    query: { 'eo:cloud_cover': { lt: 30 } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 3,
  }),
})).json().then((j) => j.features ?? []);
if (!items.length) throw new Error('sem cena Sentinel-2 limpa (60d)');
const scene = items[0];
console.log('cena:', scene.id);
const B04 = pick(scene.assets, 'red', 'B04', 'b04');
const B08 = pick(scene.assets, 'nir', 'nir08', 'B08', 'b08');
const SCL = pick(scene.assets, 'scl', 'SCL', 'scl');
if (!B04 || !B08 || !SCL) throw new Error('assets incompletos');
const h3 = latLngToCell(lat, lon, 6);
const bnd = cellToBoundary(h3);
let w = 180, s = 90, e = -180, n = -90;
for (const [la, lo] of bnd) {
  if (lo < w) w = lo; if (lo > e) e = lo;
  if (la < s) s = la; if (la > n) n = la;
}
const { def: utmDef } = utmFromMgrs(parseMgrsTile(scene.id, scene.properties ?? {}));
const ref = await readBandWindow(B08, [w, s, e, n], utmDef, 0);
const g4 = await readBandWindow(B04, [w, s, e, n], utmDef, 0);
const gs = await readBandWindow(SCL, [w, s, e, n], utmDef, 0);
const nv = ndvi(new Float32Array(g4.data), new Float32Array(ref.data));
// mediana só em pixel vegetado (SCL==4 reamostrado nearest)
const veg = [];
for (let r = 0; r < ref.height; r += 2) {
  for (let c = 0; c < ref.width; c += 2) {
    const sr = Math.min(gs.height - 1, Math.floor(r * (gs.height / ref.height)));
    const sc = Math.min(gs.width - 1, Math.floor(c * (gs.width / ref.width)));
    if (gs.data[sr * gs.width + sc] !== 4) continue;
    const v = nv[r * ref.width + c];
    if (v > -1 && v <= 1) veg.push(v);
  }
}
const med = medianOf(veg);
console.log(`h3=${h3} NDVI_med=${med?.toFixed(3) ?? 'n/a'} (n=${veg.length})`);
if (med === null) throw new Error('sem pixel vegetado na celula');
const { base, auth } = await getSession('config');
const r = await fetch(`${base}/v1/cells/${h3}/value`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ layer: 'NDVI', value_c: +med.toFixed(3), observed_at: scene.properties.datetime }),
});
console.log('server:', r.status, (await r.text()).slice(0, 200));
