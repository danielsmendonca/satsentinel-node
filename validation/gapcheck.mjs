import { readFileSync } from 'node:fs';
const f = process.argv[2];
const rows = readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
let mx = 0;
for (const r of rows) {
  if (!r.scene) continue;
  const m = r.scene.match(/_(20\d\d)(\d\d)(\d\d)_/);
  if (!m) continue;
  const gap = Math.round((new Date(`${m[1]}-${m[2]}-${m[3]}`) - new Date(r.date)) / 864e5);
  if (gap > mx) mx = gap;
  if (r.outcome === 'tp') console.log('TP gap:', gap + 'd', r.biome, r.date, 'iou=' + r.iou);
}
console.log('max gap dias:', mx);
