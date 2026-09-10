// Amostra termica de UMA celula: Landsat L2ST -> mediana -> POST /v1/cells/:h3/value.
// Uso: node ./scripts/thermal.mjs <lat> <lon>   (usa config/ p/ auth + server)
import { latLngToCell, cellToBoundary } from 'h3-js';
import { readBandWindow } from '../dist/src/fetcher/windows.js';
import { landsatUtmDef, cellTemperature } from '../dist/src/thermal/landsat.js';
import { getSession } from '../dist/src/runner.js';

const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error('uso: node ./scripts/thermal.mjs <lat> <lon>');
  process.exit(1);
}
const items = await (await fetch('https://earth-search.aws.element84.com/v1/search', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    collections: ['landsat-c2-l2'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    datetime: `${new Date(Date.now() - 90 * 864e5).toISOString()}/${new Date().toISOString()}`,
    query: { 'eo:cloud_cover': { lt: 30 } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 3,
  }),
})).json().then((j) => j.features ?? []);
if (!items.length) throw new Error('sem cena Landsat limpa (90d)');
const scene = items[0];
console.log('cena:', scene.id, scene.properties.datetime);
const stUrl = scene.assets?.lwir11?.href;
const qaUrl = scene.assets?.qa_pixel?.href;
if (!stUrl || !qaUrl) throw new Error('assets lwir11/qa_pixel ausentes');
const h3 = latLngToCell(lat, lon, 6);
const bnd = cellToBoundary(h3);
let w = 180, s = 90, e = -180, n = -90;
for (const [la, lo] of bnd) {
  if (lo < w) w = lo; if (lo > e) e = lo;
  if (la < s) s = la; if (la > n) n = la;
}
const utmDef = landsatUtmDef(lon, lat);
const st = await readBandWindow(stUrl, [w, s, e, n], utmDef, 0);
const qa = await readBandWindow(qaUrl, [w, s, e, n], utmDef, 0);
const t = cellTemperature(st.data, qa.data);
console.log(`h3=${h3} mediana=${t.medianC?.toFixed(1) ?? 'n/a'}°C limpo=${(t.clearFrac * 100).toFixed(0)}% (n=${t.n})`);
if (t.medianC === null) throw new Error('sem pixel limpo na celula');
const { base, auth } = await getSession('config');
const r = await fetch(`${base}/v1/cells/${h3}/value`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ layer: 'LST_C', value_c: +t.medianC.toFixed(2), observed_at: scene.properties.datetime }),
});
console.log('server:', r.status, (await r.text()).slice(0, 200));
