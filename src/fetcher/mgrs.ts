/** MGRS -> UTM (para janelar COGs Sentinel-2, que vivem em UTM nativo). Puro e testavel. */
export interface UtmZone { zone: number; south: boolean; epsg: number; def: string; }

/** Extrai tile MGRS do item STAC ou do observation_id (S2B_23KPR_20260904_0_L2A). */
export function parseMgrsTile(observationId: string, props: Record<string, unknown> = {}): string {
  const direct = (props['s2:mgrs_tile'] ?? props['mgrs'] ?? props['grid:code']) as string | undefined;
  if (typeof direct === 'string') {
    const m = direct.match(/(\d{1,2}[C-X][A-Z]{2})/);
    if (m) return m[1];
  }
  const fromId = observationId.match(/_(\d{2}[A-Z]{3})_/);
  if (fromId) return fromId[1];
  return 'UNKNOWN';
}

/** "23KPR" -> {zone:23, south:true, epsg:32723}. Banda C-M = sul, N-X = norte. */
export function utmFromMgrs(mgrsTile: string): UtmZone {
  const m = mgrsTile.match(/^(\d{1,2})([C-X])/);
  if (!m) throw new Error(`MGRS invalido: ${mgrsTile}`);
  const zone = Number(m[1]);
  const south = m[2] < 'N';
  if (zone < 1 || zone > 60) throw new Error(`zona UTM invalida: ${mgrsTile}`);
  return {
    zone, south,
    epsg: (south ? 32700 : 32600) + zone,
    def: `+proj=utm +zone=${zone} ${south ? '+south' : ''} +datum=WGS84 +units=m +no_defs`,
  };
}
