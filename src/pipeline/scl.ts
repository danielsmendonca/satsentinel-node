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
