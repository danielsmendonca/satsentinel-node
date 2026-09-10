import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ndvi, detectWindow, MIN_VALID_FRAC } from '../dist/src/pipeline/ndvi.js';
import { components, pixelBboxToRing, maskToMultiPolygon, traceContour, simplifyRing, snapRing } from '../dist/src/pipeline/vectorize.js';
import { parseMgrsTile, utmFromMgrs } from '../dist/src/fetcher/mgrs.js';
import { computeWindow, resampleNearest, extentToUtm } from '../dist/src/fetcher/windows.js';
import { isValidScl } from '../dist/src/pipeline/scl.js';
import { forestMask } from '../dist/src/pipeline/scl.js';
import { ChunkCache, coalescedGet } from '../dist/src/fetcher/cog.js';
import { fromMnemonic, importPairing } from '../dist/src/identity/operator.js';
import { mapLimit } from '../dist/src/ui/server.js';
import { qaClear, stToCelsius, cellTemperature, landsatUtmDef, tempColor, medianOf, ndviColor } from '../dist/src/thermal/landsat.js';
import { computeContainerDigest } from '../dist/src/security/digest.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMnemonic } from 'bip39';

test('piso ceu-limpo trava em 0.6 (tuning DETER R2: mata FPs de borda sem perder TPs)', () => {
  assert.equal(MIN_VALID_FRAC, 0.6);
});

test('ndvi queda detecta anomalia; sem queda nao detecta', () => {
  const n = 8 * 8; // >= MIN_COMPONENT_PX (50)
  const red = new Float32Array(n).fill(800);
  const nirBase = new Float32Array(n).fill(4000);
  const nirNow = new Float32Array(n).fill(2500);
  const base = ndvi(red, nirBase);
  const hit = detectWindow(red, nirNow, new Uint8Array(n).fill(4), [base, base]);
  assert.ok(hit.count > 0 && hit.uncalibrated > 0.3);
  const miss = detectWindow(red, nirBase, new Uint8Array(n).fill(4), [base, base]);
  assert.equal(miss.count, 0);
});

test('sweep dNDVI [-0.12,-0.15,-0.20] e monotonico (guia tuning Fase 0)', () => {
  // base NDVI = 0.667; metade forte (d~-0.24), metade media (d~-0.13)
  const n = 16 * 16;
  const red = new Float32Array(n).fill(800);
  const nirBase = new Float32Array(n).fill(4000);
  const base = ndvi(red, nirBase);
  const nirNow = new Float32Array(n);
  for (let i = 0; i < n / 2; i++) nirNow[i] = 2000;
  for (let i = n / 2; i < n; i++) nirNow[i] = 2650;
  const scl = new Uint8Array(n).fill(4);
  const c = (thr) => detectWindow(red, nirNow, scl, [base, base], 'DEFORESTATION', { dndviThreshold: thr }).count;
  const c12 = c(-0.12), c15 = c(-0.15), c20 = c(-0.20);
  assert.equal(c12, 256);
  assert.equal(c15, 128);
  assert.equal(c20, 128);
});

test('SCL mascara nuvem/sombra; agua so vale p/ WATER', () => {
  assert.equal(isValidScl(9, 'DEFORESTATION'), false);
  assert.equal(isValidScl(4, 'DEFORESTATION'), true);
  assert.equal(isValidScl(6, 'DEFORESTATION'), false);
  assert.equal(isValidScl(6, 'WATER_BODY_CHANGE'), true);
});

test('area minima 50px filtra ruido', () => {
  const n = 8 * 8; // 64px mas so 10 anomalos
  const red = new Float32Array(n).fill(800);
  const nirB = new Float32Array(n).fill(4000);
  const nirN = new Float32Array(n).fill(4000);
  for (let i = 0; i < 10; i++) nirN[i] = 2000;
  const base = ndvi(red, nirB);
  const r = detectWindow(red, nirN, new Uint8Array(n).fill(4), [base, base]);
  assert.equal(r.count, 0);
});

test('coalescing agrupa ranges proximos e usa cache', async () => {
  let calls = 0;
  const get = async (_u, s, e) => { calls++; return new Uint8Array(e - s + 1).fill(7); };
  const cache = new ChunkCache();
  const out = await coalescedGet('http://x', [[0, 99], [100, 199]], get, cache);
  assert.equal(calls, 1);
  assert.equal(out[0].length, 100);
  await coalescedGet('http://x', [[0, 99]], get, cache);
  assert.equal(calls, 1); // cache
});

test('pareamento por mnemonic e deterministico; import valida', () => {
  const m = generateMnemonic(128);
  const a = fromMnemonic(m);
  const b = fromMnemonic(m);
  assert.equal(a.operator_id, b.operator_id);
  assert.equal(a.private_key_hex, b.private_key_hex);
  assert.throws(() => importPairing('{"a":1}', 'test-tmp-cfg'), /invalido/);
});

test('mgrs -> UTM (sul e norte, id como fallback)', () => {
  assert.deepEqual(
    ((z) => [z.zone, z.south, z.epsg])(utmFromMgrs('23KPR')),
    [23, true, 32723],
  );
  assert.deepEqual(
    ((z) => [z.zone, z.south, z.epsg])(utmFromMgrs('32TQR')),
    [32, false, 32632],
  );
  assert.equal(parseMgrsTile('S2B_23KPR_20260904_0_L2A', {}), '23KPR');
  assert.equal(parseMgrsTile('x', { 's2:mgrs_tile': '22MGB' }), '22MGB');
  assert.throws(() => utmFromMgrs('UNKNOWN'), /MGRS invalido/);
});

test('extent 4326 -> metros UTM tem ordem e tamanho plausiveis', () => {
  const m = extentToUtm([-55, -11, -54, -10], '+proj=utm +zone=23 +south +datum=WGS84 +units=m +no_defs');
  assert.ok(m[0] < m[2] && m[1] < m[3]);
  assert.ok(m[2] - m[0] > 100000 && m[2] - m[0] < 130000); // ~1 grau lon a -10.5
  assert.ok(m[3] - m[1] > 100000 && m[3] - m[1] < 120000);
});

test('computeWindow ancora no halo e clampa na imagem', () => {
  // imagem 1000x1000px de 10m, origem (500000, 8900000)
  const w = computeWindow(500000, 8900000, 10, 500000, 8890000, 510000, 8900000, 505000, 8895000, 505100, 8895100, 0);
  assert.deepEqual([w.left, w.top, w.width, w.height], [500, 490, 10, 10]);
  // halo expande e clamp segura borda: left encosta no 0, top fica em 495
  const w2 = computeWindow(500000, 8900000, 10, 500000, 8890000, 510000, 8900000, 500000, 8890000, 500050, 8890050, 5000);
  assert.deepEqual([w2.left, w2.top, w2.width, w2.height], [0, 495, 505, 505]);
});

test('resampleNearest mapeia pelo centro do pixel', () => {
  const src = { data: Uint8Array.from([1, 2, 3, 4]), width: 2, height: 2, res: 20, originX: 0, originY: 40 };
  const out = resampleNearest(src, 4, 4, 0, 40, 10);
  assert.deepEqual([...out.slice(0, 2)], [1, 1]);
  assert.deepEqual([...out.slice(8, 10)], [3, 3]);
});

test('vetorizacao: 2 manchas 8x8, diagonal nao conecta, anel fecha em lon/lat', () => {
  const W = 20, H = 20;
  const mask = new Uint8Array(W * H);
  const sq = (c0, r0) => { for (let r = r0; r < r0 + 8; r++) for (let c = c0; c < c0 + 8; c++) mask[r * W + c] = 1; };
  sq(1, 1); sq(11, 11);
  mask[5 * W + 5] = 1; // pixel isolado: diagonal nao conecta em 4-vizinhanca
  const comps = components(mask, W, H, 50);
  assert.equal(comps.length, 2); // 8x8=64px cada; o pixel solto (1px) filtrado
  assert.deepEqual([comps[0].c0, comps[0].r0, comps[0].c1, comps[0].r1], [1, 1, 8, 8]);
  const utm21s = '+proj=utm +zone=21 +south +datum=WGS84 +units=m +no_defs';
  const ring = pixelBboxToRing(1, 1, 8, 8, 500000, 8840000, 10, utm21s);
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  assert.ok(ring[0][0] < -56.5 && ring[0][0] > -57.5 && ring[0][1] < -10 && ring[0][1] > -11);
  const mp = maskToMultiPolygon(mask, W, H, 500000, 8840000, 10, utm21s, 50);
  assert.equal(mp.type, 'MultiPolygon');
  assert.equal(mp.coordinates.length, 2);
  assert.equal(maskToMultiPolygon(new Uint8Array(W * H), W, H, 500000, 8840000, 10, utm21s, 50), null);
});

const shoelace = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
};

test('traceContour: area exata do quadrado 8x8 e fecha o anel', () => {
  const W = 20, H = 20;
  const mask = new Uint8Array(W * H);
  for (let r = 4; r < 12; r++) for (let c = 4; c < 12; c++) mask[r * W + c] = 1;
  const ring = traceContour(mask, W, H, 4, 4, 11, 11);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.deepEqual(ring[0], [4, 4]);
  assert.equal(shoelace(ring), 64); // area exata em px, sem inset
});

test('traceContour: forma em L fecha com area exata', () => {
  const W = 12, H = 12;
  const mask = new Uint8Array(W * H);
  for (let r = 2; r < 8; r++) for (let c = 2; c < 4; c++) mask[r * W + c] = 1; // haste 6x2=12
  for (let r = 6; r < 8; r++) for (let c = 4; c < 8; c++) mask[r * W + c] = 1; // pe 2x4=8 (adjacente, conexo)
  const ring = traceContour(mask, W, H, 2, 2, 7, 7);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(shoelace(ring), 20); // 12+8, uniao exata
});

test('traceContour: pixel isolado vira quadrado unitario', () => {  const W = 5, H = 5;
  const mask = new Uint8Array(W * H);
  mask[2 * W + 2] = 1;
  const ring = traceContour(mask, W, H, 2, 2, 2, 2);
  assert.equal(ring.length, 5);
  assert.equal(shoelace(ring), 1);
});

test('simplifyRing: quadrado intacto, colineares removidos, anel fecha', () => {  const sq = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4], [0, 0]];
  const s = simplifyRing(sq, 1.0);
  assert.deepEqual(s, [[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]]);
  assert.equal(shoelace(s), 64);
  const tiny = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  assert.ok(simplifyRing(tiny, 1.0).length <= 5);
});
test('mapLimit respeita concorrencia e preserva indices', async () => {
  // deterministico: barreira libera a 1a task quando a 2a comeca (sem timing)
  let live = 0, peak = 0, started = 0, release = () => {};
  const gate = new Promise((r) => { release = r; });
  const out = await mapLimit([0, 1, 2, 3], 2, async (x) => {
    live++; peak = Math.max(peak, live); started++;
    if (started === 2) release();
    else await gate;
    live--;
    return x * 2;
  });
  assert.deepEqual(out, [0, 2, 4, 6]);
  assert.equal(peak, 2);
});

test('digest: deterministico, formato sha256:, muda com o conteudo', () => {  const d = mkdtempSync(join(tmpdir(), 'dig-'));
  mkdirSync(join(d, 'sub'));
  writeFileSync(join(d, 'b.js'), 'b');
  writeFileSync(join(d, 'sub', 'a.js'), 'a');
  const h1 = computeContainerDigest(d, '1.3.0');
  const h2 = computeContainerDigest(d, '1.3.0');
  assert.equal(h1, h2);
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(h1));
  writeFileSync(join(d, 'sub', 'a.js'), 'alterado');
  assert.notEqual(computeContainerDigest(d, '1.3.0'), h1);
});

test('forestMask: 2 de 3 com SCL=4 passa; 1 de 3 nao', () => {
  const veg = new Uint8Array(4).fill(4);
  const solo = new Uint8Array(4).fill(5);
  assert.deepEqual([...forestMask([veg, veg, solo])], [1, 1, 1, 1]);
  assert.deepEqual([...forestMask([veg, solo, solo])], [0, 0, 0, 0]);
  assert.deepEqual([...forestMask([veg, solo])], [0, 0, 0, 0]); // 2 baselines: exige 2
  assert.deepEqual([...forestMask([veg, veg])], [1, 1, 1, 1]);
});

test('gate floresta: anomalia em ex-pasto nao vota; em ex-floresta vota', () => {
  const n = 8 * 8;
  const red = new Float32Array(n).fill(800);
  const nirBase = new Float32Array(n).fill(4000);
  const nirNow = new Float32Array(n).fill(2000);
  const base = ndvi(red, nirBase);
  const sclNow = new Uint8Array(n).fill(5); // virou solo
  const past = new Uint8Array(n).fill(5); // era pasto: sem voto
  const fore = new Uint8Array(n).fill(4); // era floresta: vota
  const semGate = detectWindow(red, nirNow, sclNow, [base, base], 'DEFORESTATION');
  assert.ok(semGate.count > 0); // sem mascara: comportamento antigo preservado
  const r1 = detectWindow(red, nirNow, sclNow, [base, base], 'DEFORESTATION',
    { requireForest: true, forest: forestMask([past, past]) });
  assert.equal(r1.count, 0);
  const r2 = detectWindow(red, nirNow, sclNow, [base, base], 'DEFORESTATION',
    { requireForest: true, forest: forestMask([fore, fore]) });
  assert.ok(r2.count > 0);
});

test('fill-ratio: cruz esparsa cai, mancha macica passa', () => {
  const W = 10, H = 10;
  const cross = new Uint8Array(W * H);
  for (let i = 0; i < 10; i++) { cross[5 * W + i] = 1; cross[i * W + 5] = 1; } // 19px, bbox 100, fill 0.19
  assert.equal(components(cross, W, H, 5, 50, 0.25).length, 0);
  assert.equal(components(cross, W, H, 5, 50, 0).length, 1);
  const sq = new Uint8Array(W * H);
  for (let r = 1; r < 7; r++) for (let c = 1; c < 7; c++) sq[r * W + c] = 1; // 6x6 fill 1.0
  assert.equal(components(sq, W, H, 5, 50, 0.5).length, 1);
});

test('termal: QA mascara nuvem, Kelvin->C, mediana ignora sujo', () => {
  assert.equal(qaClear(0), true);
  assert.equal(qaClear(1 << 3), false); // cloud
  assert.equal(qaClear(1 << 4), false); // shadow
  assert.equal(qaClear(1 << 6), true); // bit clear sozinho nao suja
  assert.equal(stToCelsius(0), null);
  assert.ok(Math.abs(stToCelsius(30000) - 26.85) < 0.01);
  assert.equal(stToCelsius(100000), null); // disparate
  const t = cellTemperature([30000, 31000, 32000, 0], [0, 0, 8, 0]);
  assert.equal(t.clear, 2);
  assert.ok(Math.abs(t.medianC - 31.85) < 0.01);
  assert.equal(t.clearFrac, 0.5);
  assert.equal(cellTemperature([0], [0]).medianC, null);
});

test('termal: UTM por centroide + escala de cor nos extremos', () => {
  assert.ok(landsatUtmDef(-54.8, -8).includes('+zone=21'));
  assert.ok(landsatUtmDef(-54.8, -8).includes('+south'));
  assert.ok(landsatUtmDef(-54.8, 8).includes('+zone=21'));
  assert.ok(!landsatUtmDef(-54.8, 8).includes('south'));
  assert.equal(tempColor(5), '#3b82f6');
  assert.equal(tempColor(50), '#ef4444');
});

test('ndvi layer: mediana e cor', () => {
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([0.7]), 0.7);
  assert.equal(medianOf([0.2, 0.8]), 0.5);
  assert.equal(ndviColor(0), '#78643c');
  assert.equal(ndviColor(1), '#22c55e');
});

test('snapRing: tira quase-duplicados e mantém fecho (anti-GEOS-XX000)', () => {
  const ring = [[0, 0], [1, 0], [1 + 1e-12, 0], [1, 1], [0, 1], [0, 0]];
  const s = snapRing(ring);
  assert.deepEqual(s, [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  for (let i = 1; i < s.length; i++) {
    assert.ok(Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]) > 0);
  }
});
