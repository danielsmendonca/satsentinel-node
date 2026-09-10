/**
 * @satsentinel/protocol v1.4.0
 * Contrato unico server <-> node (GDD v1.2 Sec 13/17/18 + R5 dual-epoch).
 * Fonte da verdade: satsentinel-node/protocol. Copia vendored em
 * satsentinel-server/src/vendor/protocol (sincronizar apos bump: rebuild + copiar).
 * Regra: server rejeita payload que falhe no Zod, digest fora da allowlist
 * ou assinatura invalida. Node rejeita task com dataset_version desconhecida.
 *
 * v1.4.0 (compatível com 1.3.0): tasks DUAL_EPOCH carregam `epoch2` (2a cena
 * limpa apos t0) em cog_urls; reports podem trazer `persistence` (evidencia
 * de que a anomalia persistiu no mesmo lugar). Tudo opcional: payloads 1.3.0
 * continuam válidos.
 */
import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Constantes congeladas (GDD v1.2 Sec 16/19)
// ---------------------------------------------------------------------------
export const PROTOCOL_VERSION = '1.4.0' as const;
export const ALGORITHM_VERSION = 'DETERMINISTIC_NDVI_v1.2.0' as const;
export const PROCESSING_PROFILES = [
  'MVP_AMAZON_R6_HALO128',
  'MVP_CERRADO_R6_HALO128',
] as const;
export type ProcessingProfile = (typeof PROCESSING_PROFILES)[number];

export const REDUNDANCY_REQUIRED = 3 as const;
export const QUORUM_TIMEOUT_HOURS = 24 as const;
export const LEASE_MINUTES = 10 as const;
export const HEARTBEAT_MINUTES = 2 as const;

/** Limites de seguranca do vetor (GDD Sec 14/18). Area final validada no PostGIS. */
export const LIMITS = {
  MAX_VERTICES: 500,
  MAX_POLYGONS: 50,
  MAX_AREA_KM2: 100,
  MIN_EXEC_MS: 1_000,
  MAX_EXEC_MS: 600_000,
  NONCE_TTL_SEC: 60,
  JWT_TTL_HOURS: 24,
} as const;

export const KNOWN_DATASET_PREFIX = 'S2L2A_E84v1_' as const;

export const ApiErrorCodes = [
  'OPERATOR_TAKEN',
  'UNKNOWN_OPERATOR',
  'BAD_SIGNATURE',
  'NONCE_EXPIRED',
  'VERSION_MISMATCH',
  'BAD_GEOMETRY',
  'DIGEST_NOT_ALLOWED',
  'LEASE_LOST',
  'NOT_OWNER',
  'TOO_MANY',
] as const;
export type ApiErrorCode = (typeof ApiErrorCodes)[number];

// ---------------------------------------------------------------------------
// Base58 (para operator_id = base58(pubkey)[0:12], sem dep extra)
// ---------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = '';
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  // preserva zeros lideres como '1'
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

export function operatorIdFromPublicKey(pubkey32: Uint8Array): string {
  if (pubkey32.length !== 32) throw new Error('pubkey deve ter 32 bytes');
  return base58Encode(pubkey32).slice(0, 12);
}

// ---------------------------------------------------------------------------
// JSON canonico + sha256 + Ed25519 (GDD Sec 12/18)
// ---------------------------------------------------------------------------
/** Stringify deterministico: chaves ordenadas, recursivo, sem espacos. */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(',')}}`;
}

export function sha256HexOfCanonical(payload: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalize(payload))));
}

/** Assina o payload (sem o campo de assinatura) com a operator private key (32B). */
export function signPayload(payloadWithoutSig: unknown, privkey32: Uint8Array): string {
  const digest = sha256(new TextEncoder().encode(canonicalize(payloadWithoutSig)));
  return bytesToHex(ed25519.sign(digest, privkey32));
}

export function verifyPayloadSignature(
  payloadWithoutSig: unknown,
  signatureHex: string,
  pubkey32: Uint8Array,
): boolean {
  try {
    const digest = sha256(new TextEncoder().encode(canonicalize(payloadWithoutSig)));
    return ed25519.verify(hexToBytes(signatureHex), digest, pubkey32);
  } catch {
    return false;
  }
}

export function generateOperatorKeypair(): { privateKeyHex: string; publicKeyHex: string; operatorId: string } {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return {
    privateKeyHex: bytesToHex(priv),
    publicKeyHex: bytesToHex(pub),
    operatorId: operatorIdFromPublicKey(pub),
  };
}

// ---------------------------------------------------------------------------
// Schemas Zod (todos .strict() — campo extra = reject)
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'hex64 invalido');
const sigHex128 = z.string().regex(/^[0-9a-fA-F]{128}$/, 'assinatura deve ser hex 128');
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'digest deve ser sha256:...');
const operatorIdSchema = z
  .string()
  .min(8)
  .max(16)
  .regex(/^[1-9A-HJ-NP-Za-km-z]{8,16}$/, 'operator_id base58 invalido');
const urlSchema = z.string().url().max(1024);

const positionSchema = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .rest(z.number()); // aceita [lon,lat] ou [lon,lat,alt]

const linearRingSchema = z.array(positionSchema).min(4).max(1000);

const polygonSchema = z.array(linearRingSchema).min(1).max(5);

export const multiPolygonSchema = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(polygonSchema).min(1).max(LIMITS.MAX_POLYGONS),
}).strict();

export type GeoMultiPolygon = z.infer<typeof multiPolygonSchema>;

/** Conta vertices para fast-fail (limite 500). */
export function countVertices(g: GeoMultiPolygon): number {
  let n = 0;
  for (const poly of g.coordinates) for (const ring of poly) n += ring.length;
  return n;
}

const baselineCogSchema = z
  .object({
    scene: z.string().min(10).max(150),
    B04: urlSchema,
    B08: urlSchema,
    SCL: urlSchema,
  })
  .strict();

export const epochCogSchema = baselineCogSchema;
export type EpochCog = z.infer<typeof epochCogSchema>;

export const cogUrlsSchema = z
  .object({
    B04: urlSchema,
    B08: urlSchema,
    SCL: urlSchema,
    baselines: z.array(baselineCogSchema).min(2).max(3),
    /** v1.4: 2a cena limpa apos t0 (mesmo tile). Ausente = task SINGLE (1.3). */
    epoch2: baselineCogSchema.optional(),
  })
  .strict();
export type CogUrls = z.infer<typeof cogUrlsSchema>;

/** v1.4: tasks DUAL_EPOCH exigem voto com evidencia de persistencia (R5). */
export const taskKindSchema = z.enum(['SINGLE', 'DUAL_EPOCH']);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const radiometricQSchema = z
  .object({
    valid_frac: z.number().min(0).max(1),
    cloud_frac: z.number().min(0).max(1),
    baseline_scene: z.string().min(10).max(150),
    eps: z.literal(1e-6),
  })
  .strict();
export type RadiometricQuality = z.infer<typeof radiometricQSchema>;

export const leaseReqSchema = z
  .object({
    node_id: uuid,
    operator_id: operatorIdSchema,
    hw_arch: z.enum(['amd64', 'arm64']),
    algorithm_version: z.literal(ALGORITHM_VERSION),
    processing_profile: z.enum(PROCESSING_PROFILES),
    container_digest: digestSchema,
  })
  .strict();
export type LeaseRequest = z.infer<typeof leaseReqSchema>;

export const eventClassSchema = z.enum(['DEFORESTATION', 'WATER_BODY_CHANGE']);
export type EventClass = z.infer<typeof eventClassSchema>;

export const leaseRespSchema = z
  .object({
    assignment_id: uuid,
    task_id: uuid,
    observation_id: z.string().min(10).max(100),
    baseline_scene: z.string().min(10).max(150),
    h3_index: z.string().min(5).max(15),
    mgrs_tile: z.string().min(5).max(10),
    dataset_version: z.string().startsWith(KNOWN_DATASET_PREFIX),
    event_class: eventClassSchema, // v1.3: classe cacada nesta task (pipeline usa a SCL correspondente)
    /** v1.4: ausente = SINGLE (compat 1.3). Server deriva de cog_urls.epoch2. */
    task_kind: taskKindSchema.optional(),
    cog_urls: cogUrlsSchema,
    lease_until: z.string().datetime(),
  })
  .strict();
export type LeaseResponse = z.infer<typeof leaseRespSchema>;

/**
 * v1.4: evidencia de persistencia multi-temporal (R5). O no roda a deteccao
 * em t0 e na epoch2 (mesma grade/baselines) e reporta: persisted=false
 * (transiente -> vota null) ou IoU espacial das mascaras.
 */
export const persistenceSchema = z
  .object({
    epoch2_scene: z.string().min(10).max(150),
    persist_count: z.number().int().min(0),
    persist_iou: z.number().min(0).max(1),
    persisted: z.boolean(),
  })
  .strict();
export type PersistenceEvidence = z.infer<typeof persistenceSchema>;

export const reportReqSchema = z
  .object({
    assignment_id: uuid,
    task_id: uuid,
    node_id: uuid,
    operator_id: operatorIdSchema,
    geometry: z.union([z.null(), multiPolygonSchema]),
    model_score: z.number().min(0).max(1),
    event_class: eventClassSchema, // v1.3: deve igualar a event_class do lease
    /** v1.4 opcional: evidencia de persistencia (exigida em tasks DUAL_EPOCH). */
    persistence: persistenceSchema.optional(),
    radiometric_quality: radiometricQSchema,
    execution_time_ms: z.number().int().min(LIMITS.MIN_EXEC_MS).max(LIMITS.MAX_EXEC_MS),
    container_digest: digestSchema,
    algorithm_sha256: hex64,
    signature_hex: sigHex128,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.geometry === null && v.model_score >= 0.1) {
      ctx.addIssue({ code: 'custom', message: 'sem geometria o score deve ser < 0.1' });
    }
    if (v.geometry !== null) {
      if (v.model_score < 0.1) {
        ctx.addIssue({ code: 'custom', message: 'geometria sem score >= 0.1' });
      }
      const n = countVertices(v.geometry);
      if (n > LIMITS.MAX_VERTICES) {
        ctx.addIssue({ code: 'custom', message: `vertices ${n} > ${LIMITS.MAX_VERTICES}` });
      }
      // aneis devem fechar (primeira == ultima posicao)
      for (const poly of v.geometry.coordinates) {
        for (const ring of poly) {
          const a = ring[0];
          const b = ring[ring.length - 1];
          if (a[0] !== b[0] || a[1] !== b[1]) {
            ctx.addIssue({ code: 'custom', message: 'anel GeoJSON nao fechado' });
            return;
          }
        }
      }
    }
  });
export type ResultReport = z.infer<typeof reportReqSchema>;

/** Extrai o payload assinavel (tudo menos signature_hex). */
export function reportSignable(r: Omit<ResultReport, 'signature_hex'> | ResultReport) {
  const { signature_hex: _drop, ...rest } = r as ResultReport & { signature_hex?: string };
  return rest;
}

export function signReport(report: Omit<ResultReport, 'signature_hex'>, privkeyHex: string): string {
  return signPayload(reportSignable(report), hexToBytes(privkeyHex));
}

export function verifyReport(report: ResultReport, pubkeyHex: string): boolean {
  return verifyPayloadSignature(reportSignable(report), report.signature_hex, hexToBytes(pubkeyHex));
}

export const consensusMetadataSchema = z
  .object({
    n_operators: z.number().int().min(3).max(4),
    iou_matrix: z.array(z.array(z.number().min(0).max(1))).min(3).max(4),
    weights: z.array(z.number().min(0).max(1)).min(3).max(4),
    S_calibrated: z.number().min(0).max(1),
    IoU_medio: z.number().min(0).max(1),
    Q_rad: z.number().min(0).max(1),
    algorithm_version: z.literal(ALGORITHM_VERSION),
  })
  .strict();
export type ConsensusMetadata = z.infer<typeof consensusMetadataSchema>;

// Auth (GDD Sec 12/17)
export const operatorRegisterReqSchema = z
  .object({
    operator_id: operatorIdSchema,
    public_key_hex: z.string().regex(/^[0-9a-fA-F]{64}$/, 'pubkey 32B hex'),
    display_name: z.string().min(1).max(40).optional(),
    node_id: uuid,
    hw_arch: z.enum(['amd64', 'arm64']),
  })
  .strict();

export const authVerifyReqSchema = z
  .object({
    operator_id: operatorIdSchema,
    node_id: uuid,
    nonce_hex: z.string().min(16).max(128),
    signature_hex: sigHex128,
    hw_arch: z.enum(['amd64', 'arm64']),
  })
  .strict();

export function isKnownDatasetVersion(v: string): boolean {
  return v.startsWith(KNOWN_DATASET_PREFIX);
}
