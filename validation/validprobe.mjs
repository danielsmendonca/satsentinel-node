/**
 * Sonda valid_frac (ceu limpo) de uma task DUAL sem votar: baixa so a SCL de t0.
 * Uso: node ./validation/validprobe.mjs ./validation/probe_TASK.json
 * (probe file: {h3_index, mgrs_tile, event_class, cog_urls})
 */
import { readFileSync } from 'node:fs';
import { validFrac } from '../dist/src/pipeline/scl.js';
import { readBandWindow, resampleNearest } from '../dist/src/fetcher/windows.js';
import { parseMgrsTile, utmFromMgrs } from '../dist/src/fetcher/mgrs.js';
import { cellToBoundary } from 'h3-js';

const p = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const mgrs = p.mgrs_tile && p.mgrs_tile !== 'UNKNOWN' ? p.mgrs_tile : parseMgrsTile(p.observation_id, {});
const { def: utmDef } = utmFromMgrs(mgrs);
const ring = cellToBoundary(p.h3_index);
let w = 180, s = 90, e = -180, n = -90;
for (const [la, lo] of ring) {
  if (lo < w) w = lo; if (lo > e) e = lo;
  if (la < s) s = la; if (la > n) n = la;
}
const ref = await readBandWindow(p.cog_urls.B08, [w, s, e, n], utmDef, 1280);
const sclRaw = await readBandWindow(p.cog_urls.SCL, [w, s, e, n], utmDef, 1280);
const scl = resampleNearest({ data: sclRaw.data, width: sclRaw.width, height: sclRaw.height, res: sclRaw.res, originX: sclRaw.originX, originY: sclRaw.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res);
console.log(JSON.stringify({ h3: p.h3_index, scene: p.observation_id, valid_frac: +validFrac(scl, p.event_class ?? 'DEFORESTATION').toFixed(3) }));
