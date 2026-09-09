/**
 * Identidade do operador (GDD Sec 12): operator.key local + pareamento por arquivo ou 12 palavras.
 * Formato operator.key (0600): {operator_id, public_key_hex, private_key_hex, mnemonic?}
 */
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { mnemonicToEntropy, entropyToMnemonic } from 'bip39';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { operatorIdFromPublicKey } from '@satsentinel/protocol';

export interface OperatorKey { operator_id: string; public_key_hex: string; private_key_hex: string; mnemonic?: string; }
export interface NodeConfig { node_id: string; operator_id: string; node_alias: string; server_url: string; max_ram_mb: number; local_priority: boolean; aoi?: unknown; }

const KEY_BITS = 128;

export function keyPath(base = 'config'): string { return join(base, 'operator.key'); }
export function configPath(base = 'config'): string { return join(base, 'node.config.json'); }

export function loadOrCreate(base = 'config'): { key: OperatorKey; cfg: NodeConfig; created: boolean } {
  mkdirSync(base, { recursive: true });
  const kp = keyPath(base);
  const cp = configPath(base);
  if (existsSync(kp) && existsSync(cp)) {
    return { key: JSON.parse(readFileSync(kp, 'utf8')), cfg: JSON.parse(readFileSync(cp, 'utf8')), created: false };
  }
  // importa via env (Opcao C headless)
  const seedWords = process.env.OPERATOR_SEED?.trim();
  let key: OperatorKey;
  if (seedWords) {
    key = fromMnemonic(seedWords);
  } else {
    const entropyHex = randomBytes(16).toString('hex');
    const mnemonic = entropyToMnemonic(entropyHex);
    key = { ...fromMnemonic(mnemonic), mnemonic };
  }
  writeFileSync(kp, JSON.stringify(key, null, 2), { mode: 0o600 });
  try { chmodSync(kp, 0o600); } catch { /* windows */ }
  const cfg: NodeConfig = existsSync(cp)
    ? JSON.parse(readFileSync(cp, 'utf8'))
    : { node_id: randomUUID(), operator_id: key.operator_id, node_alias: 'node', server_url: process.env.SERVER_URL ?? 'http://localhost:8080', max_ram_mb: 1024, local_priority: true };
  cfg.operator_id = key.operator_id;
  writeFileSync(cp, JSON.stringify(cfg, null, 2));
  return { key, cfg, created: true };
}

export function fromMnemonic(mnemonic: string): OperatorKey {
  const entropyHex = mnemonicToEntropy(mnemonic.trim().split(/\s+/).join(' '));
  const priv = sha256(hexToBytes(entropyHex)); // 32B deterministicos da entropia 128-bit
  const pub = ed25519.getPublicKey(priv);
  return { operator_id: operatorIdFromPublicKey(pub), public_key_hex: bytesToHex(pub), private_key_hex: bytesToHex(priv), mnemonic: mnemonic.trim().split(/\s+/).join(' ') };
}

export function exportPairing(base = 'config'): string {
  return readFileSync(keyPath(base), 'utf8');
}

export function importPairing(json: string, base = 'config'): OperatorKey {
  const key = JSON.parse(json) as OperatorKey;
  if (!key.operator_id || !key.private_key_hex || !key.public_key_hex) throw new Error('operator.key invalido');
  mkdirSync(dirname(keyPath(base)), { recursive: true });
  writeFileSync(keyPath(base), JSON.stringify(key, null, 2), { mode: 0o600 });
  return key;
}

if (process.argv.includes('--show')) {
  const { key, cfg } = loadOrCreate(process.env.CONFIG_DIR ?? 'config');
  console.log(`operator ${key.operator_id} node ${cfg.node_id}\nbackup: guarde config/operator.key em local seguro`);
}
void KEY_BITS;
