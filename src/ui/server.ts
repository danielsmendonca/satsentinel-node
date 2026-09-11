/** Central de comando local :3000 — HUD, adotar, quadrantes, tarefas realtime + auto-run. */
import Fastify from 'fastify';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrCreate, exportPairing, importPairing, configPath } from '../identity/operator.js';
import { runOnceDetailed, getSession, type RunDetail } from '../runner.js';

interface RunItem {
  h3?: string; phase: string; ms?: number; taskId?: string; observation?: string; score?: number;
  created?: boolean; result?: string; eventId?: string | null; decision?: string; error?: string;
}
interface RunState {
  running: boolean; startedAt: string | null; finishedAt: string | null;
  current: string | null; items: RunItem[]; summary: string | null;
}
const idleState = (): RunState => ({ running: false, startedAt: null, finishedAt: null, current: null, items: [], summary: null });
let runState: RunState = idleState();
let lastRun: { at: string; summary: string } | null = null;
let autoTimer: NodeJS.Timeout | null = null;
let autoNextAt: string | null = null;

function readCfg(dir: string) {
  return JSON.parse(readFileSync(configPath(dir), 'utf8')) as Record<string, unknown>;
}
function writeCfg(dir: string, patch: Record<string, unknown>) {
  const cp = configPath(dir);
  const full = JSON.parse(readFileSync(cp, 'utf8')) as Record<string, unknown>;
  writeFileSync(cp, JSON.stringify({ ...full, ...patch }, null, 2));
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
    runState.current = `garantindo tasks (${lote.length} quadrantes, x4 paralelo)…`;
    await mapLimit(lote, 4, async (h) => {
      runState.current = `garantindo tasks (${runState.items.length}/${lote.length})…`;
      const item: RunItem = { h3: h, phase: 'ensure' };
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
          phase: d.status === 'idle' ? 'fila vazia' : d.status === 'failed' ? 'falha' : 'voto',
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
    const failInfo = falhas > 0 ? ` · ${falhas} falha(s) honestas` : '';
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
  // GET /api/thumb?h=<h3>&task=<uuid>&kind=t0|base -> image/png
  const thumbFile = (dir: string, h: string, task: string, kind: string): string | null => {
    if (!/^[0-9a-f]{15}$/.test(h) || !/^[0-9a-f-]{8,36}$/.test(task) || (kind !== 't0' && kind !== 'base')) return null;
    if (task.includes('..') || h.includes('..')) return null;
    return join(dir, 'thumbs', `${h}_${task}_${kind}.png`);
  };
  app.get('/api/thumbs', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!q.h || !/^[0-9a-f]{15}$/.test(q.h)) return reply.code(400).send({ error: 'h invalido' });
    let files: string[] = [];
    try { files = readdirSync(join(configDir, 'thumbs')).filter((f) => f.startsWith(`${q.h}_`) && f.endsWith('.png')); } catch { return { data: [] }; }
    const byTask = new Map<string, { task: string; t0?: string; base?: string; mtime: number }>();
    for (const f of files) {
      const m = f.match(/^([0-9a-f]{15})_([0-9a-f-]{8,36})_(t0|base)\.png$/);
      if (!m) continue;
      const [, , task, kind] = m;
      let e = byTask.get(task);
      if (!e) { e = { task, mtime: 0 }; byTask.set(task, e); }
      try { e.mtime = Math.max(e.mtime, statSync(join(configDir, 'thumbs', f)).mtimeMs); } catch { /* some */ }
      const url = `/api/thumb?h=${q.h}&task=${task}&kind=${kind}`;
      if (kind === 't0') e.t0 = url; else e.base = url;
    }
    const list = [...byTask.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 6);
    return { data: list };
  });
  app.get('/api/thumb', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const fp = thumbFile(configDir, q.h ?? '', q.task ?? '', q.kind ?? '');
    if (!fp) return reply.code(400).send({ error: 'parametros invalidos' });
    let buf: Buffer;
    try { buf = readFileSync(fp); } catch { return reply.code(404).send({ error: 'thumb nao encontrada' }); }
    if (buf.length < 20 || buf[0] !== 137 || buf[1] !== 80) return reply.code(404).send({ error: 'thumb invalida' });
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
  app.get('/api/run/state', async () => ({ ok: true, state: runState }));
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
.row code{font-size:12px;color:#00f2fe}
.row .grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hint{font-size:12px;color:#64748b}
.pill{font-size:11px;border:1px solid #334155;border-radius:9999px;padding:2px 9px;color:#94a3b8;white-space:nowrap}
.pill.ok{color:#34d399;border-color:#34d399}.pill.run{color:#fbbf24;border-color:#fbbf24}.pill.err{color:#f87171;border-color:#f87171}
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
<button id="ly-temp" title="Temperatura (Landsat)" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 btn-glow"><i data-lucide="thermometer" class="w-5 h-5"></i></button>
<button id="ly-veg" title="Vigor NDVI (Sentinel-2)" class="p-2.5 rounded-xl bg-slate-900/80 backdrop-blur border border-slate-700 text-slate-400 btn-glow"><i data-lucide="leaf" class="w-5 h-5"></i></button>
</div>
<div id="temp-legend" style="display:none" class="absolute bottom-2 right-2 z-[1100] rounded-xl bg-slate-950/90 backdrop-blur border border-slate-800/80 px-2.5 py-2 text-[10px] text-slate-400">
<div id="temp-legend-title" class="mb-1 font-semibold tracking-wider">LST °C</div>
<div class="flex items-center gap-1"><span id="temp-legend-lo">10</span><div id="temp-legend-bar" class="w-24 h-2 rounded-full" style="background:linear-gradient(90deg,#3b82f6,#22c55e,#facc15,#f97316,#ef4444)"></div><span id="temp-legend-hi">45+</span></div>
</div>
<aside id="panel" class="absolute top-2 right-14 bottom-2 w-[min(380px,90vw)] z-[1100] overflow-y-auto rounded-xl bg-slate-950/90 backdrop-blur-md border border-slate-800/80 p-3" style="display:none">
<section id="v-cells">
<div class="text-xs text-slate-400 mb-2">Toque nos <b>cinzas</b> para <b class="text-emerald-400">adotar</b>, nos verdes para soltar. Zoom 8+.</div>
<div class="flex gap-2 mb-2"><button id="adopt-all" class="flex-1 text-sm px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 btn-glow">➕ Visíveis</button>
<button id="adopt-clear" class="text-sm px-3 py-2 rounded-lg border border-rose-500/60 text-rose-300">Limpar</button></div>
<div id="msg2" class="text-xs text-slate-500 mb-2"></div>
<div id="hist"></div>
<div id="list"></div>
</section>
<section id="v-tasks" style="display:none">
<div class="flex items-center gap-2 text-sm bg-slate-900/60 border border-slate-800 rounded-xl p-2.5 mb-2"><span class="flex-1">Automático <span class="text-slate-500 text-xs">(vigia + vota sozinho)</span></span>
<select id="auto-min" class="bg-slate-800 border border-slate-700 rounded-lg p-1.5 text-sm"><option value="15">15m</option><option value="30" selected>30m</option><option value="60">60m</option><option value="120">120m</option></select>
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
<section id="v-config" style="display:none">
<div class="text-xs text-slate-500 mb-1">OPERADOR</div><div id="cfg-op" class="font-mono text-sm text-cyan-300 mb-3"></div>
<div class="text-xs text-slate-500 mb-1">APELIDO DO NÓ</div>
<div class="flex gap-2 mb-3"><input id="cfg-alias" maxlength="40" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg p-2 text-sm"><button id="cfg-save-alias" class="text-sm px-3 rounded-lg bg-slate-800 border border-slate-700 btn-glow">OK</button></div>
<div class="text-xs text-slate-500 mb-1">SERVIDOR</div>
<div class="flex gap-2 mb-3"><input id="cfg-server" maxlength="200" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg p-2 text-sm font-mono"><button id="cfg-save-server" class="text-sm px-3 rounded-lg bg-slate-800 border border-slate-700 btn-glow">OK</button></div>
<div class="text-xs text-slate-500 mb-1">EMPARELHAMENTO</div>
<div class="flex gap-2 mb-2"><a href="/pairing/export" download="operator.key" class="text-sm px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 btn-glow"><i data-lucide="download" class="w-4 h-4 inline"></i> Exportar chave</a></div>
<textarea id="cfg-import" rows="3" placeholder="Cole o operator.key aqui para importar" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs font-mono mb-2"></textarea>
<button id="cfg-do-import" class="text-sm px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 btn-glow mb-3"><i data-lucide="upload" class="w-4 h-4 inline"></i> Importar</button>
<div class="text-xs text-slate-500 mb-1">ZONA DE PERIGO</div>
<button id="cfg-clear" class="text-sm px-3 py-2 rounded-lg border border-rose-500/60 text-rose-300">Abandonar todos os quadrantes</button>
<div id="cfg-msg" class="text-xs text-slate-500 mt-2"></div>
</section>
</aside>
<div id="console" class="absolute left-2 right-2 md:right-auto md:w-[430px] bottom-2 z-[1100] rounded-xl bg-slate-950/90 backdrop-blur-md border border-slate-800/80">
<div class="flex items-center gap-2 px-3 pt-2 text-xs text-slate-400"><span class="text-cyan-300">◉ CONSOLE</span>
<span id="msg" class="flex-1 truncate"></span>
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
  for(const s of ['map','cells','tasks','logs','config']){
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
  if(v==='map'){ensurePolys().then(paintMine);if(evOn)loadEvents();}
  setTimeout(()=>map.invalidateSize(),50);}
for(const s of ['map','cells','tasks','logs','config'])$('n-'+s).onclick=()=>show(s);
$('side-toggle').onclick=()=>{$('side').classList.toggle('open');setTimeout(()=>map.invalidateSize(),320);};
function icons(){try{if(window.lucide)lucide.createIcons();}catch(e){}}
// --- camadas do mapa ---
let satLayer=null, gridOn=true, evOn=true, logPoll=null;
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
  return (layer==='NDVI'?'🌿 NDVI '+v.toFixed(2):'🌡 '+v.toFixed(1)+' °C')+'<br>'+c.h3_index+'<br>'+c.votes+' voto(s)';
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
function lineHtml(e){
  if(e.method){const c=e.status>=500?'log-err':e.status>=400?'log-warn':'log-ok';
    return '<div><span class="log-dim">'+esc(String(e.t).slice(11,19))+'</span> <span class="'+c+'">'+esc(e.method)+' '+esc(e.url)+' → '+e.status+'</span></div>';}
  const c=e.level==='err'?'log-err':e.level==='warn'?'log-warn':e.level==='ok'?'log-ok':'';
  return '<div><span class="log-dim">'+esc(String(e.t).slice(11,19))+'</span> <span class="'+c+'">'+esc(e.msg)+'</span></div>';}
async function loadLogs(force){
  try{
    const j=await (await fetch('/api/logs?src='+logSrc+'&n=80')).json();
    const el=$('logbox');if(!el)return;
    el.innerHTML=((j.data||[]).map(lineHtml).join(''))||'<div class="log-dim">sem logs</div>';
    el.scrollTop=el.scrollHeight;
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
$('cfg-save-alias').onclick=async()=>{await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({node_alias:$('cfg-alias').value})});$('cfg-msg').textContent='Salvo.';refresh();};
$('cfg-save-server').onclick=async()=>{const r=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({server_url:$('cfg-server').value})});$('cfg-msg').textContent=r.ok?'Salvo.':'URL inválida.';refresh();};
$('cfg-do-import').onclick=async()=>{try{const v=JSON.parse($('cfg-import').value);
    const r=await fetch('/api/pairing/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)});
    $('cfg-msg').textContent=r.ok?'Chave importada. Recarregue a página.':'Falha na importação.';}
  catch(e){$('cfg-msg').textContent='JSON inválido.';}};
$('cfg-clear').onclick=async()=>{if(!confirm('Abandonar TODOS os quadrantes?'))return;
  adopted.clear();await save();paintMine();renderList();refresh();$('cfg-msg').textContent='Todos abandonados.';};
const hhmm=iso=>{try{return new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}catch(e){return '?';}};
async function loadActivity(){
  try{
    const j=await (await fetch('/api/activity')).json();
    const el=document.getElementById('feed');
    if(!el)return;
    let html='';
    for(const e of (j.data?.events||[]).slice(0,3)){
      html+='<div class="row"><span class="grow">🔴 '+hhmm(e.created_at)+' · '+(e.lifecycle_state||'')+' '+(e.event_class||'')+' · conf '+Number(e.calibrated_confidence||0).toFixed(2)+'</span></div>';
    }
    for(const v of (j.data?.votes||[]).slice(0,8)){
      html+='<div class="row"><span class="grow">🛰 '+hhmm(v.created_at)+' · @'+String(v.operator_id||'').slice(0,8)+' · ▦ '+String(v.h3_index||'').slice(0,12)+' · score '+Number(v.model_score||0).toFixed(2)+'<br><small style="color:var(--dim)">'+String(v.observation_id||'').slice(0,26)+'</small></span></div>';
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
  const on=j.server_online;
  $('h-server').innerHTML=on
    ?'<span class="inline-flex items-center gap-1.5 text-emerald-400 font-semibold text-sm"><span class="dot on"></span>ONLINE</span>'
    :'<span class="inline-flex items-center gap-1.5 text-rose-400 font-semibold text-sm"><span class="dot off"></span>OFF</span>';
  const st=j.stats||{};
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
  paintMine();
  const sig=[...adopted].sort().join();
  if(sig!==lastSig){lastSig=sig;renderList();}
  $('upd').textContent='atualizado às '+new Date().toLocaleTimeString('pt-BR');
  loadActivity();
  return j;
}
let lastSig='';
setInterval(async()=>{if(document.hidden||runStateRunning)return;try{await refresh();}catch(e){}},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh().catch(()=>{});});
function paintMine(){
  // mapa limpo: adotados só aparecem na aba Quadrantes; no mapa só eventos
  for(const [h,m] of [...layers]){if(m.mine&&(!adopted.has(h)||view==='map')){map.removeLayer(m.poly);layers.delete(h);}}
  if(view==='map')return;
  for(const h of adopted){
    if(layers.has(h))continue;
    const ll=boundsCache.get(h);
    if(!ll)continue;
    const poly=L.polygon(ll,{color:'#22ff88',weight:2,fillColor:'#22ff88',fillOpacity:0.4}).addTo(map);
    poly.bindPopup('<code>'+h+'</code><br><button onclick="unadopt(\\''+h+'\\')">Abandonar</button>');
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
window.unadopt=async h=>{adopted.delete(h);await save();paintMine();renderList();refresh();};
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
        .bindPopup((un?'<b>⚠ NÃO CONFIRMADO</b> (1 voto)<br>':'<b>'+e.lifecycle_state+'</b> ')+(e.event_class||'')+'<br>conf '+(Number(e.calibrated_confidence||0)).toFixed(2)+'<br><code>'+String(e.id).slice(0,8)+'</code>')
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
    $('msg2').textContent=j.data?.truncated?'Grade parcial — aproxime mais.':'Toque nos cinzas para adotar, nos verdes para soltar.';
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
async function tap(h){
  if(view!=='cells')return;
  if(!adopted.has(h)){adopted.add(h);stash(h,boundsCache.get(h));}
  else adopted.delete(h);
  await save();paintGrid();refresh();
}
map.on('moveend',()=>{clearTimeout(deb);deb=setTimeout(()=>{if(view==='cells'||view==='map')loadGrid();},300);});
document.getElementById('geo').onclick=()=>{navigator.geolocation?.getCurrentPosition(
  p=>map.setView([p.coords.latitude,p.coords.longitude],9),
  ()=>msg('GPS indisponível. Navegue manualmente.'));};
function renderList(){
  const el=$('list');
  if(adopted.size===0){el.innerHTML='<div class="hint">Nenhum adotado. Vá em ➕ Adotar.</div>';return;}
  el.innerHTML=[...adopted].map(h=>'<div class="row"><span class="grow"><code>'+h+'</code></span>'+
    '<button class="act" data-hist="'+h+'">📜</button>'+
    (centers[h]?'<button class="act" data-go="'+h+'">📍 ver</button>':'<span class="pill">sem posição</span>')+
    '<button class="danger" data-un="'+h+'">Abandonar</button></div>').join('');
  el.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>goTo(b.dataset.go));
  el.querySelectorAll('[data-hist]').forEach(b=>b.onclick=()=>showHist(b.dataset.hist));
  el.querySelectorAll('[data-un]').forEach(b=>b.onclick=async()=>{
    adopted.delete(b.dataset.un);await save();paintMine();renderList();refresh();});
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
      html+='<div class="row"><span class="grow">📡 '+obs.slice(4,22)+' → base '+base.slice(4,22)+
        '<br><small style="color:var(--dim)">'+t.event_class+' · '+t.status+' '+t.completed_count+'/'+t.redundancy_required+' votos · '+hhmm(t.created_at)+'</small></span></div>';
      for(const v of d.votes.filter(x=>x.task_id===t.id)){
        html+='<div class="row"><span class="grow" style="padding-left:14px">🗳 @'+String(v.operator_id).slice(0,8)+
          ' · score '+Number(v.model_score).toFixed(2)+' · céu '+Math.round((v.valid_frac||0)*100)+'% · '+hhmm(v.created_at)+'</span></div>';
      }
    }
    for(const e of d.events){
      html+='<div class="row"><span class="grow">🔴 '+(e.lifecycle_state||'')+' '+(e.event_class||'')+
        ' · conf '+Number(e.calibrated_confidence||0).toFixed(2)+' · IoU '+Number(e.spatial_agreement_iou||0).toFixed(2)+
        ' · '+hhmm(e.created_at)+'</span></div>';
    }
    // F1 visual: pares antes x depois votados por este no (thumbs NDVI locais).
    try{
      const tj=await (await fetch('/api/thumbs?h='+encodeURIComponent(h))).json();
      const pairs=(tj.data||[]).filter(x=>x.t0&&x.base);
      if(pairs.length){
        html+='<div class="row"><span class="grow"><b>🛰 ANTES × DEPOIS</b><br><small style="color:var(--dim)">verde=mata · vermelho=corte · passe o mouse para ver o antes</small></span></div>';
        for(const p of pairs.slice(0,3)){
          html+='<div class="row"><span class="grow"><small style="color:var(--dim)">voto '+String(p.task).slice(0,8)+'</small>'+
            '<div style="position:relative;line-height:0;border-radius:8px;overflow:hidden;border:1px solid #1e293b">'+
            '<img loading="lazy" src="'+p.base+'" style="width:100%;display:block" alt="antes">'+
            '<img loading="lazy" src="'+p.t0+'" style="position:absolute;inset:0;width:100%;height:100%;transition:opacity .25s" onmouseover="this.style.opacity=0" onmouseout="this.style.opacity=1" alt="agora">'+
            '<span style="position:absolute;top:4px;left:4px;font-size:10px;background:rgba(2,6,23,.75);color:#00f2fe;padding:1px 6px;border-radius:99px">AGORA</span>'+
            '</div></span></div>';
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
          html+='<a href="'+p.t0+'" target="_blank" rel="noopener" style="flex:0 0 auto;width:104px;text-decoration:none">'+
            '<img loading="lazy" src="'+p.t0+'" style="width:104px;height:104px;object-fit:cover;border-radius:8px;border:1px solid #1e293b" alt="passagem">'+
            '<div style="font-size:10px;color:var(--dim);text-align:center">'+dot+' '+when+' · '+sc+'</div></a>';
        }
        html+='</div></div>';
      }
    }catch(e2){/* sem thumbs: timeline segue */}
    el.innerHTML=html;
    $('hist-back').onclick=()=>{el.innerHTML='';};
    icons();
  }catch(e){el.innerHTML='<div class="hint">Falha no rastro: '+e+'</div>';}
}
$('adopt-all').onclick=async()=>{let n=0;for(const [h,o] of layers){if(adopted.size>=500)break;if(!o.mine&&!adopted.has(h)){adopted.add(h);stash(h,boundsCache.get(h));n++;}}
  await save();paintGrid();refresh();$('msg2').textContent=n+' adotado(s) desta vista (max 500).';};
$('adopt-clear').onclick=async()=>{if(!confirm('Abandonar TODOS os quadrantes?'))return;
  adopted.clear();await save();paintGrid();renderList();refresh();};
async function startRun(){
  if(runStateRunning)return;
  const btns=[...document.querySelectorAll('button.go')];
  btns.forEach(b=>b.disabled=true);
  try{
    const r=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    if(r.status===409){msg('Já tem rodada em andamento — acompanhe em ☰ Tarefas.');show('tasks');return;}
    show('tasks');refreshRun();
  }finally{document.querySelectorAll('button.go').forEach(b=>b.disabled=false);}
}
let runStateRunning=false;
$('run1').onclick=startRun;$('run2').onclick=startRun;
async function refreshRun(){
  const j=await (await fetch('/api/run/state')).json();const s=j.state;
  runStateRunning=!!s.running;
  const box=$('runbox');
  let html='<div class="row"><span class="grow">Estado</span>'+
    (s.running?'<span class="pill run"><span class="spin">◌</span> RODANDO</span>':'<span class="pill ok">PARADO</span>')+'</div>';
  if(s.running&&s.current)html+='<div class="row"><span class="grow">⏳ '+s.current+'</span></div>';
  const shown=s.items.slice(-150);
  if(s.items.length>shown.length)html+='<div class="hint">mostrando '+shown.length+' de '+s.items.length+' itens…</div>';
  for(const it of shown){
    const cls=it.phase==='erro'?'err':(it.result==='reported'||it.created?'ok':'run');
    const nm=it.h3?('▦ '+short12(it.h3)):('task '+String(it.taskId||'').slice(0,8));
    let d=it.phase;
    if(it.observation)d+=' · '+String(it.observation).slice(0,20);
    if(it.score!=null)d+=' · score '+Number(it.score).toFixed(2);
    if(it.result==='reported')d+=' → '+(it.decision||'?')+(it.eventId?' · ev '+String(it.eventId).slice(0,8):' · 1/2 votos');
    if(it.error)d+=' · '+it.error;
    if(it.ms!=null)d+=' · '+(it.ms/1000).toFixed(1)+'s';
    html+='<div class="row"><span class="grow">'+nm+' — '+d+'</span><span class="pill '+cls+'">'+it.phase+'</span></div>';
  }
  if(s.summary)html+='<div class="row"><span class="grow">'+s.summary+'</span></div>';
  box.innerHTML=html;
  if(s.running&&!poll)poll=setInterval(refreshRun,2000);
  if(!s.running&&poll){clearInterval(poll);poll=null;}
  if(wasRunning&&!s.running){if(evOn)loadEvents();refresh();}
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
