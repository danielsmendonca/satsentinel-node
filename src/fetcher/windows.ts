/**
 * Leitura de janelas COG via HTTP Range (geotiff.js) no grid UTM nativo da cena.
 * Estrategia: extent geografico (4326) -> metros UTM -> janela de pixels por imagem.
 * Cada banda/baseline resolve sua propria janela (grades 10m/20m alinhadas por coordenada).
 */
import { fromUrl, type GeoTIFFImage } from 'geotiff';
import proj4 from 'proj4';

export interface GridWindow {
  left: number; top: number; width: number; height: number; // pixels na imagem
  res: number; // m/px
  originX: number; originY: number; // canto superior-esquerdo em metros
}

export interface BandGrid {
  data: ArrayLike<number>; // Float32 (bandas) ou Uint8 (SCL)
  width: number; height: number; res: number;
  originX: number; originY: number;
}

export const MAX_WINDOW_PX = 2048 * 2048; // teto anti-estouro de RAM

/** Extent 4326 -> metros UTM (projecao de cada vertice). */
export function extentToUtm(bbox4326: [number, number, number, number], utmDef: string): [number, number, number, number] {
  const [w, s, e, n] = bbox4326;
  const fwd = (lon: number, lat: number) => proj4('EPSG:4326', utmDef, [lon, lat]) as [number, number];
  const pts = [fwd(w, s), fwd(e, s), fwd(e, n), fwd(w, n)];
  return [
    Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])),
    Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])),
  ];
}

/** Janela de pixels p/ um extent em metros, com halo em metros, clampada na imagem. Pura. */
export function computeWindow(
  originX: number, originY: number, res: number,
  imgMinX: number, imgMinY: number, imgMaxX: number, imgMaxY: number,
  extMinX: number, extMinY: number, extMaxX: number, extMaxY: number, haloM: number,
): GridWindow {
  const left = Math.max(0, Math.floor((extMinX - haloM - originX) / res));
  const top = Math.max(0, Math.floor((originY - (extMaxY + haloM)) / res));
  const right = Math.ceil((extMaxX + haloM - originX) / res);
  const bottom = Math.ceil((originY - (extMinY - haloM)) / res);
  const imgW = Math.round((imgMaxX - imgMinX) / res);
  const imgH = Math.round((imgMaxY - imgMinY) / res);
  const l = Math.min(left, imgW - 1), t = Math.min(top, imgH - 1);
  const r = Math.min(Math.max(right, l + 1), imgW), b = Math.min(Math.max(bottom, t + 1), imgH);
  const width = r - l, height = b - t;
  if (width * height > MAX_WINDOW_PX) throw new Error(`janela grande demais (${width}x${height})`);
  return { left: l, top: t, width, height, res, originX, originY };
}

/** Reamostra vizinho-mais-proximo de src para o grid dst (mesmo extent geografico). Puro. */
export function resampleNearest(src: BandGrid, dstW: number, dstH: number, dstOriginX: number, dstOriginY: number, dstRes: number): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  const s = src.data as ArrayLike<number>;
  for (let r = 0; r < dstH; r++) {
    const y = dstOriginY - (r + 0.5) * dstRes;
    const sr = Math.floor((src.originY - y) / src.res);
    for (let c = 0; c < dstW; c++) {
      const x = dstOriginX + (c + 0.5) * dstRes;
      const sc = Math.floor((x - src.originX) / src.res);
      const rr = Math.min(src.height - 1, Math.max(0, sr));
      const cc = Math.min(src.width - 1, Math.max(0, sc));
      out[r * dstW + c] = s[rr * src.width + cc];
    }
  }
  return out;
}

async function openImage(url: string): Promise<GeoTIFFImage> {
  const tiff = await fromUrl(url);
  return tiff.getImage();
}

/** Le uma banda recortada pelo extent 4326 (+halo). Retorna grid em float ou uint8. */
export async function readBandWindow(
  url: string, extent4326: [number, number, number, number], utmDef: string, haloM: number,
): Promise<BandGrid> {
  const img = await openImage(url);
  const [ox, oy] = img.getOrigin() as [number, number];
  const [resx, resy] = img.getResolution() as [number, number];
  const res = Math.abs(resx);
  const [ix0, iy0, ix1, iy1] = img.getBoundingBox() as [number, number, number, number];
  const [ex0, ey0, ex1, ey1] = extentToUtm(extent4326, utmDef);
  const win = computeWindow(ox, oy, res, ix0, iy0, ix1, iy1, ex0, ey0, ex1, ey1, haloM);
  const raster = (await img.readRasters({
    window: [win.left, win.top, win.left + win.width, win.top + win.height],
  })) as unknown as { width: number; height: number; [k: number]: ArrayLike<number> };
  const raw = raster[0];
  const isScl = /SCL/i.test(url);
  const data = isScl ? Uint8Array.from(raw as ArrayLike<number>) : Float32Array.from(raw as ArrayLike<number>);
  void resy;
  return { data, width: raster.width, height: raster.height, res, originX: ox + win.left * res, originY: oy - win.top * res };
}
