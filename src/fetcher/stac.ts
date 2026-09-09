/** STAC local da AOI privada (GDD Sec 15.3). Fila global NAO usa isto — usa /tasks/lease. */
export async function pollPrivateAoi(stacUrl: string, aoiPolygon: unknown, sinceIso: string) {
  const body = {
    collections: ['sentinel-2-l2a'],
    intersects: aoiPolygon,
    query: { 'eo:cloud_cover': { lt: 30 }, datetime: { gt: sinceIso } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: 10,
  };
  const r = await fetch(stacUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`STAC privado ${r.status}`);
  const j = await r.json() as { features: unknown[] };
  return j.features ?? [];
}
