/**
 * Polling Worker Loop (GDD Sec 2/6): Pull -> Heartbeat -> Process -> Report.
 * 1. Garante identidade + registro + JWT (challenge).
 * 2. POST /tasks/lease; 204 = oculos -> espera.
 * 3. Processa demo deterministico (pipeline puro; COG real via geotiff quando URL interna).
 * 4. POST /results/report assinado; heartbeat a cada 2min durante processamento longo.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { signPayload } from '@satsentinel/protocol';
import { loadOrCreate } from './identity/operator.js';
import { detectWindow, ndvi } from './pipeline/ndvi.js';
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
  error?: string;
}

export async function runOnce(configDir = 'config'): Promise<string> {
  return (await runOnceDetailed(configDir)).status;
}

type Lease = {
  assignment_id: string; task_id: string; observation_id: string; h3_index: string; mgrs_tile: string;
  event_class: 'DEFORESTATION' | 'WATER_BODY_CHANGE'; baseline_scene: string;
  cog_urls: { B04: string; B08: string; SCL: string; baselines: Array<{ scene: string; B04: string; B08: string; SCL: string }> };
};

/**
 * Pipeline real sobre COGs (GDD Sec 7): janelas B04/B08/SCL de t0 + baselines,
 * NDVI, mediana temporal, dNDVI, vetorizacao. Nada sintético: qualquer falha
 * propaga para o chamador marcar FAILED em vez de votar lixo.
 */
async function processReal(
  lease: Lease, eventClass: 'DEFORESTATION' | 'WATER_BODY_CHANGE',
): Promise<{ geometry: { type: 'MultiPolygon'; coordinates: number[][][][] } | null; score: number; validFrac: number }> {
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
  if (det.validFracT0 < 0.3) throw new Error(`valid_frac=${det.validFracT0.toFixed(2)} abaixo de 0.3 (nuvem)`);
  const geometry = det.count > 0
    ? maskToMultiPolygon(det.mask, ref.width, ref.height, ref.originX, ref.originY, ref.res, utmDef, 50, 0.25)
    : null;
  const score = geometry ? det.uncalibrated : 0; // sem feicao >=50px: sem deteccao (Zod exige score<0.1 p/ null)
  return { geometry, score, validFrac: det.validFracT0 };
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
    cog_urls: { B04: string; B08: string; SCL: string; baselines: Array<{ scene: string; B04: string; B08: string; SCL: string }> };
  } }).data;
  const eventClass = lease.event_class ?? 'DEFORESTATION'; // protocolo 1.3: task diz a classe cacada
  const t0 = Date.now();
  try {
    const { geometry, score, validFrac } = await processReal(lease, eventClass);
    // renova o lease antes de reportar (processamento real pode levar minutos)
    await fetch(`${base}/v1/tasks/${lease.assignment_id}/heartbeat`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: '{}',
    }).catch(() => undefined);
    const execMs = Math.max(1000, Date.now() - t0);
    const report: Record<string, unknown> = {
      assignment_id: lease.assignment_id, task_id: lease.task_id, node_id: cfg.node_id, operator_id: key.operator_id,
      geometry, model_score: score, event_class: eventClass,
      radiometric_quality: { valid_frac: validFrac, cloud_frac: 1 - validFrac, baseline_scene: lease.baseline_scene, eps: 1e-6 },
      execution_time_ms: execMs, container_digest: containerDigest, algorithm_sha256: bundleHash,
    };
    report.signature_hex = signPayload(report, hexToBytes(key.private_key_hex));
    const accepted = await api(base, '/v1/results/report', { method: 'POST', headers: auth, body: JSON.stringify(report) });
    const d = (accepted!.data ?? {}) as { event_id?: string | null; decision?: string; quorum_state?: string };
    return { status: 'reported', taskId: lease.task_id, h3: lease.h3_index, score, eventId: d.event_id ?? null, decision: d.decision, quorum: d.quorum_state };
  } catch (e) {
    // falha honesta: marca FAILED (libera p/ outros, exclui este no) em vez de votar lixo.
    // Excecao: erro 5xx DO server (transitorio, ex: consenso) -> nao marca nada;
    // o lease expira sozinho e o voto pode ser refeito depois.
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
  }
}

function failReason(e: unknown): string {
  const m = String(e instanceof Error ? e.message : e);
  if (/too_big|vertices|GEOMETRY/i.test(m)) return 'VETOR_GRANDE';
  if (/MGRS|mgrs|UTM|proj/i.test(m)) return 'MGRS_UNKNOWN';
  if (/baseline/i.test(m)) return 'NO_BASELINE';
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
