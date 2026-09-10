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
import { forestMask } from '../dist/src/pipeline/scl.js';
import { latLngToCell, cellToBoundary } from 'h3-js';
import { appendFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';

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

async function runSample(alert, idx, biome, row, expectZero = false) {
  const ring = alert.geometry.coordinates[0][0];
  const [lon, lat] = centroid(ring);
  const refBox = bboxOf(alert.geometry.coordinates);
  console.log(`\n[${idx}] ${biome} DETER ${alert.properties.classname} ${alert.properties.view_date} ${alert.properties.areamunkm?.toFixed?.(3)}km2 @ ${lat.toFixed(3)},${lon.toFixed(3)}`);
  // cena posterior mais próxima com pouco cloud (STRICT_DAYS: só até N dias após o alerta)
  const strictDays = Number(process.env.STRICT_DAYS ?? 0);
  const endDt = strictDays > 0
    ? new Date(new Date(alert.properties.view_date + 'T00:00:00Z').getTime() + strictDays * 864e5).toISOString()
    : (process.env.SCENE_BEFORE ?? '2026-09-09T00:00:00Z');
  const after = await stacSearch({
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    datetime: `${alert.properties.view_date}T00:00:00Z/${endDt}`,
    query: { 'eo:cloud_cover': { lt: 30 } },
    sortby: [{ field: 'properties.datetime', direction: 'asc' }],
    limit: 5,
  });
  if (!after.length) { console.log(`  SKIP: sem cena limpa em +${strictDays || '∞'}d`); return 'skip'; }
  const t0 = after[0];
  const t0dt = t0.properties.datetime;
  console.log(`  t0: ${t0.id} ${t0dt.slice(0, 10)}`);
  row.scene = t0.id;
  // R7 (OLD_REF=1): referencia PRE-disturbio — 3 baselines MAIS ANTIGAS do
  // mesmo tile em ate 180d (combate o lag do DETER: mediana recente ja mostra
  // a area derrubada e o dNDVI zera). Default = mediana recente (producao atual).
  const OLD_REF = process.env.OLD_REF === '1';
  const winDays = OLD_REF ? 180 : 60;
  if (OLD_REF) row.oldref = 1;
  const since = new Date(new Date(t0dt).getTime() - winDays * 864e5).toISOString();
  const prev = await stacSearch({
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    datetime: `${since}/${t0dt}`,
    query: { 'eo:cloud_cover': { lt: 30 } },
    sortby: [{ field: 'properties.datetime', direction: OLD_REF ? 'asc' : 'desc' }],
    limit: OLD_REF ? 30 : 6,
  });
  const picked = prev
    .filter((p) => p.id !== t0.id)
    // Producao exige MESMO tile (GDD Sec 7); cross-tile contamina a mediana com
    // nodata (debug blinds: mediana 0.0 -> dNDVI +0.5 ficticio). Opt-out: SAME_TILE=0.
    .filter((p) => process.env.SAME_TILE === '0' || (p.id.match(/_(\d{2}[A-Z]{3})_/)?.[1] ?? '') === (t0.id.match(/_(\d{2}[A-Z]{3})_/)?.[1] ?? ''));
  // asc do STAC nem sempre volta ordenado apos filtros: garante a ponta certa.
  picked.sort((a, b) => OLD_REF
    ? (a.properties.datetime < b.properties.datetime ? -1 : 1)
    : (a.properties.datetime < b.properties.datetime ? 1 : -1));
  const bases = picked.slice(0, 3);
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
  const baseScls = [];
  for (const b of bu) {
    baseNdvis.push(ndvi(await onGrid(b.B04), await onGrid(b.B08)));
    if (process.env.FOREST_GATE) {
      const bs = await readBandWindow(b.SCL, extent, utmDef, haloM);
      baseScls.push(resampleNearest({ data: bs.data, width: bs.width, height: bs.height, res: bs.res, originX: bs.originX, originY: bs.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res));
    }
  }
  const TH = Number(process.env.TH ?? -0.15);
  const MINPX = Number(process.env.MINPX ?? 50);
  const LOW_VALID = Number(process.env.LOW_VALID ?? 0.6);
  const det = detectWindow(red, nir, scl, baseNdvis, 'DEFORESTATION',
    { dndviThreshold: TH, minPx: MINPX, ...(process.env.FOREST_GATE ? { requireForest: true, forest: forestMask(baseScls) } : {}), width: ref.width, erodeValid: process.env.ERODE === '1' });
  if (process.env.ERODE === '1') row.erode = 1;
  console.log(`  valid=${(det.validFracT0 * 100).toFixed(0)}% px_anomalos=${det.count} score=${det.uncalibrated.toFixed(2)}`);
  row.valid = +det.validFracT0.toFixed(3); row.count = det.count; row.score = +det.uncalibrated.toFixed(3);
  if (det.validFracT0 < LOW_VALID) {
    console.log(`  SKIP: valid ${(det.validFracT0 * 100).toFixed(0)}% < piso ${LOW_VALID} (producao: SKIPPED)`);
    row.outcome = 'skip-lowvalid';
    return 'skip';
  }
  // Persistencia multi-temporal (R5, opt-in PERSIST=1): anomalia real (corte)
  // persiste entre cenas; haze/borda de nuvem e transiente. Roda a mesma
  // deteccao numa 2a cena limpa apos t0; row.persisted=true/false/'unknown'
  // (sem 2a cena disponivel). Outcomes nao mudam; agregacao compara com/sem filtro.
  if (process.env.PERSIST === '1' && det.count > 0) {
    try {
      const t1end = new Date(new Date(t0dt).getTime() + 60 * 864e5).toISOString();
      const next = await stacSearch({
        collections: ['sentinel-2-l2a'],
        intersects: { type: 'Point', coordinates: [lon, lat] },
        datetime: `${t0dt}/${t1end}`,
        query: { 'eo:cloud_cover': { lt: 30 } },
        sortby: [{ field: 'properties.datetime', direction: 'asc' }],
        limit: 4,
      });
      const t1 = next.find((f) => f.id !== t0.id);
      if (!t1) {
        row.persisted = 'unknown';
        console.log('  persist: sem 2a cena (unknown)');
      } else {
        const t1u = urls(t1);
        if (!t1u.B04 || !t1u.B08 || !t1u.SCL) {
          row.persisted = 'unknown';
          console.log('  persist: assets incompletos (unknown)');
        } else {
          const red1 = await onGrid(t1u.B04);
          const nir1 = await onGrid(t1u.B08);
          const sclRaw1 = await readBandWindow(t1u.SCL, extent, utmDef, haloM);
          const scl1 = resampleNearest({ data: sclRaw1.data, width: sclRaw1.width, height: sclRaw1.height, res: sclRaw1.res, originX: sclRaw1.originX, originY: sclRaw1.originY }, ref.width, ref.height, ref.originX, ref.originY, ref.res);
          const det2 = detectWindow(red1, nir1, scl1, baseNdvis, 'DEFORESTATION',
            { dndviThreshold: TH, minPx: MINPX, ...(process.env.FOREST_GATE ? { requireForest: true, forest: forestMask(baseScls) } : {}), width: ref.width, erodeValid: process.env.ERODE === '1' });
          row.persisted = det2.count > 0;
          row.persist_scene = t1.id;
          row.persist_count = det2.count;
          // Overlap espacial das máscaras: corte real persiste NO MESMO LUGAR;
          // haze muda de lugar (ex: R5 FP 133px -> 526k px na 2a cena).
          let inter = 0, union = 0;
          for (let i = 0; i < det.mask.length; i++) {
            const a = det.mask[i] === 1, b = det2.mask[i] === 1;
            if (a && b) inter++;
            if (a || b) union++;
          }
          row.persist_iou = union ? +(inter / union).toFixed(3) : 0;
          console.log(`  persist: ${t1.id.slice(0, 21)} count=${det2.count} iou=${row.persist_iou} -> ${row.persisted ? 'PERSISTIU' : 'transiente'}`);
        }
      }
    } catch (e) {
      row.persisted = 'unknown';
      console.log(`  persist: erro (${String(e.message).slice(0, 60)})`);
    }
  }
  if (expectZero) {
    // controle negativo (mata estavel): qualquer deteccao = falso-positivo
    const o = det.count === 0 ? 'tn' : 'fp';
    console.log(`  -> ${o.toUpperCase()} (controle)`);
    return o;
  }
  if (det.count === 0) { console.log('  -> FN (nada detectado)'); row.iou = 0; return 'fn'; }
  const mp = maskToMultiPolygon(det.mask, ref.width, ref.height, ref.originX, ref.originY, ref.res, utmDef,
    Number(process.env.MINPX ?? 50), Number(process.env.MINFILL ?? 0.25));
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
  row.iou = +best.toFixed(3);
  return best >= 0.5 ? 'tp' : 'fn';
}

const TH = Number(process.env.TH ?? -0.15);
const MINPX = Number(process.env.MINPX ?? 50);
const MAXN = Number(process.env.MAXN ?? 12);
const OFFSET = Number(process.env.OFFSET ?? 0);
const OUT = process.env.OUT ?? `./validation/tuning_TH${TH}_PX${MINPX}.jsonl`;
if (!process.env.APPEND) { try { unlinkSync(OUT); } catch {} }

const LAYERS = [
  { biome: 'amazonia', type: 'deter-amz:deter_amz', bbox: '-52.5,-7.5,-51,-6', max: 200 },
  { biome: 'amazonia', type: 'deter-amz:deter_amz', bbox: '-54,-10,-50,-5', max: 150 },
  { biome: 'cerrado', type: 'deter-cerrado-nb:deter_cerrado', bbox: '-46,-12,-45,-11', max: 60 },
];
const all = [];
for (const L of LAYERS) {
  const url = `https://terrabrasilis.dpi.inpe.br/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=${L.type}&outputFormat=application%2Fjson&maxFeatures=${L.max}&bbox=${L.bbox}`;
  let feats = null;
  for (let attempt = 1; attempt <= 4 && !feats; attempt++) {
    try {
      const r = await fetch(url);
      const txt = await r.text();
      feats = JSON.parse(txt).features ?? [];
    } catch (e) {
      console.log(`WFS ${L.biome} tentativa ${attempt} falhou; retry...`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  if (!feats) {
    console.log(`WFS ${L.biome} falhou após retries (servidor instável)`);
    continue;
  }
  for (const f of feats) all.push({ ...f, _biome: L.biome });
}
// estratifica por bioma+mes: round-robin dos maiores por mes
const groups = new Map();
for (const f of all) {
  const p = f.properties ?? {};
  if (!String(p.classname ?? '').includes('DESMAT')) continue;
  if ((p.view_date ?? '') < '2026-01-01') continue;
  if ((p.areamunkm ?? 0) < 0.08) continue;
  const k = `${f._biome}|${String(p.view_date).slice(0, 7)}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f);
}
for (const g of groups.values()) g.sort((a, b) => (b.properties.areamunkm ?? 0) - (a.properties.areamunkm ?? 0));
const cands = [];
const seenAlerts = new Set();
const keys = [...groups.keys()].sort();
const cursor = new Map(keys.map((k) => [k, 0]));
let added = true;
while (cands.length < MAXN && added) {
  added = false;
  for (const k of keys) {
    const g = groups.get(k);
    let i = cursor.get(k);
    while (i < g.length) {
      const c = g[i++];
      const p = c.properties;
      const [lo, la] = centroid(c.geometry.coordinates[0][0]);
      const dk = `${p.view_date}|${la.toFixed(3)}|${lo.toFixed(3)}`;
      if (seenAlerts.has(dk)) continue;
      seenAlerts.add(dk);
      cands.push(c);
      added = true;
      break;
    }
    cursor.set(k, i);
    if (cands.length >= MAXN) break;
  }
}
console.log(`candidatos: ${cands.length} (${[...groups.keys()].length} estratos bioma/mes) TH=${TH} MINPX=${MINPX}`);
if (process.env.LIST_ONLY) {
  for (const c of cands) {
    const p = c.properties;
    const [lo, la] = centroid(c.geometry.coordinates[0][0]);
    console.log(` ${c._biome} ${p.view_date} ${p.classname} ${Number(p.areamunkm).toFixed(3)}km2 @ ${la.toFixed(3)},${lo.toFixed(3)}`);
  }
  process.exit(0);
}
const res = { tp: 0, fn: 0, tn: 0, fp: 0, skip: 0 };
const withTimeout = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms)),
]);
async function runOne(c, i, biome, expectZero, vd) {
  const t0 = Date.now();
  const row = vd ?? { thr: TH, minpx: MINPX, biome: c._biome, date: c.properties.view_date, cls: c.properties.classname, area: c.properties.areamunkm };
  try {
    const r = await withTimeout(runSample(c, i, biome, row, expectZero), 8 * 60_000, `amostra ${i}`);
    row.outcome = r;
    res[r] = (res[r] ?? 0) + 1;
  } catch (e) {
    console.log(`  ERRO/timeout: ${e.message}`);
    row.outcome = 'skip';
    row.error = String(e.message).slice(0, 120);
    res.skip++;
  }
  row.ms = Date.now() - t0;
  appendFileSync(OUT, JSON.stringify(row) + '\n');
}
// Controles negativos: mata estavel deve dar zero (TN). NEG="lat,lon;...".
if (process.env.NEG) {
  const pts = process.env.NEG.split(';').map((s) => s.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite));
  console.log(`controles negativos: ${pts.length}`);
  let i = 0;
  const old = new Date(
    (process.env.SCENE_BEFORE ? new Date(process.env.SCENE_BEFORE).getTime() : Date.now()) - 60 * 864e5,
  ).toISOString().slice(0, 10);
  for (const [la, lo] of pts) {
    i++;
    const d = 0.02;
    const pseudo = {
      _biome: 'controle',
      geometry: { coordinates: [[[[lo - d, la - d], [lo + d, la - d], [lo + d, la + d], [lo - d, la + d], [lo - d, la - d]]]] },
      properties: { view_date: old, classname: 'CONTROL', areamunkm: 0 },
    };
    await runOne(pseudo, i, 'controle', true,
      { thr: TH, minpx: MINPX, biome: 'controle', date: old, cls: 'CONTROL', area: 0, lat: la, lon: lo });
  }
} else {
  let i = 0;
  for (const c of cands.slice(OFFSET)) {
    i++;
    await runOne(c, i, c._biome, false);
  }
}
const { tp, fn, tn, fp } = res;
const rec = tp + fn ? tp / (tp + fn) : 0;
const prec = tp + fp ? tp / (tp + fp) : 0;
const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
console.log(`\nTH=${TH} PX=${MINPX}: TP=${tp} FN=${fn} TN=${tn} FP=${fp} skips=${res.skip} -> ${OUT}`);
console.log(`recall=${rec.toFixed(2)} precision=${prec.toFixed(2)} F1=${f1.toFixed(2)}`);
if (process.env.PERSIST === '1') {
  // Métrica com filtro de persistência: detecção só vale se persistiu em 2 cenas.
  // tp/fp não-persistidos viram fn/tn; 'unknown' mantém outcome original (falta de dados ≠ transiente).
  const { readFileSync } = await import('node:fs');
  const rows = readFileSync(OUT, 'utf8').trim().split('\n').map(JSON.parse);
  let ftp = 0, ffn = 0, ftn = 0, ffp = 0;
  for (const r of rows) {
    const o = r.outcome;
    if (o === 'tp') { if (r.persisted === false) ffn++; else ftp++; }
    else if (o === 'fn') ffn++;
    else if (o === 'fp') { if (r.persisted === false) ftn++; else ffp++; }
    else if (o === 'tn') ftn++;
  }
    const frec = ftp + ffn ? ftp / (ftp + ffn) : 0;
  const fprec = ftp + ffp ? ftp / (ftp + ffp) : 0;
  const ff1 = fprec + frec ? (2 * fprec * frec) / (fprec + frec) : 0;
  console.log(`PERSIST-filter: TP=${ftp} FN=${ffn} TN=${ftn} FP=${ffp}`);
  console.log(`recall=${frec.toFixed(2)} precision=${fprec.toFixed(2)} F1=${ff1.toFixed(2)}`);
  // Filtro estrito: exige overlap espacial (mesmo lugar) persist_iou>=0.3.
  // 'unknown' mantem outcome (falta de dados ≠ transiente).
  let stp = 0, sfn = 0, stn = 0, sfp = 0;
  for (const r of rows) {
    const kept = r.persisted === true && (r.persist_iou ?? 0) >= 0.3;
    const dropped = r.persisted === false || (r.persisted === true && (r.persist_iou ?? 0) < 0.3);
    const o = r.outcome;
    if (o === 'tp') { if (dropped) sfn++; else stp++; }
    else if (o === 'fn') sfn++;
    else if (o === 'fp') { if (dropped || r.persisted !== true) { if (r.persisted === 'unknown') sfp++; else stn++; } else sfp++; }
    else if (o === 'tn') stn++;
  }
  const srec = stp + sfn ? stp / (stp + sfn) : 0;
  const sprec = stp + sfp ? stp / (stp + sfp) : 0;
  const sf1 = sprec + srec ? (2 * sprec * srec) / (sprec + srec) : 0;
  console.log(`PERSIST-strict(iou>=0.3): TP=${stp} FN=${sfn} TN=${stn} FP=${sfp}`);
  console.log(`recall=${srec.toFixed(2)} precision=${sprec.toFixed(2)} F1=${sf1.toFixed(2)}`);
}
