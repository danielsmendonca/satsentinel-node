// Repina o digest do bundle no .env do server irmao (../satsentinel-server/.env).
// Uso: npm run build && npm run pin   (rode sempre apos rebuild com pinning ativo)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const digest = execSync('node ./scripts/digest.mjs', { cwd: root, encoding: 'utf8' }).trim();
const envPath = join(root, '..', 'satsentinel-server', '.env');
if (!existsSync(envPath)) {
  console.log(digest);
  console.log('server .env nao encontrado ao lado; cole ALLOWED_DIGESTS=<acima> manualmente');
  process.exit(0);
}
let env = readFileSync(envPath, 'utf8');
if (/^ALLOWED_DIGESTS=.*$/m.test(env)) {
  env = env.replace(/^ALLOWED_DIGESTS=.*$/m, `ALLOWED_DIGESTS=${digest}`);
} else {
  env += `\nALLOWED_DIGESTS=${digest}\n`;
}
const { writeFileSync } = await import('node:fs');
writeFileSync(envPath, env);
console.log(`pinado: ${digest}\nreinicie o server para valer`);
