/**
 * Pipeline deterministico puro (GDD Sec 7): NDVI, dNDVI, regra v1.2.0.
 * Sem sharp, Float32Array streaming por janela. Testavel sem rede.
 */
import { isValidScl, validFrac, type EventClass } from './scl.js';

export const EPS = 1e-6;
export const DNDVI_THRESHOLD = -0.15;
export const MIN_COMPONENT_PX = 50;
/** Fracao minima de ceu limpo p/ votar (tuning DETER: 0.6 mantem TPs, mata 30% dos FPs de borda de nuvem). */
export const MIN_VALID_FRAC = 0.6;
/**
 * IoU minimo entre mascaras t0 x epoch2 p/ voto DUAL_EPOCH (R5: 0.05 mantem
 * 2/2 TPs e mata 6/7 FPs; limiar conservador, n=9 — nao travar acima disso).
 */
export const PERSIST_IOU_MIN = 0.05;

/** IoU entre duas mascaras binarias (mesma grade). 0 se uniao vazia. */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, union = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] === 1, y = b[i] === 1;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union === 0 ? 0 : inter / union;
}

export function ndvi(red: Float32Array, nir: Float32Array): Float32Array {
  const out = new Float32Array(red.length);
  for (let i = 0; i < red.length; i++) {
    const v = (nir[i] - red[i]) / (nir[i] + red[i] + EPS);
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

/** Erosao morfologica 1px (8-conectividade) da mascara valida: descarta pixels
 *  de borda de nuvem/haze que o SCL rotula como vegetacao mas estao
 *  contaminados (causa raiz dos FPs em mata estavel, tuning DETER R4).
 *  Bordas da janela viram invalidas (conservador). Requer width real. */
export function erodeValidMask(valid: Uint8Array, width: number): Uint8Array {
  const h = Math.floor(valid.length / width);
  const out = new Uint8Array(valid.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!valid[i + dy * width + dx]) { ok = 0; break; }
        }
      }
      out[i] = ok;
    }
  }
  return out;
}
export function median3(a: Float32Array, b: Float32Array, c: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i], z = c[i];
    out[i] = x < y ? (y < z ? y : x < z ? z : x) : (x < z ? x : y < z ? z : y);
  }
  return out;
}

export interface WindowResult {
  mask: Uint8Array; // 1 = anomalia
  validFracT0: number;
  meanDndvi: number;
  uncalibrated: number;
  count: number;
}

/** Uma janela W×H. baselines: 2-3 NDVIs historicos ja calculados. opts permite sweep de tuning (Fase 0). */
export function detectWindow(
  red: Float32Array, nir: Float32Array, scl: Uint8Array,
  baselineNdvis: Float32Array[], cls: EventClass = 'DEFORESTATION',
  opts: { dndviThreshold?: number; minPx?: number; requireForest?: boolean; forest?: Uint8Array; erodeValid?: boolean; width?: number } = {},
): WindowResult {
  const thr = opts.dndviThreshold ?? DNDVI_THRESHOLD;
  const minPx = opts.minPx ?? MIN_COMPONENT_PX;
  // Gate floresta: so vota onde ERA floresta (mascara das baselines). Sem
  // mascara fornecida, nao filtra (compat: testes e caminhos sem SCL historico).
  const gate = opts.requireForest === true && opts.forest && opts.forest.length === red.length;
  const n = red.length;
  // Erosao opt-in (validacao R4; producao apos prova): constroi mascara valida,
  // erode 1px e usa a erodida tanto no loop quanto na fracao reportada.
  const erode = opts.erodeValid === true && (opts.width ?? 0) > 2;
  let valid: Uint8Array | undefined;
  let vf: number;
  if (erode) {
    valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) valid[i] = isValidScl(scl[i], cls) ? 1 : 0;
    valid = erodeValidMask(valid, opts.width as number);
    let c = 0;
    for (let i = 0; i < n; i++) c += valid[i];
    vf = c / n;
  } else {
    vf = validFrac(scl, cls);
  }
  const cur = ndvi(red, nir);
  const med = baselineNdvis.length >= 3
    ? median3(baselineNdvis[0], baselineNdvis[1], baselineNdvis[2])
    : baselineNdvis.length === 2
      ? median3(baselineNdvis[0], baselineNdvis[1], baselineNdvis[1])
      : cur;
  const mask = new Uint8Array(n);
  let sum = 0; let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (valid ? !valid[i] : !isValidScl(scl[i], cls)) continue;
    if (gate && !(opts.forest as Uint8Array)[i]) continue;
    const d = cur[i] - med[i];
    if (d < thr) { mask[i] = 1; sum += d; cnt++; }
  }
  // limpeza: remove componente < minPx via contagem global simples (MVP: threshold de area).
  // Componentes conexos reais (BFS) ficam para otimizacao Fase 1+; aqui area total filtra sal-e-pimenta pequeno.
  const count = cnt >= minPx ? cnt : 0;
  if (count === 0) mask.fill(0);
  const meanDndvi = count === 0 ? 0 : sum / cnt;
  const uncalibrated = count === 0 ? 0 : Math.min(1, Math.max(0, Math.abs(meanDndvi) * 2.0)) * (0.7 + 0.3 * vf);
  return { mask, validFracT0: vf, meanDndvi, uncalibrated, count };
}
