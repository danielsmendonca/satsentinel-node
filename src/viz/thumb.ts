/**
 * Thumbnails NDVI p/ visual F1 (homelaber ve o que o voto viu).
 * Zero dependencia nova: encoder PNG minimo (zlib nativo) + colormap proprio.
 * Deterministico: mesmos bytes de entrada -> mesmos bytes de saida
 * (base p/ content-hash da F5 sem mudar nada aqui).
 */
import { deflateSync } from 'node:zlib';

/** Tamanho maximo do lado maior (px). Janela ~1000px -> ~60KB por PNG. */
export const THUMB_MAX_DIM = 256;
/** Maximo de tasks com thumbs no cache (LRU por mtime). */
export const THUMB_CACHE_KEEP = 200;

/** Divergente NDVI: corte/solo -> vermelho, transicao -> amarelo, mata -> verde. */
export function ndviThumbRgb(v: number): [number, number, number] {
  const x = Math.min(1, Math.max(-1, v));
  if (x <= 0) {
    // -1 (solo/nuvem?) marrom-avermelhado -> 0 amarelo-palha
    const t = x + 1;
    return [Math.round(165 + (210 - 165) * t), Math.round(60 + (180 - 60) * t), Math.round(40 + (60 - 60) * t)];
  }
  // 0 amarelo-palha -> 1 verde-mata
  return [Math.round(210 - (210 - 20) * x), Math.round(180 + (120 - 180) * x), Math.round(60 + (40 - 60) * x)];
}

/** Media em bloco p/ reduzir a grade (Float32). Retorna {data, w, h}. */
export function downsample(
  src: Float32Array, w: number, h: number, maxDim: number,
): { data: Float32Array; w: number; h: number } {
  const s = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  if (s === 1) return { data: src.slice(), w, h };
  const nw = Math.ceil(w / s), nh = Math.ceil(h / s);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sum = 0, n = 0;
      for (let dy = 0; dy < s && y * s + dy < h; dy++) {
        for (let dx = 0; dx < s && x * s + dx < w; dx++) {
          sum += src[(y * s + dy) * w + (x * s + dx)]; n++;
        }
      }
      out[y * nw + x] = sum / n;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Vizinho-proximo p/ mascaras (Uint8): pixel vira 1 se algum original for 1. */
export function downsampleMask(
  src: Uint8Array, w: number, h: number, maxDim: number,
): { data: Uint8Array; w: number; h: number } {
  const s = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  if (s === 1) return { data: src.slice(), w, h };
  const nw = Math.ceil(w / s), nh = Math.ceil(h / s);
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let hit = 0;
      for (let dy = 0; dy < s && !hit && y * s + dy < h; dy++) {
        for (let dx = 0; dx < s && x * s + dx < w; dx++) {
          if (src[(y * s + dy) * w + (x * s + dx)] === 1) { hit = 1; break; }
        }
      }
      out[y * nw + x] = hit;
    }
  }
  return { data: out, w: nw, h: nh };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** PNG truecolor 8-bit (sem alpha). rgba: R,G,B por pixel (alpha ignorado). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filtro None
    for (let x = 0; x < width; x++) {
      raw[y * (1 + width * 3) + 1 + x * 3] = rgb[(y * width + x) * 3];
      raw[y * (1 + width * 3) + 1 + x * 3 + 1] = rgb[(y * width + x) * 3 + 1];
      raw[y * (1 + width * 3) + 1 + x * 3 + 2] = rgb[(y * width + x) * 3 + 2];
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, truecolor
  const idat = deflateSync(raw);
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Renderiza NDVI + contorno da anomalia (vermelho vivo onde mask=1).
 * thumb = {png, w, h} pronto p/ disco.
 */
export function renderNdviThumb(
  field: Float32Array, width: number, height: number,
  mask: Uint8Array | null, maxDim = THUMB_MAX_DIM,
): { png: Uint8Array; w: number; h: number } {
  const ds = downsample(field, width, height, maxDim);
  const dm = mask ? downsampleMask(mask, width, height, maxDim) : null;
  if (dm && (dm.w !== ds.w || dm.h !== ds.h)) throw new Error('thumb: grade incompativel');
  const rgb = new Uint8Array(ds.w * ds.h * 3);
  for (let i = 0; i < ds.w * ds.h; i++) {
    if (dm && dm.data[i] === 1) {
      rgb[i * 3] = 255; rgb[i * 3 + 1] = 40; rgb[i * 3 + 2] = 60; // anomalia
    } else {
      const [r, g, b] = ndviThumbRgb(ds.data[i]);
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    }
  }
  return { png: encodePng(ds.w, ds.h, rgb), w: ds.w, h: ds.h };
}
