import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLocalUi, resolveThumbFile } from '../dist/src/ui/server.js';
import { renderNdviThumb } from '../dist/src/viz/thumb.js';

const H3 = '862a1072fffffff';
const TASK = '123e4567-e89b-12d3-a456-426614174000';

test('resolveThumbFile: valido dentro da raiz; resto rejeita', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumb-'));
  const ok = resolveThumbFile(dir, H3, TASK, 't0');
  assert.ok(ok && ok.endsWith('.png') && ok.startsWith(dir));
  assert.equal(resolveThumbFile(dir, H3, TASK, 'jpg'), null);
  assert.equal(resolveThumbFile(dir, 'zzz', TASK, 't0'), null);
  assert.equal(resolveThumbFile(dir, H3, '../x', 't0'), null);
  assert.equal(resolveThumbFile(dir, H3, TASK, 't0').includes('..'), false);
});

test('UI: /api/run/state expoe progresso (feitos/total/ritmo)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uirun-'));
  const app = await buildLocalUi(dir);
  try {
    const r = await app.inject('/api/run/state');
    assert.equal(r.statusCode, 200);
    const pg = r.json().progress;
    for (const k of ['ensuresTotal', 'ensuresDone', 'votesDone', 'failsDone', 'elapsedMs', 'avgEnsureMs']) {
      assert.equal(typeof pg[k], 'number', k);
    }
  } finally {
    await app.close();
  }
});

test('UI: config grava atomico e leitura usa cache invalidado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uicfg-'));
  const app = await buildLocalUi(dir);
  try {
    const w = await app.inject({ method: 'POST', url: '/api/config', payload: { node_alias: 'quorum-teste' } });
    assert.equal(w.statusCode, 200);
    const r = await app.inject('/api/config');
    assert.equal(r.json().data.node_alias, 'quorum-teste');
    // sem .tmp sobrando (rename atomico concluiu)
    const { readdirSync: _ls } = await import('node:fs');
    assert.ok(!_ls(dir).some((f) => f.endsWith('.tmp')));
  } finally {
    await app.close();
  }
});

test('UI: /api/thumbs valida h; /api/thumb 400/404; PNG 200', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-'));
  const app = await buildLocalUi(dir);
  try {
    const bad = await app.inject('/api/thumbs?h=zzz');
    assert.equal(bad.statusCode, 400);
    const empty = await app.inject(`/api/thumbs?h=${H3}`);
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().data, []);
    const miss = await app.inject(`/api/thumb?h=${H3}&task=${TASK}&kind=t0`);
    assert.equal(miss.statusCode, 404);
    const badKind = await app.inject(`/api/thumb?h=${H3}&task=${TASK}&kind=jpg`);
    assert.equal(badKind.statusCode, 400);
    // thumb real via encoder: lista + bytes
    mkdirSync(join(dir, 'thumbs'), { recursive: true });
    const { png } = renderNdviThumb(new Float32Array(8 * 8).fill(0.6), 8, 8, null, 8);
    writeFileSync(join(dir, 'thumbs', `${H3}_${TASK}_t0.png`), png);
    writeFileSync(join(dir, 'thumbs', `${H3}_${TASK}_base.png`), png);
    writeFileSync(join(dir, 'thumbs', `${H3}_${TASK}_meta.json`), JSON.stringify({ sw: [-8.1, -54.9], ne: [-7.9, -54.8] }));
    const list = await app.inject(`/api/thumbs?h=${H3}`);
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.length, 1);
    assert.ok(list.json().data[0].t0.endsWith('kind=t0'));
    assert.deepEqual(list.json().data[0].bounds, { sw: [-8.1, -54.9], ne: [-7.9, -54.8] });    const img = await app.inject(`/api/thumb?h=${H3}&task=${TASK}&kind=t0`);
    assert.equal(img.statusCode, 200);
    assert.match(img.headers['content-type'], /image\/png/);
    assert.ok((img.body ?? '').length > 50);
  } finally {
    await app.close();
  }
});

test('UI: /api/thumbs/all lista votadas com h3+bounds (p/ overlay)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uiall-'));
  const app = await buildLocalUi(dir);
  try {
    const e0 = await app.inject('/api/thumbs/all');
    assert.equal(e0.statusCode, 200);
    assert.deepEqual(e0.json().data, []);
    mkdirSync(join(dir, 'thumbs'), { recursive: true });
    const { png } = renderNdviThumb(new Float32Array(8 * 8).fill(0.6), 8, 8, null, 8);
    writeFileSync(join(dir, 'thumbs', `${H3}_${TASK}_t0.png`), png);
    writeFileSync(join(dir, 'thumbs', `${H3}_${TASK}_base.png`), png);
    const l = await app.inject('/api/thumbs/all');
    assert.equal(l.json().data.length, 1);
    assert.equal(l.json().data[0].h3, H3);
    assert.ok(l.json().data[0].t0.includes('/api/thumb?'));
  } finally {
    await app.close();
  }
});
