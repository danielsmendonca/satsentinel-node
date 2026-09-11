/** Central de comando local :3000 — HUD, adotar, quadrantes, tarefas realtime + auto-run. */
import Fastify from 'fastify';
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { loadOrCreate, exportPairing, importPairing, configPath } from '../identity/operator.js';
import { runOnceDetailed, getSession, type RunDetail } from '../runner.js';

interface RunItem {
  h3?: string; phase: string; ms?: number; taskId?: string; observation?: string; score?: number;
  created?: boolean; result?: string; eventId?: string | null; decision?: string; error?: string;
  kind?: 'ensure' | 'vote';
}
interface RunState {
  running: boolean; startedAt: string | null; finishedAt: string | null;
  current: string | null; items: RunItem[]; summary: string | null;
  totalCells?: number;
}
const idleState = (): RunState => ({ running: false, startedAt: null, finishedAt: null, current: null, items: [], summary: null });
let runState: RunState = idleState();
let lastRun: { at: string; summary: string } | null = null;
let autoTimer: NodeJS.Timeout | null = null;
let autoNextAt: string | null = null;

// Config em memoria (evita I/O por request) + escrita atomica (tmp+rename:
// crash no meio da escrita nunca corrompe node.config.json).
let cfgCache: { dir: string; data: Record<string, unknown> } | null = null;
export function dropCfgCache(dir?: string): void {
  if (!dir || cfgCache?.dir === dir) cfgCache = null;
}
function readCfg(dir: string) {
  if (cfgCache?.dir === dir) return cfgCache.data as Record<string, unknown>;
  const data = JSON.parse(readFileSync(configPath(dir), 'utf8')) as Record<string, unknown>;
  cfgCache = { dir, data };
  return data;
}
function writeCfg(dir: string, patch: Record<string, unknown>) {
  const cp = configPath(dir);
  const full = { ...(cfgCache?.dir === dir ? cfgCache.data : JSON.parse(readFileSync(cp, 'utf8'))), ...patch };
  const tmp = `${cp}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2));
  renameSync(tmp, cp);
  cfgCache = { dir, data: full as Record<string, unknown> };
}

function isValidPolygon(p: unknown): boolean {
  if (typeof p !== 'object' || p === null) return false;
  const g = p as { type?: string; coordinates?: unknown };
  if (g.type !== 'Polygon' || !Array.isArray(g.coordinates) || g.coordinates.length === 0) return false;
  const ring = g.coordinates[0] as unknown;
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 1000) return false;
  for (const pt of ring) {
    if (!Array.isArray(pt) || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') return false;
    if (pt[0] < -180 || pt[0] > 180 || pt[1] < -90 || pt[1] > 90) return false;
  }
  const f = (ring as number[][])[0]; const l = (ring as number[][])[ring.length - 1];
  return f[0] === l[0] && f[1] === l[1];
}

function isValidH3Cells(c: unknown): c is string[] {
  return Array.isArray(c) && c.length <= 500 &&
    c.every((x) => typeof x === 'string' && /^[0-9a-f]{15}$/.test(x));
}

function isValidH3Centers(c: unknown): c is Record<string, [number, number]> {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return false;
  const entries = Object.entries(c);
  if (entries.length > 500) return false;
  return entries.every(([k, v]) =>
    /^[0-9a-f]{15}$/.test(k) && Array.isArray(v) && v.length === 2 &&
    typeof v[0] === 'number' && typeof v[1] === 'number' &&
    Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180);
}

async function serverOnline(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

async function serverStats(url: string, operatorId?: string): Promise<Record<string, number> | null> {
  try {
    const q = operatorId ? `?operator_id=${encodeURIComponent(operatorId)}` : '';
    const r = await fetch(`${url.replace(/\/$/, '')}/v1/stats${q}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return ((await r.json()) as { data: Record<string, number> }).data;
  } catch { return null; }
}

// Anel de eventos locais p/ aba Logs (boot, saves, runs, erros). Sem arquivo.
export interface LocalLog { t: string; level: 'info' | 'ok' | 'warn' | 'err'; msg: string; }
const localRing: LocalLog[] = [];
export function logEvent(level: LocalLog['level'], msg: string): void {
  localRing.push({ t: new Date().toISOString(), level, msg: msg.slice(0, 300) });
  if (localRing.length > 200) localRing.splice(0, localRing.length - 200);
}

// Pool com concorrencia limitada (puro e testavel). Preserva a ordem de conclusao? Nao:
// resultados entram na ordem em que terminam. Para a lista de tarefas, ordem de
// conclusao e o comportamento certo (tempo real).
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(n, items.length))).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function doRun(configDir: string): Promise<void> {
  const full = readCfg(configDir);
  const adopted = (full.h3_cells ?? []) as string[];
  runState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, current: null, items: [], summary: null };
  logEvent('info', `run iniciada (${adopted.length} adotadas)`);
  const t0 = Date.now();
  try {
    if (adopted.length === 0) {
      runState.summary = 'Nenhum quadrante adotado.';
      return;
    }
    const { base, auth } = await getSession(configDir);
    // Fila completa: garante task para TODAS as adotadas (x4 paralelo).
    // Redundante é barato (ON CONFLICT DO NOTHING) e o ociosidade do homelab absorve.
    const lote = adopted.slice(0, 500);
    runState.totalCells = lote.length;
    runState.current = `garantindo tasks (${lote.length} quadrantes, x4 paralelo)…`;
    await mapLimit(lote, 4, async (h) => {
      runState.current = `garantindo tasks (${runState.items.length}/${lote.length})…`;
      const item: RunItem = { h3: h, phase: 'ensure', kind: 'ensure' };
      runState.items.push(item);
      const t1 = Date.now();
      try {
        const r = await fetch(`${base}/v1/tasks/ensure`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ h3_index: h, event_class: 'DEFORESTATION' }),
        });
        if (r.ok) {
          const j = (await r.json()) as { data: { created: boolean; observationId?: string } };
          item.created = j.data.created;
          item.observation = j.data.observationId;
          item.phase = j.data.created ? 'task nova' : 'task existente';
        } else {
          item.phase = 'erro'; item.error = `${r.status} ${(await r.text()).slice(0, 160)}`;
        }
      } catch (e) {
        item.phase = 'erro'; item.error = String(e).slice(0, 160);
      }
      item.ms = Date.now() - t1;
    });
    // Votos em paralelo x3: lease atomico (SKIP LOCKED) garante sem duplicar.
    // idle = fila realmente esvaziada (so encolhe nesta fase) -> todos param.
    let remaining = adopted.length * 2 + 10;
    await mapLimit(new Array(3).fill(0), 3, async () => {
      for (;;) {
        if (remaining-- <= 0) break;
        runState.current = `votando (x3 paralelo)…`;
        const t1 = Date.now();
        let d: RunDetail;
        try {
          d = await runOnceDetailed(configDir);
        } catch (e) {
          // 429 = rajada no rate-limit (fila com fails rapidos): recua sem matar a run.
          if (/lease 429/.test(String(e))) {
            await new Promise((r) => setTimeout(r, 65_000));
            break;
          }
          throw e;
        }
        runState.items.push({
          kind: 'vote',
          phase: d.status === 'idle' ? 'fila vazia' : d.status === 'failed' ? 'pulada' : 'voto',
          ms: Date.now() - t1, taskId: d.taskId, h3: d.h3, score: d.score, result: d.status,
          eventId: d.eventId, decision: d.decision, error: (d as { error?: string }).error,
        });
        if (d.status === 'idle') break;
        await new Promise((r) => setTimeout(r, 3000)); // respira entre leases (anti-rajada)
      }
    });
    const votes = runState.items.filter((x) => x.result === 'reported');
    const novas = runState.items.filter((x) => x.created).length;
    const falhas = runState.items.filter((x) => x.result === 'failed').length;
    const ev = votes.find((x) => x.eventId);
    const failInfo = falhas > 0 ? ` · ${falhas} pulada(s) (sem céu limpo, tentam depois)` : '';
    runState.summary = votes.length === 0
      ? `💤 ${adopted.length} quadrante(s), ${novas} task(s) nova(s), nenhum voto` +
        (falhas > 0 ? failInfo : ' (fila esvaziada p/ seu operador)')
      : `✅ ${votes.length} voto(s) · ${novas} task(s) nova(s)${failInfo}` +
        (ev?.eventId ? ` · ${ev.decision} ${ev.eventId.slice(0, 8)}` : ' · aguardando quorum (falta 1 operador)');
  } catch (e) {
    runState.summary = `❌ run falhou: ${String(e).slice(0, 200)}`;
    logEvent('err', `run falhou: ${String(e).slice(0, 160)}`);
  } finally {
    runState.running = false;
    runState.current = null;
    runState.finishedAt = new Date().toISOString();
    lastRun = { at: runState.finishedAt, summary: `${runState.summary} · ${Math.round((Date.now() - t0) / 1000)}s` };
    logEvent((runState.summary ?? '').startsWith('❌') ? 'err' : 'ok', `run fim: ${(runState.summary ?? '').slice(0, 200)}`);
  }
}

function applyAuto(configDir: string): void {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; autoNextAt = null; }
  const full = readCfg(configDir);
  if (!full.auto_run) return;
  const minutes = Math.min(180, Math.max(5, Number(full.auto_minutes ?? 30)));
  autoNextAt = new Date(Date.now() + minutes * 60e3).toISOString();
  autoTimer = setInterval(async () => {
    if (runState.running) return;
    autoNextAt = new Date(Date.now() + minutes * 60e3).toISOString();
    await doRun(configDir).catch(() => undefined);
  }, minutes * 60e3);
}

/** Caminho da thumb contido em <configDir>/thumbs (null = rejeita). Puro e testavel. */
export function resolveThumbFile(configDir: string, h: string, task: string, kind: string): string | null {
  if (!/^[0-9a-f]{15}$/.test(h) || !/^[0-9a-f-]{8,36}$/.test(task) || (kind !== 't0' && kind !== 'base')) return null;
  const fp = resolve(configDir, 'thumbs', `${h}_${task}_${kind}.png`);
  if (!fp.startsWith(resolve(configDir, 'thumbs') + sep)) return null;
  return fp;
}

export async function buildLocalUi(configDir = 'config') {
  const { key: bootKey } = loadOrCreate(configDir);
  applyAuto(configDir);
  logEvent('info', `ui boot @${bootKey.operator_id}`);
  const app = Fastify({ logger: false });
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(pageHtml());
    return reply;
  });
  app.get('/ui', async (_req, reply) => {
    reply.redirect('/');
    return reply;
  });
  app.get('/api/status', async () => {
    const { key, cfg } = loadOrCreate(configDir);
    const full = readCfg(configDir);
    const online = await serverOnline(cfg.server_url);
    return {
      ok: true, operator: key.operator_id, node: cfg.node_id, alias: cfg.node_alias,
      server: cfg.server_url, server_online: online,
      stats: online ? await serverStats(cfg.server_url, key.operator_id) : null,
      config: { node_alias: cfg.node_alias, server_url: cfg.server_url, max_ram_mb: cfg.max_ram_mb },
      aoi: full.aoi ?? null, h3_cells: full.h3_cells ?? [], h3_centers: full.h3_centers ?? {},
      auto: { enabled: !!full.auto_run, minutes: Number(full.auto_minutes ?? 30), next_at: autoNextAt },
      lastRun, run_state: { running: runState.running, current: runState.current },
    };
  });
  app.get('/api/h3', async (req, reply) => {
    const { cfg } = loadOrCreate(configDir);
    const q = req.query as Record<string, string>;
    if (!q.bbox) return reply.code(400).send({ error: 'bbox=w,s,e,n obrigatorio' });
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/h3?bbox=${encodeURIComponent(q.bbox)}`);
    if (!r.ok) return reply.code(502).send({ error: `server h3: ${r.status}` });
    return reply.send(await r.json());
  });
  // Mosaico escalar (proxy p/ choropleth do server; celular so fala com :3000).
  app.get('/api/layer', async (req, reply) => {
    const { cfg } = loadOrCreate(configDir);
    const q = req.query as Record<string, string>;
    if (!q.name || !q.bbox) return reply.code(400).send({ error: 'name+bbox obrigatorios' });
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/layers/${encodeURIComponent(q.name)}?bbox=${encodeURIComponent(q.bbox)}`);
    if (!r.ok) return reply.code(502).send({ error: `server layer: ${r.status}` });
    return reply.send(await r.json());
  });
  // Fronteiras de adotados (p/ desenhar hexágonos verdes fora da grade visível).
  app.get('/api/cells', async (req, reply) => {    const { cfg } = loadOrCreate(configDir);
    const q = req.query as Record<string, string>;
    if (!q.h) return reply.code(400).send({ error: 'h=idx1,idx2... obrigatorio' });
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/h3/cells?h=${encodeURIComponent(q.h)}`);
    if (!r.ok) return reply.code(502).send({ error: `server h3cells: ${r.status}` });
    return reply.send(await r.json());
  });
  // F1 visual: thumbs NDVI geradas no voto (cache local, nunca no protocolo).
  // GET /api/thumbs?h=<h3> -> [{task, t0, base, mtime}] (ate 6 tasks recentes)
  // GET /api/thumbs/all -> [{h3, task, t0, base, mtime, bounds}] (30 recentes, p/ overlay)
  // GET /api/thumb?h=<h3>&task=<uuid>&kind=t0|base -> image/png
  interface ThumbEntry { h3: string; task: string; t0?: string; base?: string; mtime: number; bounds?: { sw: [number, number]; ne: [number, number] } }
  const listThumbs = (tdir: string, prefix: string): ThumbEntry[] => {
    let files: string[] = [];
    try { files = readdirSync(tdir).filter((f) => f.startsWith(prefix) && f.endsWith('.png')); } catch { return []; }
    const byTask = new Map<string, ThumbEntry>();
    for (const f of files) {
      const m = f.match(/^([0-9a-f]{15})_([0-9a-f-]{8,36})_(t0|base)\.png$/);
      if (!m) continue;
      const [, h3, task, kind] = m;
      let e = byTask.get(task);
      if (!e) { e = { h3, task, mtime: 0 }; byTask.set(task, e); }
      try { e.mtime = Math.max(e.mtime, statSync(join(tdir, f)).mtimeMs); } catch { /* some */ }
      if (!e.bounds) {
        try {
          const meta = JSON.parse(readFileSync(join(tdir, `${h3}_${task}_meta.json`), 'utf8')) as { sw?: [number, number]; ne?: [number, number] };
          if (Array.isArray(meta.sw) && Array.isArray(meta.ne)) e.bounds = { sw: meta.sw, ne: meta.ne };
        } catch { /* thumb antiga, sem sidecar: cliente usa a celula */ }
      }
      const url = `/api/thumb?h=${h3}&task=${task}&kind=${kind}`;
      if (kind === 't0') e.t0 = url; else e.base = url;
    }
    return [...byTask.values()].sort((a, b) => b.mtime - a.mtime);
  };
  app.get('/api/thumbs', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!q.h || !/^[0-9a-f]{15}$/.test(q.h)) return reply.code(400).send({ error: 'h invalido' });
    return { data: listThumbs(join(configDir, 'thumbs'), `${q.h}_`).slice(0, 6) };
  });
  app.get('/api/thumbs/all', async (_req, _reply) => {
    return { data: listThumbs(join(configDir, 'thumbs'), '').slice(0, 30) };
  });
  app.get('/api/thumb', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const fp = resolveThumbFile(configDir, q.h ?? '', q.task ?? '', q.kind ?? '');
    if (!fp) return reply.code(400).send({ error: 'parametros invalidos' });
    let buf: Buffer;
    try { buf = readFileSync(fp); } catch { return reply.code(404).send({ error: 'thumb nao encontrada' }); }
    if (buf.length < 20 || buf[0] !== 137 || buf[1] !== 80) return reply.code(404).send({ error: 'thumb invalida' });
    return reply.type('image/png').header('cache-control', 'public, max-age=86400').send(buf);
  });
  // F5 album: lista e bytes vindos do servidor (fotos que outros nos anexaram).
  app.get('/api/evidencelist', async (req, reply) => {
    const { cfg } = loadOrCreate(configDir);
    const q = req.query as Record<string, string>;
    if (!q.task || !/^[0-9a-f-]{36}$/.test(q.task)) return reply.code(400).send({ error: 'task invalida' });
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/evidence?task=${encodeURIComponent(q.task)}`);
    if (!r.ok) return reply.code(502).send({ error: `server evidence: ${r.status}` });
    return reply.send(await r.json());
  });
  app.get('/api/evidence/:hash', async (req, reply) => {
    const { cfg } = loadOrCreate(configDir);
    const p = req.params as { hash: string };
    if (!/^[0-9a-f]{64}$/.test(p.hash)) return reply.code(400).send({ error: 'hash invalido' });
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/evidence/${p.hash}`);
    if (!r.ok) return reply.code(r.status === 404 ? 404 : 502).send({ error: `server evidence: ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    return reply.type('image/png').header('cache-control', 'public, max-age=86400').send(buf);
  });
  // Logs: anel local (node) + anel do server (requisicoes).
  app.get('/api/logs', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const src = q.src === 'server' ? 'server' : 'node';
    if (src === 'node') return { data: localRing.slice(-Number(q.n ?? 80)) };
    const { cfg } = loadOrCreate(configDir);
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/logs?n=${encodeURIComponent(q.n ?? 80)}`);
    if (!r.ok) return reply.code(502).send({ error: `server logs: ${r.status}` });
    return reply.send(await r.json());
  });
  // Config do no (alias + server). Sem segredos: nunca expõe operator.key.
  app.get('/api/config', async () => {
    const { key, cfg } = loadOrCreate(configDir);
    return { data: { operator_id: key.operator_id, node_id: cfg.node_id, node_alias: cfg.node_alias, server_url: cfg.server_url, max_ram_mb: cfg.max_ram_mb } };
  });
  app.post('/api/config', async (req, reply) => {
    const body = (req.body ?? {}) as { node_alias?: unknown; server_url?: unknown };
    const patch: Record<string, unknown> = {};
    if (body.node_alias !== undefined) {
      if (typeof body.node_alias !== 'string' || body.node_alias.length < 1 || body.node_alias.length > 40) {
        return reply.code(400).send({ error: 'node_alias 1..40 chars' });
      }
      patch.node_alias = body.node_alias;
    }
    if (body.server_url !== undefined) {
      if (typeof body.server_url !== 'string' || !/^https?:\/\/[^/]+/.test(body.server_url) || body.server_url.length > 200) {
        return reply.code(400).send({ error: 'server_url http(s) invalida' });
      }
      patch.server_url = (body.server_url as string).replace(/\/$/, '');
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nada para salvar' });
    writeCfg(configDir, patch);
    logEvent('ok', `config atualizada: ${Object.keys(patch).join(',')}`);
    return { ok: true };
  });
  app.get('/api/activity', async (_req, reply) => {
    const { cfg } = loadOrCreate(configDir);
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/activity?limit=20`);
    if (!r.ok) return reply.code(502).send({ error: `server activity: ${r.status}` });
    return reply.send(await r.json());
  });
  // F4: impacto do operador (proxy; operator_id vem da identidade local).
  app.get('/api/impact', async (_req, reply) => {
    const { key, cfg } = loadOrCreate(configDir);
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/operators/${encodeURIComponent(key.operator_id)}/impact`);
    if (!r.ok) return reply.code(502).send({ error: `server impact: ${r.status}` });
    return reply.send(await r.json());
  });
  // Rastro do quadrante (proxy p/ timeline do server).
  app.get('/api/history', async (req, reply) => {
    const { cfg } = loadOrCreate(configDir);
    const q = req.query as Record<string, string>;
    if (!q.h || !/^[0-9a-f]{15}$/.test(q.h)) {
      return reply.code(400).send({ error: 'h=h3 res6 obrigatorio' });
    }
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/cells/${q.h}/history`);
    if (!r.ok) return reply.code(502).send({ error: `server history: ${r.status}` });
    return reply.send(await r.json());
  });
  app.post('/api/aoi', async (req, reply) => {
    const body = req.body as { polygon?: unknown; h3_cells?: unknown; h3_centers?: unknown };
    const patch: Record<string, unknown> = {};
    if (body?.polygon !== undefined) {
      if (!isValidPolygon(body.polygon)) return reply.code(400).send({ error: 'polygon GeoJSON invalido' });
      patch.aoi = body.polygon;
    }
    if (body?.h3_cells !== undefined) {
      if (!isValidH3Cells(body.h3_cells)) return reply.code(400).send({ error: 'h3_cells invalidas (hex 15, max 500)' });
      patch.h3_cells = [...new Set(body.h3_cells)];
    }
    if (body?.h3_centers !== undefined) {
      if (!isValidH3Centers(body.h3_centers)) return reply.code(400).send({ error: 'h3_centers invalidos' });
      // poda: guarda centro só de célula adotada (evita lixo de abandonadas)
      const cells = new Set((patch.h3_cells as string[] | undefined) ?? (readCfg(configDir).h3_cells as string[] ?? []));
      patch.h3_centers = Object.fromEntries(Object.entries(body.h3_centers).filter(([k]) => cells.has(k)));
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'nada para salvar' });
    patch.aoi_updated_at = new Date().toISOString();
    writeCfg(configDir, patch);
    logEvent('ok', `aoi salva (${(patch.h3_cells as string[] | undefined)?.length ?? '–'} celulas)`);
    return { ok: true, ...(patch.h3_cells ? { adopted: (patch.h3_cells as string[]).length } : {}) };
  });
  app.post('/api/auto', async (req, reply) => {
    const body = (req.body ?? {}) as { enabled?: boolean; minutes?: number };
    const minutes = Math.min(180, Math.max(5, Math.round(Number(body.minutes ?? 30))));
    writeCfg(configDir, { auto_run: !!body.enabled, auto_minutes: minutes });
    applyAuto(configDir);
    logEvent('info', `auto ${body.enabled ? `ligado ${minutes}min` : 'desligado'}`);
    return { ok: true, enabled: !!body.enabled, minutes, next_at: autoNextAt };
  });
  app.get('/api/run/state', async () => {
    const items = runState.items;
    const ens = items.filter((x) => x.kind === 'ensure');
    const ensDone = ens.filter((x) => x.phase !== 'ensure').length;
    const votes = items.filter((x) => x.kind === 'vote');
    const end = runState.finishedAt ?? new Date().toISOString();
    return {
      ok: true, state: runState,
      progress: {
        ensuresTotal: runState.totalCells ?? 0, ensuresDone: ensDone,
        votesDone: votes.filter((x) => x.result === 'reported').length,
        failsDone: votes.filter((x) => x.result === 'failed').length,
        idleHits: votes.filter((x) => x.result === 'idle').length,
        elapsedMs: runState.startedAt ? Math.max(0, new Date(end).getTime() - new Date(runState.startedAt).getTime()) : 0,
        avgEnsureMs: ensDone ? Math.round(ens.filter((x) => x.ms != null).reduce((a, x) => a + (x.ms ?? 0), 0) / Math.max(1, ens.filter((x) => x.ms != null).length)) : 0,
      },
    };
  });
  // Eventos confirmados (proxy p/ Evidence Map do server; celular so fala com :3000).
  app.get('/api/events', async (_req, reply) => {
    const { cfg } = loadOrCreate(configDir);
    const base = cfg.server_url.replace(/\/$/, '');
    const r = await fetch(`${base}/v1/events?limit=200`);
    if (!r.ok) return reply.code(502).send({ error: `server events: ${r.status}` });
    return reply.send(await r.json());
  });
  app.post('/api/run', async (req, reply) => {
    const body = (req.body ?? {}) as { h3_cells?: unknown };
    if (Array.isArray(body.h3_cells) && body.h3_cells.length > 0) {
      if (!isValidH3Cells(body.h3_cells)) return reply.code(400).send({ error: 'h3_cells invalidas' });
      writeCfg(configDir, { h3_cells: [...new Set(body.h3_cells)], aoi_updated_at: new Date().toISOString() });
    }
    if (runState.running) return reply.code(409).send({ error: 'run em andamento', state: runState });
    void doRun(configDir);
    return reply.code(202).send({ ok: true, started: true });
  });
  app.get('/pairing/export', async (_req, reply) => {
    reply.type('application/json').send(exportPairing(configDir));
    return reply;
  });
  app.post('/pairing/import', async (req, reply) => {
    try {
      const key = importPairing(JSON.stringify(req.body), configDir);
      dropCfgCache(configDir); // chave nova -> operator_id da config muda
      return { ok: true, operator_id: key.operator_id };
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });
  return app;
}

function pageHtml(): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SatSentinel · Central</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<script>tailwind.config={theme:{extend:{colors:{neon:'#00f2fe',mint:'#10b981'}}}}</script>
<style>
html,body{height:100%}
body{background:#020617;font-family:ui-sans-serif,system-ui,sans-serif}
.leaflet-pane{z-index:1}.leaflet-top,.leaflet-bottom{z-index:500}
#map{background:#020617}
#map::after{content:'';position:absolute;inset:0;pointer-events:none;z-index:600;
  background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(0,242,254,.035) 3px 4px)}
#side{width:64px;transition:width .3s}
#side.open{width:240px}
#side .lbl{display:none;white-space:nowrap}
#side.open .lbl{display:inline}
#side nav button{transition:background .15s,color .15s}
#side nav button.on{background:rgba(0,242,254,.12);color:#00f2fe}
#side nav button:hover{background:rgba(0,242,254,.07)}
.dot{width:8px;height:8px;border-radius:9999px;display:inline-block}
.dot.on{background:#10b981;color:#10b981;box-shadow:0 0 8px #10b981;animation:pulse 1.6s infinite}
.dot.off{background:#f43f5e;color:#f43f5e}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.card{transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-2px);box-shadow:0 4px 18px rgba(0,242,254,.15)}
.btn-glow{transition:box-shadow .2s,transform .1s}
.btn-glow:hover{box-shadow:0 0 16px rgba(0,242,254,.55)}
.btn-glow:active{transform:scale(.97)}
.btn-go{transition:box-shadow .2s,transform .1s}
.btn-go:hover{box-shadow:0 0 22px rgba(16,185,129,.6)}
.btn-go:active{transform:scale(.98)}
#console-body{max-height:220px;transition:max-height .3s ease;overflow:hidden}
#console.closed #console-body{max-height:0}
#logbox{scrollbar-width:thin}
.log-err{color:#f87171}.log-warn{color:#fbbf24}.log-ok{color:#34d399}.log-dim{color:#64748b}
.spin{display:inline-block;animation:sp 1s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
.leaflet-popup-content-wrapper{background:#0f172a;color:#e2e8f0;border:1px solid #1e293b}
.leaflet-popup-tip{background:#0f172a}
section{display:none}section.on{display:block}
.row{display:flex;gap:.5rem;align-items:center;background:rgba(15,23,42,.6);border:1px solid #1e293b;border-radius:.75rem;padding:.55rem .7rem;margin:.4rem 0;font-size:13px}
.baswap img.top{transition:opacity .25s}
.baswap:hover img.top,.baswap:focus-within img.top,.baswap.off img.top{opacity:0}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #00f2fe;outline-offset:2px}
button,.act,.danger{min-height:44px;min-width:44px}
#toasts{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.toast{background:rgba(2,6,23,.92);border:1px solid #1e293b;color:#e2e8f0;font-size:13px;padding:8px 14px;border-radius:99px;box-shadow:0 4px 18px rgba(0,0,0,.5);animation:tin .2s ease}
.toast.ok{border-color:#10b981;color:#a7f3d0}.toast.err{border-color:#f43f5e;color:#fecdd3}.toast.warn{border-color:#facc15;color:#fef08a}
@keyframes tin{from{opacity:0;transform:translateY(8px)}}
.btn-busy{opacity:.6;pointer-events:none}
.btn-busy::after{content:' ◌';display:inline-block;animation:sp 1s linear infinite}
#modal-veil{position:fixed;inset:0;z-index:1900;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
#modal-box{background:#0f172a;border:1px solid #334155;border-radius:12px;padding:18px;max-width:min(420px,90vw)}
.row code{font-size:12px;color:#00f2fe}
.row .grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hint{font-size:12px;color:#64748b}
.pill{font-size:11px;border:1px solid #334155;border-radius:9999px;padding:2px 9px;color:#94a3b8;white-space:nowrap}
.pill.ok{color:#34d399;border-color:#34d399}.pill.run{color:#fbbf24;border-color:#fbbf24}.pill.err{color:#f87171;border-color:#f87171}.pill.skip{color:#38bdf8;border-color:#38bdf8}
button.act{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:.5rem;padding:.5rem .75rem;font-size:14px}
button.danger{color:#fb7185;border:1px solid rgba(244,63,94,.4);background:none;border-radius:.5rem;padding:.5rem .6rem;font-size:13px}
#msg{font-size:12px}
@media(max-width:899px){
  #side{position:fixed;bottom:0;left:0;right:0;width:auto!important;flex-direction:row;border-right:none;border-top:1px solid #1e293b;padding:6px;z-index:1200}
  #side.open{width:auto}
  #side .lbl{display:none}
  #side-toggle{display:none}
  #side nav{flex-direction:row!important;width:100%}
  main{padding-bottom:84px}
  #panel{top:auto!important;bottom:110px;left:8px;right:8px;width:auto!important;max-height:42vh}
  #console{left:8px;right:8px;width:auto!important}
}
</style></head><body class="text-slate-200">
<div class="flex h-[100dvh]">
<aside id="side" class="transition-all duration-300 z-[1200] flex flex-col bg-slate-950/95 border-r border-slate-800/80 backdrop-blur-md">
<button id="side-toggle" class="m-2 p-2 rounded-xl text-cyan-300 hover:bg-cyan-400/10 btn-glow" title="Expandir/recolher"><i data-lucide="chevrons-left" class="w-6 h-6 mx-auto"></i></button>
<nav class="flex md:flex-col flex-row gap-1 p-2 flex-1">
<button id="n-map" class="on flex items-center gap-3 p-3 rounded-xl text-slate-400 hover:text-cyan-300"><i data-lucide="map" class="w-6 h-6 shrink-0"></i><span class="lbl text-sm">Mapa</span></button>
<button id="n-cells" class="flex items-center gap-3 p-3 rounded-xl text-slate-400 hover:text-cyan-300"><i data-lucide="hexagon" class="w-6 h-6 shrink-0"></i><span class="lbl text-sm">Quadrantes</span></button>
<button id="n-tasks" class="flex items-center gap-3 p-3 rounded-xl text-slate-400 hover:text-cyan-300"><i data-lucide="list" class="w-6 h-6 shrink-0"></i><span class="lbl text-sm">Tarefas</span></button>
<button id="n-logs" class="flex items-center gap-3 p-3 rounded-xl text-slate-400 hover:text-cyan-300"><i data-lucide="terminal" class="w-6 h-6 shrink-0"></i><span class="lbl text-sm">Logs</span></button>
<button id="n-impact" class="flex items-center gap-3 p-3 rounded-xl text-slate-400 hover:text-cyan-300"><i data-lucide="award" class="w-6 h-6 shrink-0"></i><span class="lbl text-sm">Impacto</span></button>
<button id="n-config" class="flex items-center gap-3 p-3 rounded-xl text-slate-400 hover:text-cyan-300"><i data-lucide="settings" class="w-6 h-6 shrink-0"></i><span class="lbl text-sm">Ajustes</span></button>
</nav>
<div class="p-2 hidden md:block"><div class="lbl text-[10px] text-slate-600 px-2">SAT SENTINEL<br><span id="op-side"></span></div></div>
</aside>
<main class="flex-1 flex flex-col min-w-0 relative">
<header class="z-[1100] m-2 md:m-3 mb-0 rounded-xl bg-slate-900/80 backdrop-blur-md border border-slate-800/80 p-3">
<div class="flex items-center gap-2 mb-2"><i data-lucide="satellite" class="w-5 h-5 text-neon"></i>
<span class="tracking-[0.2em] text-sm text-cyan-300 font-semibold">SATSENTINEL · CENTRAL DO NÓ</span>
<span id="op" class="text-xs text-slate-500 ml-auto"></span>
<span id="upd" class="text-[10px] text-slate-600"></span></div>
<div id="hud" class="grid grid-cols-2 lg:grid-cols-5 gap-3">
<div class="card bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5"><div class="flex items-center gap-1.5 text-[10px] text-slate-500"><i data-lucide="server" class="w-3.5 h-3.5"></i>SERVER</div><div id="h-server" class="mt-1 text-sm font-semibold">…</div></div>
<div class="card bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5"><div class="flex items-center gap-1.5 text-[10px] text-slate-500"><i data-lucide="network" class="w-3.5 h-3.5"></i>NÓS GLOBAIS</div><div id="h-nodes" class="mt-1 text-lg font-bold tabular-nums">…</div></div>
<div class="card bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5"><div class="flex items-center gap-1.5 text-[10px] text-slate-500"><i data-lucide="cpu" class="w-3.5 h-3.5"></i>SEUS NÓS</div><div id="h-mynodes" class="mt-1 text-lg font-bold tabular-nums text-emerald-400">…</div></div>
<div class="card bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5"><div class="flex items-center gap-1.5 text-[10px] text-slate-500"><i data-lucide="hexagon" class="w-3.5 h-3.5"></i>QUADRANTES</div><div id="h-cells" class="mt-1 text-lg font-bold tabular-nums">…</div><div class="mt-1 h-1.5 rounded-full bg-slate-800"><div id="h-cellbar" class="h-1.5 rounded-full bg-emerald-400 transition-all" style="width:0%"></div></div></div>
<div class="card bg-slate-900/60 border border-slate-800/80 rounded-xl p-2.5"><div class="flex items-center gap-1.5 text-[10px] text-slate-500"><i data-lucide="bell" class="w-3.5 h-3.5"></i>ALERTAS</div><div id="h-events" class="mt-1">…</div></div>
</div>
</header>
<div id="stage" class="relative flex-1 min-h-0 m-2 md:m-3 rounded-xl overflow-hidden border border-slate-800/80">
<div id="map" class="absolute inset-0"></div>
<div id="layers" class="absolute top-2 right-2 z-[1100] flex flex-col gap-2">
<button id="ly-sat" title="Satélite" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 btn-glow"><i data-lucide="satellite" class="w-5 h-5"></i></button>
<button id="ly-grid" title="Grade H3" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-cyan-400 text-cyan-300 btn-glow"><i data-lucide="grid-3x3" class="w-5 h-5"></i></button>
<button id="ly-ev" title="Vetores de anomalia" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-rose-400 text-rose-300 btn-glow"><i data-lucide="flame" class="w-5 h-5"></i></button>
<button id="ly-mine" title="Meu território" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-emerald-400 text-emerald-300 btn-glow"><i data-lucide="hexagon" class="w-5 h-5"></i></button>
<button id="ly-photo" title="Fotos votadas" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 btn-glow"><i data-lucide="camera" class="w-5 h-5"></i></button>
<button id="ly-temp" title="Temperatura (Landsat)" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 btn-glow"><i data-lucide="thermometer" class="w-5 h-5"></i></button>
<button id="ly-veg" title="Vigor NDVI (Sentinel-2)" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 btn-glow"><i data-lucide="leaf" class="w-5 h-5"></i></button>
</div>
<div id="temp-legend" style="display:none" class="absolute bottom-2 right-2 z-[1100] rounded-xl bg-slate-950/90 backdrop-blur border border-slate-800/80 px-2.5 py-2 text-[10px] text-slate-400">
<div id="temp-legend-title" class="mb-1 font-semibold tracking-wider">LST °C</div>
<div class="flex items-center gap-1"><span id="temp-legend-lo">10</span><div id="temp-legend-bar" class="w-24 h-2 rounded-full" style="background:linear-gradient(90deg,#3b82f6,#22c55e,#facc15,#f97316,#ef4444)"></div><span id="temp-legend-hi">45+</span></div>
</div>
<aside id="panel" class="absolute top-2 right-14 bottom-2 w-[min(380px,90vw)] z-[1100] overflow-y-auto rounded-xl bg-slate-950/90 backdrop-blur-md border border-slate-800/80 p-3" style="display:none">
<section id="v-cells">
<div class="text-xs text-slate-400 mb-2">Toque num quadrante para <b>ver info</b> e adotar. Adotados ficam <b class="text-emerald-400">verdes</b>. Zoom 8+.</div>
<div class="flex gap-2 mb-2"><button id="adopt-all" class="flex-1 text-sm px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 btn-glow">➕ Adotar visíveis</button>
<button id="adopt-clear" class="text-sm px-3 py-2 rounded-lg border border-rose-500/60 text-rose-300">Abandonar todos</button></div>
<div id="msg2" class="text-xs text-slate-500 mb-2"></div>
<button id="run3" class="go btn-go w-full bg-emerald-950 text-emerald-300 border border-emerald-400 rounded-xl p-3 font-semibold mb-2">▶ VOTAR ADOTADOS</button>
<div id="list"></div>
<div id="hist"></div>
</section>
<section id="v-tasks" style="display:none">
<div class="flex items-center gap-2 text-sm bg-slate-900/60 border border-slate-800 rounded-xl p-2.5 mb-2"><span class="flex-1">Automático <span class="text-slate-500 text-xs">(vigia + vota sozinho)</span></span>
<select id="auto-min" aria-label="Intervalo do modo automático" class="bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-sm"><option value="15">15m</option><option value="30" selected>30m</option><option value="60">60m</option><option value="120">120m</option></select>
<button id="auto-t" class="text-sm px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 btn-glow">Ligar</button></div>
<div id="auto-info" class="text-xs text-slate-500 mb-2"></div>
<button id="run2" class="go btn-go w-full bg-emerald-950 text-emerald-300 border border-emerald-400 rounded-xl p-3 font-semibold">▶ EXECUTAR AGORA</button>
<div id="runbox" class="mt-2"></div>
<div id="feed" class="mt-2"></div>
</section>
<section id="v-logs" style="display:none">
<div class="flex gap-2 mb-2"><button id="log-node" class="flex-1 text-sm px-3 py-2 rounded-lg bg-slate-800 border border-cyan-400 text-cyan-300">Nó</button>
<button id="log-server" class="flex-1 text-sm px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400">Servidor</button></div>
<div id="logbox" class="font-mono text-xs bg-black/60 border border-slate-800 rounded-xl p-2.5 h-64 overflow-y-auto whitespace-pre-wrap"></div>
</section>
<section id="v-impact" style="display:none">
<div class="text-xs text-slate-500 mb-2">SEU IMPACTO NA REDE</div>
<div id="impact-box"><div class="hint">⏳ Carregando…</div></div>
</section>
<section id="v-config" style="display:none">
<div class="text-xs text-slate-500 mb-1">OPERADOR</div><div id="cfg-op" class="font-mono text-sm text-cyan-300 mb-3"></div>
<label for="cfg-alias" class="text-xs text-slate-500 mb-1 block">APELIDO DO NÓ</label>
<div class="flex gap-2 mb-3"><input id="cfg-alias" maxlength="40" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg p-2 text-sm"><button id="cfg-save-alias" class="text-sm px-3 rounded-lg bg-slate-800 border border-slate-700 btn-glow">OK</button></div>
<label for="cfg-server" class="text-xs text-slate-500 mb-1 block">SERVIDOR</label>
<div class="flex gap-2 mb-3"><input id="cfg-server" maxlength="200" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg p-2 text-sm font-mono"><button id="cfg-save-server" class="text-sm px-3 rounded-lg bg-slate-800 border border-slate-700 btn-glow">OK</button></div>
<div class="text-xs text-slate-500 mb-1">EMPARELHAMENTO</div>
<div class="flex gap-2 mb-2"><a href="/pairing/export" download="operator.key" class="text-sm px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 btn-glow"><i data-lucide="download" class="w-4 h-4 inline"></i> Exportar chave</a></div>
<label for="cfg-import" class="text-xs text-slate-500 mb-1 block">IMPORTAR CHAVE</label>
<textarea id="cfg-import" rows="3" placeholder="Cole o operator.key aqui para importar" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-mono mb-2"></textarea>
<button id="cfg-do-import" class="text-sm px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 btn-glow mb-3"><i data-lucide="upload" class="w-4 h-4 inline"></i> Importar</button>
<div class="text-xs text-slate-500 mb-1">ZONA DE PERIGO</div>
<div class="hint">Gerencie os quadrantes pela aba Quadrantes (seleção, lote e abandono com confirmação).</div>
<div id="cfg-msg" class="text-xs text-slate-500 mt-2"></div>
</section>
</aside>
<div id="toasts" aria-live="polite" aria-atomic="false"></div>
<div id="modal-veil" style="display:none" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div id="modal-box">
<div id="modal-title" class="font-semibold mb-1"></div><div id="modal-body" class="text-sm text-slate-400 mb-4"></div>
<div class="flex gap-2 justify-end"><button id="modal-no" class="text-sm px-4 py-2 rounded-lg bg-slate-800 border border-slate-700">Cancelar</button>
<button id="modal-yes" class="text-sm px-4 py-2 rounded-lg border border-rose-500/60 text-rose-200">Confirmar</button></div>
</div></div>
<div id="console" class="absolute left-2 right-2 md:right-auto md:w-[430px] bottom-2 z-[1100] rounded-xl bg-slate-950/90 backdrop-blur-md border border-slate-800/80">
<div class="flex items-center gap-2 px-3 pt-2 text-xs text-slate-400"><span class="text-cyan-300">◉ CONSOLE</span>
<span id="msg" class="flex-1 truncate" role="status" aria-live="polite"></span>
<button id="console-toggle" class="p-1 text-slate-500 hover:text-cyan-300"><i data-lucide="chevron-down" class="w-4 h-4"></i></button></div>
<div id="console-body" class="px-3 pb-3">
<div class="flex gap-2 mt-2"><button id="geo" class="flex-1 text-sm px-3 py-2.5 rounded-xl bg-slate-800 border border-slate-700 btn-glow">📍 GPS</button>
<button id="run1" class="go btn-go flex-[2] bg-emerald-950 text-emerald-300 border border-emerald-400 rounded-xl p-2.5 font-semibold">▶ EXECUTAR</button></div>
</div>
</div>
</div>
</main>
</div>
<script>
const map=L.map('map',{zoomControl:false}).setView([-10.5,-55],5);
L.control.zoom({position:'bottomright'}).addTo(map);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,attribution:'&copy; Esri'}).addTo(map);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,attribution:'&copy; Esri'}).addTo(map);
const adopted=new Set(); const centers={}; const layers=new Map(); const boundsCache=new Map();
let seq=0,deb=null,view='map',poll=null;
const short=h=>String(h||'').slice(0,8)+'…';
const short12=h=>String(h||'').slice(0,12);
const fmtM=n=>n>=1e6?(n/1e6).toFixed(1).replace('.',',')+'M':String(n??'…');
const $=id=>document.getElementById(id);
function msg(t){$('msg').textContent=t;}
function show(v){view=v;
  for(const s of ['map','cells','tasks','logs','impact','config']){
    const vs=$('v-'+s),ns=$('n-'+s);
    if(vs)vs.style.display=s===v?'block':'none';
    if(ns)ns.classList.toggle('on',s===v);}
  $('panel').style.display=v==='map'?'none':'block';
  if(!gridOn)for(const [h,o] of [...layers]){if(!o.mine){map.removeLayer(o.poly);layers.delete(h);}}
  if(v==='cells'){loadGrid(true);renderList();}
  if(v==='map')loadGrid(true);
  if(v==='tasks')refreshRun();
  if(v==='logs'){paintLogSrc();loadLogs();if(logPoll)clearInterval(logPoll);logPoll=setInterval(()=>{if(view==='logs')loadLogs();},5000);}
  else if(logPoll){clearInterval(logPoll);logPoll=null;}
  if(v==='config')renderConfig();
  if(v==='impact')loadImpact();
  if(v==='map'){ensurePolys().then(paintMine);if(evOn)loadEvents();}
  setTimeout(()=>map.invalidateSize(),50);}
for(const s of ['map','cells','tasks','logs','impact','config'])$('n-'+s).onclick=()=>show(s);
$('side-toggle').onclick=()=>{$('side').classList.toggle('open');setTimeout(()=>map.invalidateSize(),320);};
function icons(){try{if(window.lucide)lucide.createIcons();}catch(e){}}
// --- camadas do mapa ---
let satLayer=null, gridOn=true, evOn=true, mineOn=true, logPoll=null;
function flipBtn(id,on){const b=$(id);if(b)b.classList.toggle('opacity-40',!on);}
$('ly-sat').onclick=()=>{const has=!!satLayer&&map.hasLayer(satLayer);
  if(has){map.removeLayer(satLayer);}else{
    if(!satLayer)satLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,attribution:'&copy; Esri'});
    satLayer.addTo(map);}
  flipBtn('ly-sat',!has);};
$('ly-grid').onclick=()=>{gridOn=!gridOn;flipBtn('ly-grid',gridOn);
  if(!gridOn)for(const [h,o] of [...layers]){if(!o.mine){map.removeLayer(o.poly);layers.delete(h);}}
  else if(view==='cells')loadGrid(true);};
$('ly-ev').onclick=()=>{evOn=!evOn;flipBtn('ly-ev',evOn);
  if(evOn)loadEvents();else if(evLayer)map.removeLayer(evLayer);};
$('ly-mine').onclick=()=>{mineOn=!mineOn;flipBtn('ly-mine',mineOn);paintMine();};
// FOTOS no mapa: ultima passagem votada ocupando o quadrante (overlay
// georreferenciado). Max 12 proximas do centro; clique mostra antes x depois.
let photoOn=false, photoLayer=null, photoDeb=null;
function photoBounds(h, entry){
  if(entry.bounds&&Array.isArray(entry.bounds.sw)&&Array.isArray(entry.bounds.ne))return [entry.bounds.sw,entry.bounds.ne];
  const ll=boundsCache.get(h);
  if(!ll||!ll.length)return null;
  let s=90,n=-90,w=180,e=-180;
  for(const p of ll){if(p[0]<s)s=p[0];if(p[0]>n)n=p[0];if(p[1]<w)w=p[1];if(p[1]>e)e=p[1];}
  return [[s,w],[n,e]];
}
async function loadPhotoOverlays(autoFly){
  if(photoLayer){map.removeLayer(photoLayer);photoLayer=null;}
  if(!photoOn)return;
  await ensurePolys();
  let all=[];
  try{all=((await (await fetch('/api/thumbs/all')).json()).data||[]).filter(x=>x.t0&&x.base);}catch(e){return;}
  if(!all.length){toast('Sem fotos ainda — vote para gerar.','warn');return;}
  const b=map.getBounds();
  const cx=(b.getWest()+b.getEast())/2,cy=(b.getSouth()+b.getNorth())/2;
  const hits=[];
  const located=[]; // com cantos (p/ "mais proxima" mesmo fora da vista)
  for(const e of all){
    let bd=photoBounds(e.h3,e);
    if(!bd){
      // sem sidecar e sem celula em cache: busca fronteira uma vez
      try{
        const r=await fetch('/api/cells?h='+encodeURIComponent(e.h3));const jj=await r.json();
        const bnd=(jj.data?.cells||[])[0]?.boundary;
        if(bnd){const ll=bnd.map(p=>[p[0],p[1]]);boundsCache.set(e.h3,ll);bd=photoBounds(e.h3,e);}
      }catch(_){}
    }
    if(!bd)continue;
    located.push({e,bd});
    // intersepta a vista?
    if(bd[1][0]<b.getSouth()||bd[0][0]>b.getNorth()||bd[1][1]<b.getWest()||bd[0][1]>b.getEast())continue;
    hits.push({e,bd,mine:adopted.has(e.h3)});
  }
  if(!hits.length){
    if(autoFly&&located.length){
      // leva ate a foto mais proxima do centro atual (so no ligar, nunca no arrastar)
      located.sort((a,c)=>{const ma=[(a.bd[0][0]+a.bd[1][0])/2,(a.bd[0][1]+a.bd[1][1])/2];
        const mb=[(c.bd[0][0]+c.bd[1][0])/2,(c.bd[0][1]+c.bd[1][1])/2];
        return ((ma[0]-cy)**2+(ma[1]-cx)**2)-((mb[0]-cy)**2+(mb[1]-cx)**2);});
      const best=located[0];
      toast('Voando até a foto mais próxima…',null);
      map.flyTo([(best.bd[0][0]+best.bd[1][0])/2,(best.bd[0][1]+best.bd[1][1])/2],10,{duration:1.5});
      return; // moveend reposiciona e o reload mostra
    }
    if(!located.length)toast('Sem fotos localizáveis ainda.','warn');
    else toast('Nenhuma foto nesta vista — navegue até onde votou.','warn');
    return;
  }
  // adotadas primeiro, depois por recencia; max 12
  hits.sort((a,c)=>((c.mine?1:0)-(a.mine?1:0))||((c.e.mtime||0)-(a.e.mtime||0)));
  photoLayer=L.layerGroup().addTo(map);
  for(const {e,bd} of hits.slice(0,12)){
    try{
      const ov=L.imageOverlay(e.t0,bd,{opacity:0.85,interactive:true}).addTo(photoLayer);
      ov.bindPopup('<b>🛰 última passagem</b> ▦ '+esc(short12(e.h3))+(adopted.has(e.h3)?' · sua':'')+'<br>'+
        '<img loading="lazy" src="'+esc(e.t0)+'" style="width:220px;border-radius:6px" alt="agora"><br>'+
        '<small>passe o mouse no rastro para o antes · </small><button data-phist="'+esc(e.h3)+'">📜 rastro</button>');
      ov.on('popupopen',ev=>{ev.popup.getElement()?.querySelector('[data-phist]')?.addEventListener('click',x=>{
        map.closePopup();showHist(x.target.dataset.phist);});});
    }catch(_){/* pula */}
  }
  toast(hits.length+' foto(s) nesta vista.',null);
}
$('ly-photo').onclick=()=>{photoOn=!photoOn;flipBtn('ly-photo',photoOn);loadPhotoOverlays(photoOn);};
flipBtn('ly-photo',false);
// --- camadas vivas (mosaicos escalares do server) ---
let liveLayer=null, liveName=null;
function liveColor(layer,v){
  if(layer==='NDVI'){
    const x=Math.min(1,Math.max(0,v));
    const m=[120+(34-120)*x,100+(197-100)*x,60+(94-60)*x].map(n=>Math.round(n).toString(16).padStart(2,'0'));
    return '#'+m.join('');
  }
  const stops=[[10,[59,130,246]],[20,[34,197,94]],[28,[250,204,21]],[35,[249,115,22]],[45,[239,68,68]]];
  if(v<=stops[0][0])return '#3b82f6';
  for(let i=1;i<stops.length;i++){
    if(v<=stops[i][0]){const t0=stops[i-1][0],c0=stops[i-1][1],t1=stops[i][0],c1=stops[i][1];
      const k=(v-t0)/(t1-t0);const m=c0.map((c,j)=>Math.round(c+(c1[j]-c)*k));
      return '#'+m.map(c=>c.toString(16).padStart(2,'0')).join('');}
  }
  return '#ef4444';
}
function liveLegend(){
  const t=$('temp-legend-title'),lo=$('temp-legend-lo'),hi=$('temp-legend-hi'),bar=$('temp-legend-bar');
  if(liveName==='NDVI'){t.textContent='NDVI';lo.textContent='0';hi.textContent='1';
    bar.style.background='linear-gradient(90deg,#78643c,#22c55e)';}
  else{t.textContent='LST °C';lo.textContent='10';hi.textContent='45+';
    bar.style.background='linear-gradient(90deg,#3b82f6,#22c55e,#facc15,#f97316,#ef4444)';}
}
function livePopup(layer,c){
  const v=Number(c.value);
  return (layer==='NDVI'?'🌿 NDVI '+v.toFixed(2):'🌡 '+v.toFixed(1)+' °C')+'<br>'+esc(c.h3_index)+'<br>'+esc(c.votes)+' voto(s)';
}
async function loadLive(){
  if(!liveName)return;
  try{
    const b=map.getBounds(),q=b.getWest()+','+b.getSouth()+','+b.getEast()+','+b.getNorth();
    const j=await (await fetch('/api/layer?name='+liveName+'&bbox='+encodeURIComponent(q))).json();
    if(liveLayer)map.removeLayer(liveLayer);
    liveLayer=L.layerGroup();
    for(const c of (j.data?.cells||[])){
      let ll=boundsCache.get(c.h3_index);
      if(!ll){
        try{
          const r=await fetch('/api/cells?h='+c.h3_index);const jj=await r.json();
          const bnd=(jj.data?.cells||[])[0]?.boundary;
          if(!bnd)continue;
          ll=bnd.map(p=>[p[0],p[1]]);boundsCache.set(c.h3_index,ll);
        }catch(e){continue;}
      }
      L.polygon(ll,{color:liveColor(liveName,c.value),weight:1,fillColor:liveColor(liveName,c.value),fillOpacity:0.55})
        .bindPopup(livePopup(liveName,c))
        .addTo(liveLayer);
    }
    liveLayer.addTo(map);
    $('temp-legend').style.display='block';
  }catch(e){msg('Falha na camada viva: '+e);}
}
function setLive(name,btn){
  liveName=(liveName===name)?null:name;
  for(const [id,nm] of [['ly-temp','LST_C'],['ly-veg','NDVI']])flipBtn(id,liveName===nm);
  liveLegend();
  $('temp-legend').style.display=liveName?'block':'none';
  if(liveLayer)map.removeLayer(liveLayer);
  if(liveName)loadLive();
}
$('ly-temp').onclick=()=>setLive('LST_C');
$('ly-veg').onclick=()=>setLive('NDVI');
map.on('moveend',()=>{if(liveName)loadLive();});
// --- console recolhivel ---
$('console-toggle').onclick=()=>{$('console').classList.toggle('closed');};
// --- logs ---
let logSrc='node';
function paintLogSrc(){
  const a=$('log-node'),b=$('log-server');if(!a||!b)return;
  const on='flex-1 text-sm px-3 py-2 rounded-lg border btn-glow bg-slate-800 border-cyan-400 text-cyan-300';
  const off='flex-1 text-sm px-3 py-2 rounded-lg border btn-glow bg-slate-800 border-slate-700 text-slate-400';
  a.className=logSrc==='node'?on:off;b.className=logSrc==='server'?on:off;}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
// Toasts nao-bloqueantes (substituem alert/confirm nativos).
function toast(msg,kind){
  const box=$('toasts');if(!box)return;
  const d=document.createElement('div');
  d.className='toast '+(kind||'');
  d.textContent=String(msg).slice(0,220);
  box.appendChild(d);
  while(box.children.length>4)box.removeChild(box.firstChild);
  setTimeout(()=>{d.style.opacity='0';d.style.transition='opacity .3s';setTimeout(()=>d.remove(),320);},3600);
}
// busy(btn,fn): desabilita + spinner durante fetch; reabilita sempre.
async function busy(btn,fn){
  const b=(typeof btn==='string')?$(btn):btn;
  if(b){b.disabled=true;b.classList.add('btn-busy');}
  try{return await fn();}finally{if(b){b.disabled=false;b.classList.remove('btn-busy');}}
}
// Modal de confirmacao (substitui confirm() bloqueante). Foco no cancelar.
function confirmModal(title,body){
  return new Promise(res=>{
    const veil=$('modal-veil');
    $('modal-title').textContent=title;$('modal-body').textContent=body;
    const prev=document.activeElement;
    const done=v=>{veil.style.display='none';
      $('modal-yes').onclick=$('modal-no').onclick=null;
      document.removeEventListener('keydown',onKey,true);
      if(prev&&prev.focus)prev.focus();res(v);};
    const onKey=e=>{if(e.key==='Escape'){e.stopPropagation();done(false);}};
    $('modal-yes').onclick=()=>done(true);
    $('modal-no').onclick=()=>done(false);
    document.addEventListener('keydown',onKey,true);
    veil.style.display='flex';
    $('modal-no').focus();
  });
}
function lineHtml(e){
  if(e.method){const c=e.status>=500?'log-err':e.status>=400?'log-warn':'log-ok';
    return '<div><span class="log-dim">'+esc(String(e.t).slice(11,19))+'</span> <span class="'+c+'">'+esc(e.method)+' '+esc(e.url)+' → '+e.status+'</span></div>';}
  const c=e.level==='err'?'log-err':e.level==='warn'?'log-warn':e.level==='ok'?'log-ok':'';
  return '<div><span class="log-dim">'+esc(String(e.t).slice(11,19))+'</span> <span class="'+c+'">'+esc(e.msg)+'</span></div>';}
let logLastKey=null,logSeenSrc='';
const logKey=e=>[e.t,e.method||e.level,e.url||e.msg,e.status].join('|');
async function loadLogs(force){
  try{
    const j=await (await fetch('/api/logs?src='+logSrc+'&n=80')).json();
    const el=$('logbox');if(!el)return;
    const lines=j.data||[];
    // Append incremental por identidade (anel gira: slice(-80) desliza).
    let fresh=lines;
    if(!force&&logSrc===logSeenSrc&&logLastKey!=null){
      const idx=lines.map(logKey).lastIndexOf(logLastKey);
      fresh=(idx>=0)?lines.slice(idx+1):lines;
      if(idx<0)el.innerHTML='';
    }else{el.innerHTML='';}
    logSeenSrc=logSrc;
    if(lines.length)logLastKey=logKey(lines[lines.length-1]);
    const atBottom=el.scrollHeight-el.scrollTop-el.clientHeight<30;
    const frag=document.createDocumentFragment();
    for(const e of fresh){const d=document.createElement('div');d.innerHTML=lineHtml(e);while(d.firstChild)frag.appendChild(d.firstChild);}
    el.appendChild(frag);
    while(el.children.length>200)el.removeChild(el.firstChild);
    if(atBottom)el.scrollTop=el.scrollHeight;
    if(!el.children.length)el.innerHTML='<div class="log-dim">sem logs</div>';
  }catch(e){}
}
$('log-node').onclick=()=>{logSrc='node';paintLogSrc();loadLogs();};
$('log-server').onclick=()=>{logSrc='server';paintLogSrc();loadLogs();};
// --- config ---
async function renderConfig(){
  try{
    const j=await (await fetch('/api/config')).json();const d=j.data||{};
    $('cfg-op').textContent=d.operator_id||'?';
    if(document.activeElement!==$('cfg-alias'))$('cfg-alias').value=d.node_alias||'';
    if(document.activeElement!==$('cfg-server'))$('cfg-server').value=d.server_url||'';
  }catch(e){}
}
$('cfg-save-alias').onclick=()=>busy('cfg-save-alias',async()=>{await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({node_alias:$('cfg-alias').value})});toast('Apelido salvo.','ok');refresh();});
$('cfg-save-server').onclick=()=>busy('cfg-save-server',async()=>{const r=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({server_url:$('cfg-server').value})});toast(r.ok?'Servidor salvo.':'URL inválida.',r.ok?'ok':'err');refresh();});
$('cfg-do-import').onclick=()=>busy('cfg-do-import',async()=>{try{const v=JSON.parse($('cfg-import').value);
    const r=await fetch('/api/pairing/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)});
    toast(r.ok?'Chave importada. Recarregue a página.':'Falha na importação.',r.ok?'ok':'err');}
  catch(e){toast('JSON inválido.','err');}});
const hhmm=iso=>{try{return new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}catch(e){return '?';}};
// F4: aba Impacto — votos, deteccoes, reputacao e alertas que ajudou a criar.
async function loadImpact(){
  const el=$('impact-box');
  if(el)el.innerHTML='<div class="hint">⏳ Carregando…</div>';
  try{
    const j=await (await fetch('/api/impact')).json();
    const d=j.data||{};
    if(!el)return;
    let html='<div class="grid grid-cols-3 gap-2 mb-2">'+
      '<div class="card"><div class="text-[10px] text-slate-500">VOTOS</div><div class="text-lg font-bold">'+Number(d.votos_total||0)+'</div></div>'+
      '<div class="card"><div class="text-[10px] text-slate-500">DETECÇÕES</div><div class="text-lg font-bold text-rose-300">'+Number(d.votos_deteccao||0)+'</div></div>'+
      '<div class="card"><div class="text-[10px] text-slate-500">24H</div><div class="text-lg font-bold text-cyan-300">'+Number(d.votos_24h||0)+'</div></div></div>';
    const rp=d.reputation;
    html+=rp
      ?'<div class="row"><span class="grow">🎯 Precisão <b>'+Number(rp.scientific_agreement||0).toFixed(2)+'</b> · operação <b>'+Number(rp.operational_reliability||0).toFixed(2)+'</b><br><small style="color:var(--dim)">'+Number(rp.tasks_completed||0)+' tasks avaliadas</small></span></div>'
      :'<div class="hint">Sem reputação ainda — vote para estrear.</div>';
    const evs=d.eventos||[];
    if(evs.length){
      html+='<div class="text-xs text-slate-500 mt-2 mb-1">ALERTAS QUE VOCÊ AJUDOU A CRIAR</div>';
      for(const e of evs){
        const hot=e.lifecycle_state==='CONFIRMED';
        html+='<div class="row"><span class="grow">'+(hot?'🔴':'⚪')+' <b>'+esc(e.lifecycle_state||'')+'</b> '+esc(e.event_class||'')+
          ' · conf '+Number(e.calibrated_confidence||0).toFixed(2)+' · '+hhmm(e.created_at)+'</span></div>';
      }
    }else html+='<div class="hint">Nenhum alerta com seu voto ainda.</div>';
    el.innerHTML=html;
  }catch(e){if(el)el.innerHTML='<div class="hint">Falha ao carregar impacto.</div>';}
}
let actSig='';
async function loadActivity(){
  try{
    const j=await (await fetch('/api/activity')).json();
    const evs=(j.data?.events||[]).slice(0,3),vts=(j.data?.votes||[]).slice(0,8);
    const sig=JSON.stringify([evs.map(e=>[e.created_at,e.lifecycle_state,e.calibrated_confidence]),vts.map(v=>[v.created_at,v.operator_id,v.model_score])]);
    if(sig===actSig)return; // sem mudanca: nao toca no DOM
    actSig=sig;
    const el=document.getElementById('feed');
    if(!el)return;
    let html='';
    for(const e of (j.data?.events||[]).slice(0,3)){
      html+='<div class="row"><span class="grow">🔴 '+hhmm(e.created_at)+' · '+esc(e.lifecycle_state||'')+' '+esc(e.event_class||'')+' · conf '+Number(e.calibrated_confidence||0).toFixed(2)+'</span></div>';
    }
    for(const v of (j.data?.votes||[]).slice(0,8)){
      html+='<div class="row"><span class="grow">🛰 '+hhmm(v.created_at)+' · @'+esc(String(v.operator_id||'').slice(0,8))+' · ▦ '+esc(String(v.h3_index||'').slice(0,12))+' · score '+Number(v.model_score||0).toFixed(2)+'<br><small style="color:var(--dim)">'+esc(String(v.observation_id||'').slice(0,26))+'</small></span></div>';
    }
    el.innerHTML=html||'<div class="hint">Sem atividade ainda — execute uma rodada.</div>';
  }catch(e){}
}
async function refresh(){
  const j=await (await fetch('/api/status')).json();
  (j.h3_cells||[]).forEach(h=>adopted.add(h));
  Object.assign(centers,j.h3_centers||{});
  const opEl=document.getElementById('op');if(opEl)opEl.textContent='@'+(j.operator||'?');
  const opSide=$('op-side');if(opSide)opSide.textContent='@'+(j.operator||'?');
  await ensurePolys();
  // HUD por assinatura: so toca no DOM quando algum numero muda (fim do pisca).
  const st=j.stats||{};
  const hudSig=JSON.stringify([j.server_online,st.nodes_on,st.my_nodes_on,st.my_nodes_total,adopted.size,st.celulas_mapeadas,st.eventos_confirmados,!!j.auto?.enabled,j.auto?.next_at]);
  if(hudSig!==lastHud){
    lastHud=hudSig;
    const on=j.server_online;
    $('h-server').innerHTML=on
      ?'<span class="inline-flex items-center gap-1.5 text-emerald-400 font-semibold text-sm"><span class="dot on"></span>ONLINE</span>'
      :'<span class="inline-flex items-center gap-1.5 text-rose-400 font-semibold text-sm"><span class="dot off"></span>OFF</span>';
    $('h-nodes').textContent=st.nodes_on??'…';
    const myOn=st.my_nodes_on??0, myTot=st.my_nodes_total??0;
    $('h-mynodes').innerHTML=myOn+' <small class="text-slate-500 font-normal">Ativos</small>';
    $('h-mynodes').title=myTot+' registrado(s)';
    const ad=adopted.size, mp=st.celulas_mapeadas??0;
    $('h-cells').textContent=ad+' / '+mp;
    $('h-cellbar').style.width=Math.min(100,Math.round(ad/Math.max(mp,1)*100))+'%';
    const evs=st.eventos_confirmados??0;
    $('h-events').innerHTML=evs>0
      ?'<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/60 text-rose-300 text-xs font-bold">'+evs+' Detectado'+(evs>1?'s':'')+'</span>'
      :'<span class="text-slate-500 text-sm">Nenhum</span>';
    $('auto-t').textContent=j.auto?.enabled?'Desligar':'Ligar';
    $('auto-info').textContent=j.auto?.enabled?('Auto ligado · próxima ~ '+j.auto.next_at):'Auto desligado.';
  }
  paintMine();
  const sig=[...adopted].sort().join();
  if(sig!==lastSig){lastSig=sig;renderList();}
  $('upd').textContent='atualizado às '+new Date().toLocaleTimeString('pt-BR');
  loadActivity();
  return j;
}
let lastSig='';
let lastHud='';
setInterval(async()=>{if(document.hidden||runStateRunning)return;try{await refresh();}catch(e){}},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh().catch(()=>{});});
function paintMine(){
  // F3 territorio: adotados aparecem tambem no mapa (sutil) com toggle proprio.
  for(const [h,m] of [...layers]){
    if(!m.mine)continue;
    if(!adopted.has(h)||(view==='map'&&!mineOn)){map.removeLayer(m.poly);layers.delete(h);continue;}
    if(view==='map'){
      if(!map.hasLayer(m.poly))m.poly.addTo(map);
      m.poly.setStyle({color:'#22ff88',weight:1,fillColor:'#22ff88',fillOpacity:0.15});
      continue;
    }
  }
  if(view==='map')return;
  for(const h of adopted){
    if(layers.has(h))continue;
    const ll=boundsCache.get(h);
    if(!ll)continue;
    const poly=L.polygon(ll,{color:'#22ff88',weight:2,fillColor:'#22ff88',fillOpacity:0.4}).addTo(map);
    const infoPopup='<code>'+esc(h)+'</code><br><button data-mhist="'+esc(h)+'">📜 rastro</button>';
    poly.bindPopup(infoPopup);
    const wireHist=ev=>{ev.popup.getElement()?.querySelector('[data-mhist]')?.addEventListener('click',e=>{
      map.closePopup();showHist(e.target.dataset.mhist);});};
    poly.on('popupopen',wireHist);
    poly.on('click',ev=>{if(view==='cells'){L.DomEvent.stopPropagation(ev);tap(h);}});
    layers.set(h,{poly,mine:true});
  }
}
async function ensurePolys(){
  const missing=[...adopted].filter(h=>!boundsCache.has(h)).slice(0,500);
  if(!missing.length)return;
  try{
    const r=await fetch('/api/cells?h='+encodeURIComponent(missing.join(',')));
    if(!r.ok)return;
    const j=await r.json();
    for(const c of (j.data?.cells||[])){
      const ll=c.boundary.map(p=>[p[0],p[1]]);
      boundsCache.set(c.h3,ll);stash(c.h3,ll);
    }
  }catch(e){}
}
async function unadoptMine(h){adopted.delete(h);await save();paintMine();renderList();refresh();}
let evLayer=null, wasRunning=false;
async function loadEvents(){
  try{
    const j=await (await fetch('/api/events')).json();
    if(evLayer)map.removeLayer(evLayer);
    evLayer=L.layerGroup();
    for(const e of (j.data?.events||[])){
      try{const un=e.lifecycle_state==='UNCONFIRMED';
        const col=un?'#94a3b8':'#ff5470';
        L.geoJSON(e.geometry,{style:{color:col,weight:2,dashArray:un?'5 4':null,fillColor:col,fillOpacity:un?0.12:0.3}})
        .bindPopup((un?'<b>⚠ NÃO CONFIRMADO</b> (1 voto)<br>':'<b>'+esc(e.lifecycle_state)+'</b> ')+esc(e.event_class||'')+'<br>conf '+(Number(e.calibrated_confidence||0)).toFixed(2)+'<br><code>'+esc(String(e.id).slice(0,8))+'</code>')
        .addTo(evLayer);}catch(_){}
    }
    evLayer.addTo(map);
  }catch(e){}
}
async function save(){
  const cc={};for(const h of adopted)if(centers[h])cc[h]=centers[h];
  await fetch('/api/aoi',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({h3_cells:[...adopted],h3_centers:cc})});}
function stash(h,ll){if(centers[h]||!ll||!ll.length)return false;
  let s=90,n=-90,w=180,e=-180;for(const p of ll){if(p[0]<s)s=p[0];if(p[0]>n)n=p[0];if(p[1]<w)w=p[1];if(p[1]>e)e=p[1];}
  centers[h]=[(s+n)/2,(w+e)/2];return true;}
function paintGrid(){
  for(const [h,o] of layers){if(o.mine)continue;
    const on=adopted.has(h);
    o.poly.setStyle({color:on?'#22ff88':'#5b7186',fillColor:on?'#22ff88':'#5b7186',fillOpacity:on?0.4:0.12,weight:on?2:1});}
}
async function loadGrid(force){
  if(view!=='cells'&&view!=='map'&&!force)return;
  if(!gridOn){for(const [h,o] of [...layers]){if(!o.mine){map.removeLayer(o.poly);layers.delete(h);}}return;}
  if(map.getZoom()<8){$('msg2').textContent='Aproxime o mapa (zoom 8+) para ver os cinzas.';return;}
  const my=++seq;
  try{
    // janela de no max 2x2 graus: grade sempre completa, sem corte parcial
    const b=map.getBounds();
    const cx=(b.getWest()+b.getEast())/2, cy=(b.getSouth()+b.getNorth())/2;
    const w=Math.max(b.getWest(),cx-1), e=Math.min(b.getEast(),cx+1);
    const s=Math.max(b.getSouth(),cy-1), n=Math.min(b.getNorth(),cy+1);
    const q=w+','+s+','+e+','+n;
    const r=await fetch('/api/h3?bbox='+encodeURIComponent(q));
    if(!r.ok)throw new Error('grade HTTP '+r.status);
    const j=await r.json();if(my!==seq)return;
    const seen=new Set();let nc=false;
    for(const c of (j.data?.cells||[])){
      seen.add(c.h3);
      const ll=c.boundary.map(p=>[p[0],p[1]]);
      boundsCache.set(c.h3,ll);
      if(adopted.has(c.h3)&&stash(c.h3,ll))nc=true;
      if(layers.has(c.h3))continue;
      const poly=L.polygon(ll,{color:'#5b7186',weight:1,fillColor:'#5b7186',fillOpacity:0.12}).addTo(map);
      poly.on('click',ev=>{L.DomEvent.stopPropagation(ev);tap(c.h3);});
      layers.set(c.h3,{poly,mine:false});
    }
    for(const [h,o] of [...layers]){if(!o.mine&&!seen.has(h)){map.removeLayer(o.poly);layers.delete(h);}}
    paintGrid();
    $('msg2').textContent=j.data?.truncated?'Grade parcial — aproxime mais.':'Toque num quadrante para ver info e adotar.';
    if(nc)save();
  }catch(e){if(my===seq)$('msg2').textContent='Falha na grade: '+(e?.message||e);}
}
function centerOf(h){
  if(centers[h])return centers[h];
  const ll=boundsCache.get(h);
  if(!ll||!ll.length)return null;
  let s=90,n=-90,w=180,e=-180;
  for(const p of ll){if(p[0]<s)s=p[0];if(p[0]>n)n=p[0];if(p[1]<w)w=p[1];if(p[1]>e)e=p[1];}
  return [(s+n)/2,(w+e)/2];
}
// Vai ate o quadrante SEM trocar de aba: garante o poligono, voa e destaca em ciano.
async function goTo(h){
  try{
    if(!boundsCache.has(h)){
      const r=await fetch('/api/cells?h='+encodeURIComponent(h));
      const j=await r.json();
      const c=(j.data?.cells||[])[0];
      if(c){const ll=c.boundary.map(p=>[p[0],p[1]]);boundsCache.set(h,ll);if(stash(h,ll))save();}
    }
    if(adopted.has(h)&&!layers.has(h)){
      const ll=boundsCache.get(h);
      if(ll){const poly=L.polygon(ll,{color:'#22ff88',weight:2,fillColor:'#22ff88',fillOpacity:0.4}).addTo(map);
        layers.set(h,{poly,mine:true});}
    }
  }catch(e){}
  const c=centerOf(h);
  if(!c){msg('Sem posição para '+short(h)+' — abra a grade sobre a região.');return;}
  map.flyTo(c,11,{duration:1.2});
  setTimeout(()=>{const o=layers.get(h);
    if(o){o.poly.setStyle({color:'#38e1ff',weight:4});if(o.poly.bringToFront)o.poly.bringToFront();}
    setTimeout(()=>{paintMine();paintGrid();},2600);},1350);
}
// P1: tap SELECIONA (popup de info + ação explícita). Nunca adota/abandona
// direto: toque acidental não pode mudar monitoramento.
async function tap(h){
  if(view!=='cells')return;
  const mine=adopted.has(h);
  const c=centerOf(h);
  const html='<code>'+esc(short12(h))+'</code><br>'+
    '<small>'+(c?c[0].toFixed(3)+','+c[1].toFixed(3):'sem posição')+' · '+(mine?'adotado':'não adotado')+'</small><br>'+
    (mine?'<button data-tap-un>Abandonar</button> ':'<button data-tap-ad>➕ Adotar</button> ')+
    '<button data-tap-hist>📜 rastro</button>';
  const o=layers.get(h);
  const open=()=>{const root=document.querySelector('.leaflet-popup-content');
    const ad=root?.querySelector('[data-tap-ad]'),un=root?.querySelector('[data-tap-un]'),hi=root?.querySelector('[data-tap-hist]');
    if(ad)ad.addEventListener('click',async()=>{adopted.add(h);stash(h,boundsCache.get(h));await save();paintGrid();refresh();map.closePopup();toast('Quadrante adotado.','ok');});
    if(un)un.addEventListener('click',async()=>{await unadoptMine(h);map.closePopup();toast('Quadrante abandonado.','warn');});
    if(hi)hi.addEventListener('click',()=>{map.closePopup();showHist(h);});};
  if(o){o.poly.bindPopup(html).openPopup();open();}
  else{map.openPopup(html,c||map.getCenter());open();}
}
map.on('moveend',()=>{clearTimeout(deb);deb=setTimeout(()=>{if(view==='cells'||view==='map')loadGrid();},300);
  clearTimeout(photoDeb);photoDeb=setTimeout(()=>{if(photoOn)loadPhotoOverlays();},800);});
document.getElementById('geo').onclick=()=>{navigator.geolocation?.getCurrentPosition(
  p=>map.setView([p.coords.latitude,p.coords.longitude],9),
  ()=>msg('GPS indisponível. Navegue manualmente.'));};
// P3: lista com busca + multisselecao + lote. Coordenadas sao contexto local
// gratuito (sem request); badges de servidor por linha foram descartados
// (1 request/linha x 500 = anti-economico; fica para a F5).
let listFilter='',listSel=new Set();
function renderList(){
  const el=$('list');
  if(adopted.size===0){el.innerHTML='<div class="hint">Nenhum adotado. Vá em ➕ Adotar.</div>';return;}
  for(const h of [...listSel])if(!adopted.has(h))listSel.delete(h);
  const q=listFilter.trim().toLowerCase();
  const rows=[...adopted].filter(h=>!q||h.toLowerCase().includes(q));
  let html='<div class="row"><span class="grow">'+
    '<input id="list-q" type="search" placeholder="filtrar…" value="'+esc(listFilter)+'" aria-label="Filtrar quadrantes" style="width:100%;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:8px;font-size:13px;color:#e2e8f0">'+
    '</span><button class="act" id="list-all" title="Selecionar visíveis">✓</button></div>';
  if(!rows.length)html+='<div class="hint">Nenhum registro encontrado para “'+esc(listFilter)+'”.</div>';
  html+=rows.map(h=>{
    const c=centerOf(h);
    const co=c?(' <small style="color:var(--dim)">'+c[0].toFixed(2)+','+c[1].toFixed(2)+'</small>'):'';
    const on=listSel.has(h);
    return '<div class="row"><input type="checkbox" data-sel="'+esc(h)+'" aria-label="Selecionar '+esc(short12(h))+'"'+(on?' checked':'')+' style="width:20px;height:20px">'+
    '<span class="grow"><code>'+esc(short12(h))+'</code>'+co+'</span>'+
    '<button class="act" data-hist="'+esc(h)+'">📜</button>'+
    (centers[h]?'<button class="act" data-go="'+esc(h)+'">📍 ver</button>':'<span class="pill">sem posição</span>')+
    '<button class="danger" data-un="'+esc(h)+'">Abandonar</button></div>';}).join('');
  if(listSel.size)html+='<div class="row"><span class="grow"><b>'+listSel.size+' selecionado(s)</b></span>'+
    '<button class="danger" id="bulk-un">Abandonar</button><button class="act" id="bulk-clear">Limpar seleção</button></div>';
  const active=document.activeElement?.id;
  const caret=(active==='list-q')?$('list-q')?.selectionStart:null;
  el.innerHTML=html;
  const qi=$('list-q');
  qi.addEventListener('input',()=>{listFilter=qi.value;renderList();});
  if(active==='list-q'){const nq=$('list-q');nq.focus();try{nq.setSelectionRange(caret,caret);}catch(e){}}
  el.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>goTo(b.dataset.go));
  el.querySelectorAll('[data-hist]').forEach(b=>b.onclick=()=>showHist(b.dataset.hist));
  el.querySelectorAll('[data-un]').forEach(b=>b.onclick=async()=>{
    adopted.delete(b.dataset.un);listSel.delete(b.dataset.un);await save();paintMine();renderList();refresh();});
  el.querySelectorAll('[data-sel]').forEach(b=>b.onchange=()=>{
    if(b.checked)listSel.add(b.dataset.sel);else listSel.delete(b.dataset.sel);renderList();});
  const all=$('list-all');
  if(all)all.onclick=()=>{const vis=rows.filter(h=>!listSel.has(h));const add=vis.length>0;
    for(const h of rows){if(add)listSel.add(h);else listSel.delete(h);}renderList();};
  const bu=$('bulk-un');
  if(bu)bu.onclick=async()=>{
    if(!await confirmModal('Abandonar '+listSel.size+' selecionados?','Saem do monitoramento deste nó.'))return;
    for(const h of [...listSel])adopted.delete(h);
    listSel.clear();await save();paintMine();renderList();refresh();toast('Selecionados abandonados.','warn');};
  const bc=$('bulk-clear');
  if(bc)bc.onclick=()=>{listSel.clear();renderList();};
}
async function showHist(h){
  const el=$('hist');
  el.innerHTML='<div class="hint">⏳ Carregando rastro de '+short12(h)+'…</div>';
  try{
    const j=await (await fetch('/api/history?h='+encodeURIComponent(h))).json();
    const d=j.data||{tasks:[],votes:[],events:[]};
    let html='<div class="row"><span class="grow"><b>📜 RASTRO ▦ '+short12(h)+'</b></span>'+
      '<button class="act" id="hist-back">✖</button></div>';
    if(!d.tasks.length)html+='<div class="hint">Sem tasks neste quadrante ainda.</div>';
    for(const t of d.tasks){
      const obs=String(t.observation_id||'');const base=String(t.baseline_scene||'');
      html+='<div class="row"><span class="grow">📡 '+esc(obs.slice(4,22))+' → base '+esc(base.slice(4,22))+
        '<br><small style="color:var(--dim)">'+esc(t.event_class)+' · '+esc(t.status)+' '+Number(t.completed_count||0)+'/'+Number(t.redundancy_required||0)+' votos · '+hhmm(t.created_at)+'</small>'+
        '<span data-evslot="'+esc(String(t.id))+'"></span></span></div>';
      for(const v of d.votes.filter(x=>x.task_id===t.id)){
        html+='<div class="row"><span class="grow" style="padding-left:14px">🗳 @'+esc(String(v.operator_id).slice(0,8))+
          ' · score '+Number(v.model_score).toFixed(2)+' · céu '+Math.round((v.valid_frac||0)*100)+'% · '+hhmm(v.created_at)+'</span></div>';
      }
    }
    for(const e of d.events){
      html+='<div class="row"><span class="grow">🔴 '+esc(e.lifecycle_state||'')+' '+esc(e.event_class||'')+
        ' · conf '+Number(e.calibrated_confidence||0).toFixed(2)+' · IoU '+Number(e.spatial_agreement_iou||0).toFixed(2)+
        ' · '+hhmm(e.created_at)+'</span></div>';
    }
    // F1 visual: pares antes x depois votados por este no (thumbs NDVI locais).
    let pairs=[];
    try{
      const tj=await (await fetch('/api/thumbs?h='+encodeURIComponent(h))).json();
      pairs=(tj.data||[]).filter(x=>x.t0&&x.base);
      if(pairs.length){
        html+='<div class="row"><span class="grow"><b>🛰 ANTES × DEPOIS</b><br><small style="color:var(--dim)">verde=mata · vermelho=corte · passe o mouse para ver o antes</small></span></div>';
        for(const p of pairs.slice(0,3)){
          html+='<div class="row"><span class="grow"><small style="color:var(--dim)">voto '+esc(String(p.task).slice(0,8))+'</small>'+
            '<button class="baswap" aria-pressed="false" aria-label="Alternar antes e depois" style="position:relative;display:block;width:100%;line-height:0;border-radius:8px;overflow:hidden;border:1px solid #1e293b;background:none;padding:0;cursor:pointer">'+
            '<img loading="lazy" src="'+esc(p.base)+'" style="width:100%;display:block" alt="antes">'+
            '<img loading="lazy" src="'+esc(p.t0)+'" class="top" style="position:absolute;inset:0;width:100%;height:100%" alt="agora">'+
            '<span style="position:absolute;top:4px;left:4px;font-size:10px;background:rgba(2,6,23,.75);color:#00f2fe;padding:1px 6px;border-radius:99px">AGORA</span>'+
            '</button></span></div>';
        }
        // F2: fita temporal — cada passagem com nota do voto (clique amplia).
        const strip=[...pairs].reverse();
        html+='<div class="row"><span class="grow"><b>🎞 LINHA DO TEMPO</b><br><small style="color:var(--dim)">cada foto = uma passagem votada · clique amplia</small></span></div>';
        html+='<div class="row"><div style="display:flex;gap:8px;overflow-x:auto;padding:4px 0">';
        for(const p of strip){
          const v=(d.votes||[]).find(x=>x.task_id===p.task)||{};
          const sc=(v.model_score!=null)?Number(v.model_score).toFixed(2):'?';
          const when=new Date(p.mtime||Date.now()).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
          const dot=Number(v.model_score||0)>=0.1?'🔴':'⚪';
          html+='<a href="'+esc(p.t0)+'" target="_blank" rel="noopener" style="flex:0 0 auto;width:104px;text-decoration:none">'+
            '<img loading="lazy" src="'+esc(p.t0)+'" style="width:104px;height:104px;object-fit:cover;border-radius:8px;border:1px solid #1e293b" alt="passagem">'+
            '<div style="font-size:10px;color:var(--dim);text-align:center">'+dot+' '+when+' · '+sc+'</div></a>';
        }
        html+='</div></div>';
      }
    }catch(e2){/* sem thumbs: timeline segue */}
    if(!pairs.length)html+='<div class="hint">Sem fotos locais ainda — vote neste quadrante para gerar o antes × depois.</div>';
    el.innerHTML=html;
    el.querySelectorAll('.baswap').forEach(b=>b.addEventListener('click',()=>{
      const off=b.classList.toggle('off');b.setAttribute('aria-pressed',off?'true':'false');}));
    // F5: fotos da rede (outros nos) por task com deteccao — preenche os slots.
    for(const t of d.tasks){
      if(!(d.votes||[]).some(x=>x.task_id===t.id&&Number(x.model_score||0)>=0.1))continue;
      fetch('/api/evidencelist?task='+encodeURIComponent(t.id)).then(r=>r.json()).then(ej=>{
        const rows=(ej.data||[]).filter(x=>x.hash&&/^[0-9a-f]{64}$/.test(x.hash));
        if(!rows.length)return;
        const slot=el.querySelector('[data-evslot="'+String(t.id).replace(/[^0-9a-f-]/g,'')+'"]');
        if(!slot)return;
        const byKind={};for(const r of rows)if(!byKind[r.kind])byKind[r.kind]=r;
        if(!byKind.t0||!byKind.base)return;
        const op=esc(String(byKind.t0.operator_id||'').slice(0,8));
        slot.innerHTML='<br><a href="/api/evidence/'+byKind.t0.hash+'" target="_blank" rel="noopener" style="font-size:11px;color:#00f2fe">📷 fotos da rede (@'+op+')</a> '+
          '<button data-evshow="'+esc(String(t.id))+'" style="font-size:11px">ver aqui</button>';
        slot.querySelector('[data-evshow]')?.addEventListener('click',ev=>{
          ev.preventDefault();
          const ex=slot.querySelector('[data-evexpand]');
          if(ex){ex.remove();return;}
          const dv=document.createElement('div');
          dv.setAttribute('data-evexpand','1');
          dv.innerHTML='<div class="baswap" style="position:relative;line-height:0;border-radius:8px;overflow:hidden;border:1px solid #1e293b;margin-top:4px">'+
            '<img loading="lazy" src="/api/evidence/'+byKind.base.hash+'" style="width:100%;display:block" alt="antes (rede)">'+
            '<img loading="lazy" src="/api/evidence/'+byKind.t0.hash+'" class="top" style="position:absolute;inset:0;width:100%;height:100%" alt="agora (rede)"></div>'+
            '<small style="color:var(--dim)">passe o mouse/clique: antes × agora · foto de @'+op+'</small>';
          slot.appendChild(dv);
          dv.querySelector('.baswap')?.addEventListener('click',()=>{
            const bb=dv.querySelector('.baswap');const off=bb.classList.toggle('off');bb.setAttribute('aria-pressed',off?'true':'false');});
        });
      }).catch(()=>{});
    }
    $('hist-back').onclick=()=>{el.innerHTML='';};
    icons();
  }catch(e){el.innerHTML='<div class="hint">Falha no rastro: '+e+'</div>';}
}
$('adopt-all').onclick=()=>busy('adopt-all',async()=>{
  const cands=[...layers].filter(([h,o])=>!o.mine&&!adopted.has(h)&&adopted.size<500);
  if(!cands.length){toast('Nada novo nesta vista.','warn');return;}
  if(!await confirmModal('Adotar '+cands.length+' quadrantes?','Os quadrantes cinzas desta vista passam a ser monitorados e votados.'))return;
  let n=0;for(const [h] of cands){if(adopted.size>=500)break;adopted.add(h);stash(h,boundsCache.get(h));n++;}
  await save();paintGrid();refresh();toast(n+' adotado(s) desta vista (max 500).','ok');});
$('adopt-clear').onclick=async()=>{
  if(!adopted.size){toast('Nada para abandonar.','warn');return;}
  if(!await confirmModal('Abandonar '+adopted.size+' quadrantes?','Todos deixam de ser monitorados por este nó.'))return;
  adopted.clear();await save();paintGrid();renderList();refresh();toast('Quadrantes abandonados.','warn');};
async function startRun(){
  if(runStateRunning)return;
  const btns=[...document.querySelectorAll('button.go')];
  btns.forEach(b=>b.disabled=true);
  try{
    const r=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    if(r.status===409){toast('Já tem rodada em andamento — acompanhe em ☰ Tarefas.','warn');show('tasks');return;}
    if(!r.ok){toast('Falha ao iniciar rodada.','err');return;}
    show('tasks');refreshRun();
  }finally{document.querySelectorAll('button.go').forEach(b=>b.disabled=false);}
}
let runStateRunning=false;
$('run1').onclick=startRun;$('run2').onclick=startRun;$('run3').onclick=startRun;
// Itens da rodada entram por append (nunca reescreve o que ja esta na tela).
let runSeen=0,runSeenStart='';
function runRowHtml(it){
  const cls=it.phase==='erro'?'err':it.phase==='pulada'?'skip':(it.result==='reported'||it.created?'ok':'run');
  const nm=it.h3?('▦ '+short12(it.h3)):('task '+esc(String(it.taskId||'').slice(0,8)));
  let d=esc(it.phase);
  if(it.observation)d+=' · '+esc(String(it.observation).slice(0,20));
  if(it.score!=null)d+=' · score '+Number(it.score).toFixed(2);
  if(it.result==='reported')d+=' → '+esc(it.decision||'?')+(it.eventId?' · ev '+esc(String(it.eventId).slice(0,8)):' · 1/2 votos');
  if(it.error)d+=' · '+esc(it.error);
  if(it.ms!=null)d+=' · '+(it.ms/1000).toFixed(1)+'s';
  return '<div class="row"><span class="grow">'+esc(nm)+' — '+d+'</span><span class="pill '+cls+'">'+esc(it.phase)+'</span></div>';
}
async function refreshRun(){
  const j=await (await fetch('/api/run/state')).json();const s=j.state;const pg=j.progress||{};
  runStateRunning=!!s.running;
  const box=$('runbox');
  if(s.startedAt!==runSeenStart){runSeenStart=s.startedAt;runSeen=0;box.innerHTML='';}
  // Linha de progresso: feitos/total + ETA (ensures) e ritmo (votos). Uma so,
  // atualizada no lugar — sem duplicar "Estado".
  const mmss=ms=>{const t=Math.max(0,Math.round(ms/1000));return Math.floor(t/60)+':'+String(t%60).padStart(2,'0');};
  const eT=Number(pg.ensuresTotal||0),eD=Number(pg.ensuresDone||0);
  const vD=Number(pg.votesDone||0),fD=Number(pg.failsDone||0);
  const el=Number(pg.elapsedMs||0);
  let pgTxt='parado';
  let pct=100;
  if(s.running){
    if(eD<eT){
      const avg=Number(pg.avgEnsureMs||0);
      const rem=Math.max(0,eT-eD);
      const eta=avg?(' · ~'+mmss(rem*avg/4)+' restantes'):'';
      pct=eT?Math.round(eD/eT*100):100;
      pgTxt='garantindo tasks '+eD+'/'+eT+eta;
    }else{
      const rate=el>15000?((vD+fD)/(el/60000)):0;
      pgTxt=vD+' voto(s) · '+fD+' pulada(s)'+(rate?' · '+rate.toFixed(1)+'/min':'')+' · '+mmss(el)+' decorridos';
      pct=100;
    }
  }else if(s.summary){
    pgTxt=vD+' voto(s) · '+fD+' pulada(s) · '+mmss(el)+' no total';
  }
  let html='';
  if(runSeen===0){
    html+='<div class="row" data-k="st"><span class="grow"><b data-k="pg">'+esc(pgTxt)+'</b>'+
      '<div style="height:6px;border-radius:99px;background:#1e293b;margin-top:6px"><div data-k="bar" style="height:6px;border-radius:99px;background:#00f2fe;width:'+pct+'%"></div></div></span>'+
      (s.running?'<span class="pill run"><span class="spin">◌</span> RODANDO</span>':'<span class="pill ok">PARADO</span>')+'</div>';
  }else{
    const st=box.querySelector('[data-k="st"] .pill');
    if(st)st.outerHTML=s.running?'<span class="pill run"><span class="spin">◌</span> RODANDO</span>':'<span class="pill ok">PARADO</span>';
    const tx=box.querySelector('[data-k="pg"]');
    if(tx)tx.textContent=pgTxt;
    const bar=box.querySelector('[data-k="bar"]');
    if(bar)bar.style.width=pct+'%';
  }
  if(s.running&&s.current){
    let cur=box.querySelector('[data-k="cur"] span');
    if(!cur){html+='<div class="row" data-k="cur"><span class="grow">⏳ '+esc(s.current)+'</span></div>';}
    else cur.textContent='⏳ '+s.current;
  }
  const items=s.items||[];
  const fresh=items.slice(runSeen);
  for(const it of fresh.slice(-150))html+=runRowHtml(it);
  runSeen=items.length;
  if(s.summary){
    let sm=box.querySelector('[data-k="sum"] span');
    if(!sm)html+='<div class="row" data-k="sum"><span class="grow">'+esc(s.summary)+'</span></div>';
    else sm.textContent=s.summary;
  }
  if(html){const t=document.createElement('div');t.innerHTML=html;while(t.firstChild)box.appendChild(t.firstChild);}
  if(s.running&&!poll)poll=setInterval(refreshRun,2000);
  if(!s.running&&poll){clearInterval(poll);poll=null;}
  if(wasRunning&&!s.running){if(evOn)loadEvents();refresh();if(photoOn)loadPhotoOverlays();}
  wasRunning=!!s.running;
}
$('auto-t').onclick=async()=>{
  const j=await (await fetch('/api/status')).json();
  const en=!j.auto?.enabled;
  const minutes=Number($('auto-min').value||30);
  await fetch('/api/auto',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:en,minutes})});
  refresh();
};
icons();
show('map');
refresh().then(()=>{if(evOn)loadEvents();});
</script></body></html>`;
}

if (process.argv[1]?.endsWith('server.js')) {
  const app = await buildLocalUi(process.env.CONFIG_DIR ?? 'config');
  await app.listen({ port: Number(process.env.LOCAL_PORT ?? 3000), host: '0.0.0.0' });
  console.log('node ui :3000');
}
