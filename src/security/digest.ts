/**
 * Digest real do bundle do no (pinning anti-no-malicioso, GDD Sec 14).
 * sha256 sobre todos os .js compilados de src/ em ordem + versao do pacote.
 * O operador publica esse valor em ALLOWED_DIGESTS no server (`npm run digest`);
 * o server rejeita 403 qualquer report/lease fora da lista quando nao vazia.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function collectJs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

export function computeContainerDigest(distDir: string, version = ''): string {
  const h = createHash('sha256');
  h.update(`satsentinel-node@${version}\n`);
  for (const f of collectJs(distDir)) {
    h.update(f.slice(distDir.length) + '\n');
    h.update(readFileSync(f));
    h.update('\n');
  }
  return `sha256:${h.digest('hex')}`;
}
