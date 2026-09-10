// Imprime o digest do bundle compilado p/ pinar em ALLOWED_DIGESTS no server.
// Uso: npm run build && npm run digest
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeContainerDigest } from '../dist/src/security/digest.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(computeContainerDigest(join(root, 'dist'), version));
