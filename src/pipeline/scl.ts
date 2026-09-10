/** Matriz SCL por classe (GDD Sec 7). Retorna true se pixel e valido. */
export type EventClass = 'DEFORESTATION' | 'WATER_BODY_CHANGE';

const MASK_ALL = new Set([0, 1, 2, 3, 7, 8, 9, 10, 11]);
export function isValidScl(scl: number, cls: EventClass): boolean {
  if (MASK_ALL.has(scl)) return false;
  if (cls === 'DEFORESTATION') return scl === 4 || scl === 5; // agua fora (vira WATER)
  return scl === 4 || scl === 5 || scl === 6; // agua valida p/ corpo hidrico
}

export function validFrac(scl: Uint8Array, cls: EventClass): number {
  let n = 0;
  for (const v of scl) if (isValidScl(v, cls)) n++;
  return scl.length === 0 ? 0 : n / scl.length;
}

/**
 * Mascara "era floresta": pixel vale 1 se SCL==Vegetation(4) em pelo menos
 * `minVotes` das baselines. Gate anti-pasto/sazonalidade: desmate de verdade
 * parte de floresta; queda de NDVI em pasto seco nao deve votar.
 * Arrays devem estar no mesmo grid (reamostrar antes).
 */
export function forestMask(baselineScls: Uint8Array[], minVotes = 2): Uint8Array {
  if (baselineScls.length === 0) return new Uint8Array(0);
  const n = baselineScls[0].length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const s of baselineScls) if (s[i] === 4) v++;
    out[i] = v >= Math.min(minVotes, baselineScls.length) ? 1 : 0;
  }
  return out;
}
