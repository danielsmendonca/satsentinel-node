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

export function ndvi(red: Float32Array, nir: Float32Array): Float32Array {
  const out = new Float32Array(red.length);
  for (let i = 0; i < red.length; i++) {
    const v = (nir[i] - red[i]) / (nir[i] + red[i] + EPS);
    out[i] = Math.max(-1, Math.min(1, v));
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
  opts: { dndviThreshold?: number; minPx?: number; requireForest?: boolean; forest?: Uint8Array } = {},
): WindowResult {
  const thr = opts.dndviThreshold ?? DNDVI_THRESHOLD;
  const minPx = opts.minPx ?? MIN_COMPONENT_PX;
  // Gate floresta: so vota onde ERA floresta (mascara das baselines). Sem
  // mascara fornecida, nao filtra (compat: testes e caminhos sem SCL historico).
  const gate = opts.requireForest === true && opts.forest && opts.forest.length === red.length;
  const n = red.length;
  const vf = validFrac(scl, cls);
  const cur = ndvi(red, nir);
  const med = baselineNdvis.length >= 3
    ? median3(baselineNdvis[0], baselineNdvis[1], baselineNdvis[2])
    : baselineNdvis.length === 2
      ? median3(baselineNdvis[0], baselineNdvis[1], baselineNdvis[1])
      : cur;
  const mask = new Uint8Array(n);
  let sum = 0; let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (!isValidScl(scl[i], cls)) continue;
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
