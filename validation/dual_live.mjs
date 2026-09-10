/**
 * Voto live DUAL_EPOCH direcionado (protocolo v1.4, validacao R5-producao).
 * A fila do server entrega a task mais antiga (ORDER BY created_at); para
 * verificar o caminho DUAL sem drenar ~1500 tasks, o lease desta task é
 * criado manualmente (SQL, mesma semantica do LEASE_SQL) e este script roda
 * o pipeline REAL (processReal exportado) + report assinado via API.
 * Uso: node ./validation/dual_live.mjs ./validation/dual_lease.json [configDir]
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const leasePath = process.argv[2] ?? './validation/dual_lease.json';
const configDir = process.argv[3] ?? 'config';
const lease = JSON.parse(readFileSync(leasePath, 'utf8').replace(/^\uFEFF/, ''));

const { getSession, processReal } = await import('../dist/src/runner.js');
const { signPayload } = await import('@satsentinel/protocol');
const { computeContainerDigest } = await import('../dist/src/security/digest.js');
const { hexToBytes } = await import('@noble/hashes/utils');

const { key, cfg, base, auth } = await getSession(configDir);
if (lease.operator_pinned && lease.operator_pinned !== key.operator_id) {
  console.error(`lease pinado p/ ${lease.operator_pinned}, sessao é ${key.operator_id}`);
  process.exit(3);
}
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Digest IDENTICO ao pin (scripts/digest.mjs): join(root, 'dist') — formato do path importa.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const containerDigest = computeContainerDigest(join(root, 'dist'), pkg.version ?? '');
const bundleHash = createHash('sha256').update(readFileSync(new URL('../dist/src/runner.js', import.meta.url))).digest('hex');

const api = async (path, init) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

const t0 = Date.now();
// Heartbeat periódico (voto DUAL baixa 2 cenas e estoura os 10min do lease sem isso).
const hb = setInterval(() => {
  fetch(`${base}/v1/tasks/${lease.assignment_id}/heartbeat`,
    { method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: '{}' }).catch(() => undefined);
}, 120_000);
const failReason = (e) => {
  const m = String(e instanceof Error ? e.message : e);
  if (/EPOCH2|epoch2/i.test(m)) return 'NO_EPOCH2';
  if (/baseline/i.test(m)) return 'NO_BASELINE';
  if (/LOW_VALID|valid_frac|nuvem|cloud/i.test(m)) return 'LOW_VALID';
  return 'COG_FETCH';
};
try {
  const out = await processReal(lease, lease.event_class ?? 'DEFORESTATION');
  console.log(`dual: geom=${out.geometry ? 'SIM' : 'nulo'} score=${out.score.toFixed(3)} valid=${out.validFrac.toFixed(2)} persist=${JSON.stringify(out.persistence ?? null)}`);
  await fetch(`${base}/v1/tasks/${lease.assignment_id}/heartbeat`,
    { method: 'PUT', headers: { 'content-type': 'application/json', ...auth }, body: '{}' }).catch(() => undefined);
  const report = {
    assignment_id: lease.assignment_id, task_id: lease.task_id, node_id: cfg.node_id, operator_id: key.operator_id,
    geometry: out.geometry, model_score: out.score, event_class: lease.event_class ?? 'DEFORESTATION',
    ...(out.persistence ? { persistence: out.persistence } : {}),
    radiometric_quality: { valid_frac: out.validFrac, cloud_frac: 1 - out.validFrac, baseline_scene: lease.baseline_scene, eps: 1e-6 },
    execution_time_ms: Math.max(1000, Date.now() - t0), container_digest: containerDigest, algorithm_sha256: bundleHash,
  };
  report.signature_hex = signPayload(report, hexToBytes(key.private_key_hex));
  const accepted = await api('/v1/results/report', { method: 'POST', headers: auth, body: JSON.stringify(report) });
  clearInterval(hb);
  console.log('report aceito:', JSON.stringify(accepted.data));
} catch (e) {
  clearInterval(hb);
  const reason = failReason(e);
  console.error(`falha honesta ${reason}: ${String(e).slice(0, 160)}`);
  await fetch(`${base}/v1/tasks/${lease.assignment_id}/fail`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ reason }) }).catch(() => undefined);
  process.exit(2);
}
