import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leaseReqSchema, leaseRespSchema, reportReqSchema, cogUrlsSchema,
  generateOperatorKeypair, signReport, verifyReport,
  operatorIdFromPublicKey, canonicalize,
  ALGORITHM_VERSION,
} from '../dist/index.js';
import { hexToBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

const COG = {
  B04: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/22/M/GB/2026/4/S2A_T22MGB_20260401T133231_L2A/B04.tif',
  B08: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/22/M/GB/2026/4/S2A_T22MGB_20260401T133231_L2A/B08.tif',
  SCL: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/22/M/GB/2026/4/S2A_T22MGB_20260401T133231_L2A/SCL.tif',
  baselines: [
    { scene: 'S2A_T22MGB_20260320T133231_L2A', B04: 'https://example.com/a/B04.tif', B08: 'https://example.com/a/B08.tif', SCL: 'https://example.com/a/SCL.tif' },
    { scene: 'S2B_T22MGB_20260325T133231_L2A', B04: 'https://example.com/b/B04.tif', B08: 'https://example.com/b/B08.tif', SCL: 'https://example.com/b/SCL.tif' },
  ],
};

test('cog urls validas passam', () => {
  assert.equal(cogUrlsSchema.safeParse(COG).success, true);
});

test('lease request valido passa; campo extra rejeita (strict)', () => {
  const { operatorId } = generateOperatorKeypair();
  const ok = leaseReqSchema.safeParse({
    node_id: '123e4567-e89b-12d3-a456-426614174000',
    operator_id: operatorId,
    hw_arch: 'arm64',
    algorithm_version: ALGORITHM_VERSION,
    processing_profile: 'MVP_AMAZON_R6_HALO128',
    container_digest: 'sha256:' + 'a'.repeat(64),
  });
  assert.equal(ok.success, true);
  const bad = leaseReqSchema.safeParse({
    node_id: '123e4567-e89b-12d3-a456-426614174000',
    operator_id: operatorId,
    hw_arch: 'arm64',
    algorithm_version: ALGORITHM_VERSION,
    processing_profile: 'MVP_AMAZON_R6_HALO128',
    container_digest: 'sha256:' + 'a'.repeat(64),
    injected: 'x',
  });
  assert.equal(bad.success, false);
});

test('report assinado verifica; adulterado falha', () => {
  const kp = generateOperatorKeypair();
  const base = {
    assignment_id: '123e4567-e89b-12d3-a456-426614174000',
    task_id: '123e4567-e89b-12d3-a456-426614174001',
    node_id: '123e4567-e89b-12d3-a456-426614174002',
    operator_id: kp.operatorId,
    geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]] },
    model_score: 0.8,
    event_class: 'DEFORESTATION',
    radiometric_quality: { valid_frac: 0.9, cloud_frac: 0.05, baseline_scene: 'S2A_T22MGB_20260320T133231_L2A', eps: 1e-6 },
    execution_time_ms: 45000,
    container_digest: 'sha256:' + 'b'.repeat(64),
    algorithm_sha256: 'c'.repeat(64),
  };
  const sig = signReport(base, kp.privateKeyHex);
  const full = { ...base, signature_hex: sig };
  assert.equal(reportReqSchema.safeParse(full).success, true);
  assert.equal(verifyReport(full, kp.publicKeyHex), true);
  const tampered = { ...full, model_score: 0.99 };
  assert.equal(verifyReport(tampered, kp.publicKeyHex), false);
});

test('lease response exige event_class (protocolo 1.3)', () => {
  const base = {
    assignment_id: '123e4567-e89b-12d3-a456-426614174000',
    task_id: '123e4567-e89b-12d3-a456-426614174001',
    observation_id: 'S2A_T22MGB_20260401T133231_L2A',
    baseline_scene: 'S2A_T22MGB_20260320T133231_L2A',
    h3_index: '862a1072fffffff',
    mgrs_tile: '22MGB',
    dataset_version: 'S2L2A_E84v1_BASELINE05_2026-04',
    event_class: 'WATER_BODY_CHANGE',
    cog_urls: COG,
    lease_until: new Date().toISOString(),
  };
  assert.equal(leaseRespSchema.safeParse(base).success, true);
  const { event_class: _drop, ...semClasse } = base;
  assert.equal(leaseRespSchema.safeParse(semClasse).success, false);
  void _drop;
});

test('operator_id deriva da pubkey e canonico e deterministico', () => {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  assert.equal(operatorIdFromPublicKey(pub), operatorIdFromPublicKey(pub));
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(bytesToHex(pub).length, 64);
  void hexToBytes;
});
