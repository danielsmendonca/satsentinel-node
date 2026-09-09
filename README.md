# SatSentinel Node 🛰️

Agente de borda para homelab (Raspberry Pi, N100, NAS): processa células Sentinel-2 via HTTP Range, vota no consenso e serve a **Central de comando** local. Tudo em Node.js puro, sem dependência nativa.

> Repo público — **sem segredos aqui**: `config/operator.key` e `config/node.config.json` estão no `.gitignore` e nunca são commitados.

## Requisitos

- **Node.js 20+** (nada mais — sem docker, sem banco local)

## Rodando (3 min)

```bash
npm install
npm run build

# Central web (UI): http://localhost:3000/
npm run ui

# Loop contínuo (vota sozinho a cada POLL_MS):
npm start
```

Aponte para o seu server em `config/node.config.json` (`server_url`) ou via env `SERVER_URL`.

## Central de comando (`:3000`)

- **Mapa**: Evidence Map (vermelho = evento confirmado) + grade H3 + satélite
- **Quadrantes**: grade cinza clicável (zoom 8+), adotar/soltar, lista com 📍
- **Tarefas**: executar agora, automático por timer, lista em tempo real, feed de atividade
- **Logs / Ajustes**: logs do nó e do server, apelido, URL, pareamento, zona de perigo

**Do celular (mesmo Wi-Fi):** `http://SEU-IP:3000/` — libere a porta uma vez (PowerShell **admin**):

```powershell
New-NetFirewallRule -DisplayName "SatSentinel Node UI" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

## Multi-nó sem login (1 dono, N máquinas)

1. No 1º nó, abra **Ajustes → Exportar chave** (`operator.key`).
2. Nos outros nós: **Ajustes → colar → Importar** (ou copie o arquivo para `config/`).
3. Cada máquina gera seu próprio `node_id`, mas todas votam como **1 operador** (quorum exige 3 operadores distintos — anti-Sybil).

## Como funciona 1 rodada

`lease` (fila global, 1 task por operador) → lê janelas COG B04/B08/SCL via Range → NDVI + mediana temporal + dNDVI → vetoriza (BFS ≥50px) → report assinado. Falha honesta (`/fail`) em vez de voto lixo: sem cena, nuvem ou erro viram `FAILED`/`SKIPPED`, nunca voto falso.

## Testes

```bash
npm test   # 12 testes (NDVI, SCL, vetorização, janelas COG, pareamento, pool)
```

## Estrutura

```
src/
  runner.ts        # Polling loop + pipeline real (geotiff + proj4 + ed25519)
  pipeline/        # ndvi, scl, vectorize (puros e testados)
  fetcher/         # COG Range+cache, STAC AOI privada, janelas UTM, MGRS
  identity/        # operator.key local + mnemonic 12 palavras
  ui/              # Central (Fastify :3000, Tailwind + Leaflet via CDN)
protocol/          # @satsentinel/protocol — FONTE DA VERDADE do contrato
                   # (vendored em satsentinel-server/src/vendor/protocol)
config/node.config.example.json
```

## Docker (opcional)

```bash
docker build -t satsentinel-node .
docker run -p 3000:3000 -v ./config:/app/config satsentinel-node
```
