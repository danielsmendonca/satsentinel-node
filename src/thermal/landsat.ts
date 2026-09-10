/**
 * Temperatura de superficie via Landsat 8/9 Collection 2 Level-2 (banda ST, Kelvin x0.01).
 * Puro e testavel (sem rede): mascara QA + conversao + mediana por celula.
 */
export const ST_SCALE = 0.01;
export const ST_FILL = 0;

// QA_PIXEL (C2): bit0 fill, bit1 dilated cloud, bit2 cirrus, bit3 cloud,
// bit4 cloud shadow, bit5 snow. LST so presta com ceu realmente limpo.
const QA_BAD = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5);
export function qaClear(qa: number): boolean {
  return (qa & QA_BAD) === 0;
}

export function stToCelsius(raw: number): number | null {
  if (raw === ST_FILL) return null;
  const c = raw * ST_SCALE - 273.15;
  if (c < -80 || c > 80) return null; // disparate: artefato
  return c;
}

export interface CellTemp { medianC: number | null; clearFrac: number; n: number; clear: number; }

/** Mediana da temperatura nos pixels limpos da janela. */
export function cellTemperature(st: ArrayLike<number>, qa: ArrayLike<number>): CellTemp {
  const n = Math.min(st.length, qa.length);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!qaClear(qa[i])) continue;
    const c = stToCelsius(st[i]);
    if (c !== null) vals.push(c);
  }
  if (vals.length === 0) return { medianC: null, clearFrac: 0, n, clear: 0 };
  vals.sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const medianC = vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return { medianC, clearFrac: vals.length / n, n, clear: vals.length };
}

/** Zona UTM pelo centroide (Landsat nao tem tile MGRS no id). */
export function landsatUtmDef(lon: number, lat: number): string {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const south = lat < 0;
  return `+proj=utm +zone=${zone} ${south ? '+south' : ''} +datum=WGS84 +units=m +no_defs`;
}

/** Mediana simples (p/ NDVI da celula e afins). */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Cor p/ vigor NDVI 0..1 (solo -> verde). */
export function ndviColor(v: number): string {
  const x = Math.min(1, Math.max(0, v));
  const r = Math.round(120 + (34 - 120) * x);
  const g = Math.round(100 + (197 - 100) * x);
  const b = Math.round(60 + (94 - 60) * x);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
export function tempColor(celsius: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [10, [59, 130, 246]], [20, [34, 197, 94]], [28, [250, 204, 21]], [35, [249, 115, 22]], [45, [239, 68, 68]],
  ];
  if (celsius <= stops[0][0]) return '#3b82f6';
  for (let i = 1; i < stops.length; i++) {
    if (celsius <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (celsius - t0) / (t1 - t0);
      const mix = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
      return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return '#ef4444';
}
