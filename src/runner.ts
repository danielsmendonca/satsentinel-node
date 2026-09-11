/**
 * Polling Worker Loop (GDD Sec 2/6): Pull -> Heartbeat -> Process -> Report.
 * 1. Garante identidade + registro + JWT (challenge).
 * 2. POST /tasks/lease; 204 = oculos -> espera.
 * 3. Processa demo deterministico (pipeline puro; COG real via geotiff quando URL interna).
 * 4. POST /results/report assinado; heartbeat a cada 2min durante processamento longo.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { signPayload } from '@satsentinel/protocol';
import { loadOrCreate } from './identity/operator.js';
import proj4 from 'proj4';
import { detectWindow, ndvi, medianOf, MIN_VALID_FRAC, PERSIST_IOU_MIN, maskIoU } from './pipeline/ndvi.js';
import { renderNdviThumb, THUMB_CACHE_KEEP } from './viz/thumb.js';
import { maskToMultiPolygon } from './pipeline/vectorize.js';
import { parseMgrsTile, utmFromMgrs } from './fetcher/mgrs.js';
import { forestMask } from './pipeline/scl.js';
import { readBandWindow, resampleNearest } from './fetcher/windows.js';
import { computeContainerDigest } from './security/digest.js';
import { cellToBoundary } from 'h3-js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bundleHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
// Digest real do bundle: o server só aceita leases/reports deste build (ALLOWED_DIGESTS).
const hereDir = dirname(fileURLToPath(import.meta.url)); // dist/src
let containerDigest = 'sha256:' + '0'.repeat(64);
try {
  const pkg = JSON.parse(readFileSync(join(hereDir, '..', '..', 'package.json'), 'utf8')) as { version?: string };
  containerDigest = computeContainerDigest(join(hereDir, '..'), pkg.version ?? '');
} catch { /* sem dist: mantém zeros (dev) */ }

async function api(base: string, path: string, init?: RequestInit) {
  const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ data: Record<string, unknown> }>;
}

export interface Session { base: string; auth: Record<string, string>; }
/** Registro + challenge Ed25519 -> JWT. Reusado pelo /api/run (ensure + N iteracoes). */
export async function getSession(configDir = 'config'): Promise<Session & { key: import('./identity/operator.js').OperatorKey; cfg: import('./identity/operator.js').NodeConfig }> {
  const { key, cfg } = loadOrCreate(configDir);
  const base = cfg.server_url.replace(/\/$/, '');
  // register (idempotente)
  await api(base, '/v1/operators/register', {
    method: 'POST',
    body: JSON.stringify({ operator_id: key.operator_id, public_key_hex: key.public_key_hex, node_id: cfg.node_id, hw_arch: 'amd64' }),
  }).catch(() => undefined);
  // challenge + verify
  const ch = await api(base, `/v1/auth/challenge?operator_id=${key.operator_id}&node_id=${cfg.node_id}`);
  const nonceHex = (ch!.data as { nonce_hex: string }).nonce_hex;
  const digest = (await import('@noble/hashes/sha256')).sha256(new TextEncoder().encode(
    (await import('@satsentinel/protocol')).canonicalize({ nonce_hex: nonceHex }),
  ));
  const sig = bytesToHex(ed25519.sign(digest, hexToBytes(key.private_key_hex)));
  const ver = await api(base, '/v1/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ operator_id: key.operator_id, node_id: cfg.node_id, nonce_hex: nonceHex, signature_hex: sig, hw_arch: 'amd64' }),
  });
  const token = (ver!.data as { token: string }).token;
  return { base, auth: { Authorization: `Bearer ${token}` }, key, cfg };
}

export interface RunDetail {
  status: 'reported' | 'idle' | 'failed';
  taskId?: string;
  h3?: string;
  score?: number;
  eventId?: string | null;
  decision?: string;
  quorum?: string;
  persisted?: boolean;
  thumbs?: boolean;
  evidence?: boolean;
  error?: string;
}

export async function runOnce(configDir = 'config'): Promise<string> {
  return (await runOnceDetailed(configDir)).status;
}

type Lease = {
  assignment_id: string; task_id: string; observation_id: string; h3_index: string; mgrs_tile: string;
  event_class: 'DEFORESTATION' | 'WATER_BODY_CHANGE'; baseline_scene: string;
  task_kind?: 'SINGLE' | 'DUAL_EPOCH'; // v1.4: ausente = SINGLE (compat 1.3)
  cog_urls: { B04: string; B08: string; SCL: string; baselines: Array<{ scene: string; B04: string; B08: string; SCL: string }>; epoch2?: { scene: string; B04: string; B08: string; SCL: string } };
};

export interface PersistenceEvidence {
  epoch2_scene: string; persist_count: number; persist_iou: number; persisted: boolean;
}

interface GridRef { width: number; height: number; res: number; originX: number; originY: number; }

/**
 * Deteccao na epoch2 (v1.4): mesmas grade/baselines/opts de t0. Falha de
 * download da 2a cena propaga (fail honesto NO_EPOCH2/COG) — nunca vota cego.
 */
async function detectEpoch(
  lease: Lease, extent: [number, number, number, number], utmDef: string, ref: GridRef,
  readOnGrid: (url: string) => Promise<{ data: Float32Array; originX: number; originY: number }>,
  baseNdvis: Float32Array[], eventClass: 'DEFORESTATION' | 'WATER_BODY_CHANGE',
  detOpts: { requireForest?: boolean; forest?: Uint8Array },
): Promise<{ mask: Uint8Array; count: number }> {
  const e2 = lease.cog_urls.epoch2!;
  const red = (await readOnGrid(e2.B04)).data;
  const nir = (await readOnGrid(e2.B08)).data;
  const sclRaw = await readBandWindow(e2.SCL, extent, utmDef, 1280);
  const scl = resampleNearest(
    { data: sclRaw.data, width: sclRaw.width, height: sclRaw.height, res: sclRaw.res, originX: sclRaw.originX, originY: sclRaw.originY },
    ref.width, ref.height, ref.originX, ref.originY, ref.res,
  );
  const det = detectWindow(red, nir, scl, baseNdvis, eventClass, detOpts);
  return { mask: det.mask, count: det.count };
}

/**
 * Pipeline real sobre COGs (GDD Sec 7): janelas B04/B08/SCL de t0 + baselines,
 * NDVI, mediana temporal, dNDVI, vetorizacao. Nada sintético: qualquer falha
 * propaga para o chamador marcar FAILED em vez de votar lixo.
 *
 * v1.4 DUAL_EPOCH: com epoch2 congelada, roda a mesma deteccao na 2a cena
 * (mesma grade/baselines). Transiente (sem deteccao ou IoU < PERSIST_IOU_MIN)
 * vota NULO honesto em vez de FP; o server recebe a evidencia em `persistence`.
 * Exportado p/ validacao live (validation/dual_live.mjs) — producao usa via runOnceDetailed.
 */
export interface VoteThumbs { t0: Uint8Array; base: Uint8Array; }
/** Cantos lat/lon da janela votada (p/ overlay no mapa). sw=[lat,lon], ne=[lat,lon]. */
export interface ThumbBounds { sw: [number, number]; ne: [number, number]; }

export async function processReal(
  lease: Lease, eventClass: 'DEFORESTATION' | 'WATER_BODY_CHANGE',
): Promise<{ geometry: { type: 'MultiPolygon'; coordinates: number[][][][] } | null; score: number; validFrac: number; persistence?: PersistenceEvidence; thumbs?: VoteThumbs; thumbBounds?: ThumbBounds }> {
  const mgrs = lease.mgrs_tile && lease.mgrs_tile !== 'UNKNOWN'
    ? lease.mgrs_tile : parseMgrsTile(lease.observation_id, {});
  const { def: utmDef } = utmFromMgrs(mgrs);
  const ring = cellToBoundary(lease.h3_index); // [lat,lon][]
  let w = 180, s = 90, e = -180, n = -90;
  for (const [lat, lon] of ring) {
    if (lon < w) w = lon; if (lon > e) e = lon;
    if (lat < s) s = lat; if (lat > n) n = lat;
  }
  const extent: [number, number, number, number] = [w, s, e, n];
  const haloM = 1280; // halo 128px @10m
  const ref = await readBandWindow(lease.cog_urls.B08, extent, utmDef, haloM);
  const readOnGrid = async (url: string) => {
    const g = await readBandWindow(url, extent, utmDef, haloM);
    if (g.width === ref.width && g.height === ref.height) {
      return { data: g.data as Float32Array, originX: g.originX, originY: g.originY };
    }
    // grade 20m (SCL) ou cena vizinha: reamostra p/ grade de referencia
    const up = resampleNearest(
      { data: g.data, width: g.width, height: g.height, res: g.res, originX: g.originX, originY: g.originY },
      ref.width, ref.height, ref.originX, ref.originY, ref.res,
    );
    return { data: Float32Array.from(up), originX: ref.originX, originY: ref.originY };
  };
  const red = (await readOnGrid(lease.cog_urls.B04)).data;
  const nir = ref.data as Float32Array;
  const sclRaw = await readBandWindow(lease.cog_urls.SCL, extent, utmDef, haloM);
  const scl = resampleNearest(
    { data: sclRaw.data, width: sclRaw.width, height: sclRaw.height, res: sclRaw.res, originX: sclRaw.originX, originY: sclRaw.originY },
    ref.width, ref.height, ref.originX, ref.originY, ref.res,
  );
  const baselines = lease.cog_urls.baselines;
  if (!baselines || baselines.length < 2) throw new Error('NO_BASELINE: menos de 2 baselines congeladas');
  const baseNdvis: Float32Array[] = [];
  const baseScls: Uint8Array[] = [];
  for (const b of baselines.slice(0, 3)) {
    const br = (await readOnGrid(b.B04)).data;
    const bn = (await readOnGrid(b.B08)).data;
    baseNdvis.push(ndvi(br, bn));
    if (eventClass === 'DEFORESTATION') {
      const bs = await readBandWindow(b.SCL, extent, utmDef, haloM);
      baseScls.push(resampleNearest(
        { data: bs.data, width: bs.width, height: bs.height, res: bs.res, originX: bs.originX, originY: bs.originY },
        ref.width, ref.height, ref.originX, ref.originY, ref.res,
      ));
    }
  }
  const forest = eventClass === 'DEFORESTATION' ? forestMask(baseScls) : undefined;
  const det = detectWindow(red, nir, scl, baseNdvis, eventClass,
    forest ? { requireForest: true, forest } : {});
  if (det.validFracT0 < MIN_VALID_FRAC) throw new Error(`valid_frac=${det.validFracT0.toFixed(2)} abaixo de ${MIN_VALID_FRAC} (nuvem/haze)`);
  // F1 visual: thumbs NDVI t0 (com contorno) + mediana das baselines.
  // Best-effort puro: nunca derruba voto; salva quem chama (runOnceDetailed).
  let thumbs: VoteThumbs | undefined;
  let thumbBounds: ThumbBounds | undefined;
  try {
    const cur = ndvi(red, nir);
    const med = medianOf(baseNdvis, cur);
    thumbs = {
      t0: renderNdviThumb(cur, ref.width, ref.height, det.count > 0 ? det.mask : null).png,
      base: renderNdviThumb(med, ref.width, ref.height, null).png,
    };
    // Cantos da janela em lat/lon (overlay georreferenciado no mapa).
    const inv = (x: number, y: number): [number, number] => {
      const [lon, lat] = proj4(utmDef, 'EPSG:4326', [x, y]) as [number, number];
      return [lat, lon];
    };
    const nw = inv(ref.originX, ref.originY);
    const se = inv(ref.originX + ref.width * ref.res, ref.originY - ref.height * ref.res);
    thumbBounds = {
      sw: [Math.min(nw[0], se[0]), Math.min(nw[1], se[1])],
      ne: [Math.max(nw[0], se[0]), Math.max(nw[1], se[1])],
    };
  } catch { /* sem thumbs, voto segue */ }
  // v1.4 DUAL_EPOCH: confirma na 2a cena antes de votar (R5).
  const epoch2 = lease.cog_urls.epoch2;
  if ((lease.task_kind ?? 'SINGLE') === 'DUAL_EPOCH' || epoch2) {
    if (!epoch2) throw new Error('NO_EPOCH2: task DUAL sem epoch2 congelada');
    if (det.count > 0) {
      const detOpts = forest ? { requireForest: true, forest } : {};
      const e2 = await detectEpoch(lease, extent, utmDef, ref, readOnGrid, baseNdvis, eventClass, detOpts);
      const piou = maskIoU(det.mask, e2.mask);
      const persisted = e2.count > 0 && piou >= PERSIST_IOU_MIN;
      const persistence: PersistenceEvidence = { epoch2_scene: epoch2.scene, persist_count: e2.count, persist_iou: +piou.toFixed(3), persisted };
      if (!persisted) {
        return { geometry: null, score: 0, validFrac: det.validFracT0, persistence, ...(thumbs ? { thumbs } : {}), ...(thumbBounds ? { thumbBounds } : {}) };
      }
      const geometry = maskToMultiPolygon(det.mask, ref.width, ref.height, ref.originX, ref.originY, ref.res, utmDef, 50, 0.25);
      return { geometry, score: geometry ? det.uncalibrated : 0, validFrac: det.validFracT0, persistence, ...(thumbs ? { thumbs } : {}), ...(thumbBounds ? { thumbBounds } : {}) };
    }
  }
  const geometry = det.count > 0
    ? maskToMultiPolygon(det.mask, ref.width, ref.height, ref.originX, ref.originY, ref.res, utmDef, 50, 0.25)
    : null;
  const score = geometry ? det.uncalibrated : 0; // sem feicao >=50px: sem deteccao (Zod exige score<0.1 p/ null)
  return { geometry, score, validFrac: det.validFracT0, ...(thumbs ? { thumbs } : {}), ...(thumbBounds ? { thumbBounds } : {}) };
}

export async function runOnceDetailed(configDir = 'config'): Promise<RunDetail> {
  const { key, cfg, base, auth } = await getSession(configDir);
  // lease
  const leaseRes = await fetch(`${base}/v1/tasks/lease`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ node_id: cfg.node_id, operator_id: key.operator_id, hw_arch: 'amd64', algorithm_version: 'DETERMINISTIC_NDVI_v1.2.0', processing_profile: 'MVP_AMAZON_R6_HALO128', container_digest: containerDigest }),
  });
  if (leaseRes.status === 204) return { status: 'idle' };
  if (!leaseRes.ok) throw new Error(`lease ${leaseRes.status}`);
  const lease = ((await leaseRes.json()) as { data: {
    assignment_id: string; task_id: string; observation_id: string; h3_index: string; mgrs_tile: string;
    event_class: 'DEFORESTATION' | 'WATER_BODY_CHANGE'; baseline_scene: string;
    task_kind?: 'SINGLE' | 'DUAL_EPOCH';
    cog_urls: { B04: string; B08: string; SCL: string; baselines: Array<{ scene: string; B04: string; B08: string; SCL: string }>; epoch2?: { scene: string; B04: string; B08: string; SCL: string } };
  } }).data;
  const eventClass = lease.event_class ?? 'DEFORESTATION'; // protocolo 1.3: task diz a classe cacada
  const t0 = Date.now();
  // Heartbeat periódico durante o processamento (voto DUAL baixa 2 cenas e
  // estoura os 10min do lease sem isso). Limpa ao final (finally).
  const hbTimer = setInterval(() => {
    fetch(`${base}/v1/tasks/${lease.assignment_id}/heartbeat`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: '{}',
    }).catch(() => undefined);
  }, 120_000);
  try {
    const { geometry, score, validFrac, persistence, thumbs, thumbBounds } = await processReal(lease, eventClass);
    // F1 visual: thumbs em cache local (nunca no report: raster nao cruza o protocolo).
    let thumbSaved = false;
    if (thumbs) {
      try {
        const dir = join(configDir, 'thumbs');
        mkdirSync(dir, { recursive: true });
        const prefix = `${lease.h3_index}_${lease.task_id}`;
        writeFileSync(join(dir, `${prefix}_t0.png`), thumbs.t0);
        writeFileSync(join(dir, `${prefix}_base.png`), thumbs.base);
        if (thumbBounds) writeFileSync(join(dir, `${prefix}_meta.json`), JSON.stringify(thumbBounds));
        thumbSaved = true;
        // LRU simples: passa do teto, apaga os PNGs mais antigos (+ meta irma).
        const files = readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => {
          try { return { f, m: statSync(join(dir, f)).mtimeMs }; } catch { return null; }
        }).filter((x): x is { f: string; m: number } => !!x).sort((a, b) => a.m - b.m);
        while (files.length > THUMB_CACHE_KEEP * 2) {
          const old = files.shift();
          try {
            unlinkSync(join(dir, old!.f));
            unlinkSync(join(dir, old!.f.replace(/_(t0|base)\.png$/, '_meta.json')));
          } catch { /* ja foi */ }
        }
      } catch { /* cache visual nao derruba voto */ }
    }
    // renova o lease antes de reportar (processamento real pode levar minutos)
    await fetch(`${base}/v1/tasks/${lease.assignment_id}/heartbeat`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: '{}',
    }).catch(() => undefined);
    const execMs = Math.max(1000, Date.now() - t0);
    const report: Record<string, unknown> = {
      assignment_id: lease.assignment_id, task_id: lease.task_id, node_id: cfg.node_id, operator_id: key.operator_id,
      geometry, model_score: score, event_class: eventClass,
      ...(persistence ? { persistence } : {}),
      radiometric_quality: { valid_frac: validFrac, cloud_frac: 1 - validFrac, baseline_scene: lease.baseline_scene, eps: 1e-6 },
      execution_time_ms: execMs, container_digest: containerDigest, algorithm_sha256: bundleHash,
    };
    report.signature_hex = signPayload(report, hexToBytes(key.private_key_hex));
    const accepted = await api(base, '/v1/results/report', { method: 'POST', headers: auth, body: JSON.stringify(report) });
    const d = (accepted!.data ?? {}) as { event_id?: string | null; decision?: string; quorum_state?: string };
    // F5 album: anexa thumbs (so com deteccao), FORA do consenso. Best-effort:
    // falha no upload nunca invalida o voto ja aceito.
    let evidence = false;
    if (geometry && thumbs) {
      try {
        for (const kind of ['t0', 'base'] as const) {
          await api(base, '/v1/evidence', {
            method: 'POST', headers: auth,
            body: JSON.stringify({
              task_id: lease.task_id, assignment_id: lease.assignment_id, kind,
              png_base64: Buffer.from(thumbs[kind]).toString('base64'),
            }),
          });
        }
        evidence = true;
      } catch { /* album e opcional */ }
    }
    return { status: 'reported', taskId: lease.task_id, h3: lease.h3_index, score, eventId: d.event_id ?? null, decision: d.decision, quorum: d.quorum_state, ...(persistence ? { persisted: persistence.persisted } : {}), ...(thumbSaved ? { thumbs: true } : {}), ...(evidence ? { evidence: true } : {}) };
  } catch (e) {
    // Falha honesta marca FAILED (libera p/ outros, exclui este no). Excecao:
    // 5xx do server (transitorio) -> nao marca; o lease expira e o voto refaz.
    const msg = String(e instanceof Error ? e.message : e);
    if (!/-> 5\d\d/.test(msg)) {
      const reason = failReason(e);
      await fetch(`${base}/v1/tasks/${lease.assignment_id}/fail`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ reason }),
      }).catch(() => undefined);
      return { status: 'failed', taskId: lease.task_id, h3: lease.h3_index, error: `${reason}: ${msg.slice(0, 120)}` };
    }
    return { status: 'failed', taskId: lease.task_id, h3: lease.h3_index, error: `SERVER: ${msg.slice(0, 120)}` };
  } finally {
    clearInterval(hbTimer);
  }
}

function failReason(e: unknown): string {
  const m = String(e instanceof Error ? e.message : e);
  if (/too_big|vertices|GEOMETRY/i.test(m)) return 'VETOR_GRANDE';
  if (/MGRS|mgrs|UTM|proj/i.test(m)) return 'MGRS_UNKNOWN';
  if (/baseline/i.test(m)) return 'NO_BASELINE';
  if (/EPOCH2|epoch2/i.test(m)) return 'NO_EPOCH2';
  if (/janela|window|grande/i.test(m)) return 'WINDOW_EMPTY';
  if (/LOW_VALID|valid_frac|nuvem|cloud/i.test(m)) return 'LOW_VALID';
  return 'COG_FETCH';
}

if (process.argv[1]?.endsWith('runner.js')) {
  for (;;) {
    try { console.log(await runOnce(process.env.CONFIG_DIR ?? 'config')); }
    catch (e) { console.error('loop', e); }
    await sleep(Number(process.env.POLL_MS ?? 30_000));
  }
}
