import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { log } from './log.js';
import { ensureDir, nodePaths, readJson, writeJsonAtomic } from './paths.js';

/**
 * Secret storage.
 *
 * Order of preference:
 *   1. The OS keychain (`@napi-rs/keyring`) — Credential Manager on Windows,
 *      Keychain on macOS, Secret Service on Linux.
 *   2. An encrypted file under the node data directory, mode 0600.
 *   3. Environment variables, read-only, for CI and headless use.
 *
 * Secrets never enter project files, never enter the snapshot sent to the UI,
 * and are redacted from logs by `log.ts`. The UI only ever learns whether a key
 * is *present*, never its value.
 *
 * The file fallback deserves an honest note: a key derived from the machine id
 * and username protects against a stray backup or a shared drive, not against
 * someone with an interactive session on this machine. That is a real
 * limitation, and it is why the keychain is tried first and the UI says which
 * backend is in use.
 */

export type VaultBackend = 'keychain' | 'encrypted-file' | 'memory';

const SERVICE = 'AgenticTeam';

interface KeyringModule {
  Entry: new (
    service: string,
    account: string,
  ) => {
    getPassword(): string;
    setPassword(pw: string): void;
    deletePassword(): boolean;
  };
}

/**
 * Held in a variable so TypeScript does not resolve it statically.
 * `@napi-rs/keyring` is an optionalDependency: a machine without the native build
 * must still compile this file, and a literal specifier would make the
 * optional dependency a mandatory compile-time one.
 */
const KEYRING_MODULE = '@napi-rs/keyring';

let keyring: KeyringModule | null = null;
let backend: VaultBackend = 'encrypted-file';
let initialised = false;

/** In-process cache, so a hot path does not hit the keychain on every call. */
const cache = new Map<string, string>();

export async function initVault(): Promise<VaultBackend> {
  if (initialised) return backend;
  initialised = true;

  /**
   * A hermetic run gets a hermetic vault.
   *
   * `AGENTIC_DATA_DIR` isolates the projects, the plans and the quota ledger,
   * but it cannot isolate the OS keychain — that is shared per user, by design.
   * So an end-to-end run on a developer machine saw their real API keys, and a
   * test asserting "an unconfigured provider explains how to configure it"
   * failed on the developer who had configured it. The test was right and the
   * isolation was incomplete.
   *
   * `memory` also has a use beyond tests: a sandbox or a shared machine where
   * writing a credential anywhere durable would be wrong.
   */
  const forced = process.env.AGENTIC_VAULT;
  if (forced === 'memory') {
    backend = 'memory';
    log('Vault running in memory only — credentials will not be saved', 'warn');
    return backend;
  }
  if (forced === 'encrypted-file') {
    backend = 'encrypted-file';
    return backend;
  }

  try {
    const mod = (await import(KEYRING_MODULE)) as unknown as KeyringModule;
    // Prove it actually works before trusting it: on Linux without a running
    // Secret Service the import succeeds and every call throws.
    const probe = new mod.Entry(SERVICE, '__agentic_probe__');
    probe.setPassword('ok');
    probe.deletePassword();
    keyring = mod;
    backend = 'keychain';
  } catch (err) {
    backend = 'encrypted-file';
    log(
      `OS keychain unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        'falling back to an encrypted file in the app data directory',
      'warn',
    );
  }
  return backend;
}

export function vaultBackend(): VaultBackend {
  return backend;
}

// ---------------------------------------------------------------------------
// Encrypted-file fallback
// ---------------------------------------------------------------------------

/**
 * Derive a file key from stable machine properties. Not a password — see the
 * honesty note at the top of this file.
 */
function fileKey(): Buffer {
  const material = [os.hostname(), os.userInfo().username, os.platform(), os.homedir()].join('|');
  return crypto.scryptSync(material, 'agentic-team-vault-v1', 32);
}

interface EncryptedRecord {
  iv: string;
  tag: string;
  data: string;
}

function encrypt(plain: string): EncryptedRecord {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(record: EncryptedRecord): string | null {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey(), Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    // Wrong key (the machine changed) or tampering. Either way the value is
    // unusable; treat it as absent rather than crashing.
    return null;
  }
}

function readFileVault(): Record<string, EncryptedRecord> {
  return readJson<Record<string, EncryptedRecord>>(nodePaths().vaultFallback, {});
}

function writeFileVault(all: Record<string, EncryptedRecord>): void {
  const file = nodePaths().vaultFallback;
  ensureDir(nodePaths().base);
  writeJsonAtomic(file, all);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod is a no-op on Windows; ACLs already restrict the app data dir.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Key naming: `<providerId>:<account>`. The account dimension is what makes
 * multi-account hot-swap possible — two Groq keys on separate free tiers.
 */
export function secretKey(providerId: string, account = 'default'): string {
  return `${providerId}:${account}`;
}

/** Environment variable names checked for a provider, in order. */
const ENV_NAMES: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'openai-compatible': ['OPENAI_COMPATIBLE_API_KEY'],
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  figma: ['FIGMA_TOKEN', 'FIGMA_ACCESS_TOKEN'],
  miro: ['MIRO_TOKEN', 'MIRO_ACCESS_TOKEN'],
};

export function getSecret(providerId: string, account = 'default'): string | undefined {
  const key = secretKey(providerId, account);
  const cached = cache.get(key);
  if (cached) return cached;

  if (backend === 'memory') {
    // The cache IS the vault here; a miss means there is nothing to find.
    return undefined;
  }

  if (backend === 'keychain' && keyring) {
    try {
      const value = new keyring.Entry(SERVICE, key).getPassword();
      if (value) {
        cache.set(key, value);
        return value;
      }
    } catch {
      // No entry for this key. Fall through to the other sources.
    }
  } else {
    const record = readFileVault()[key];
    if (record) {
      const value = decrypt(record);
      if (value) {
        cache.set(key, value);
        return value;
      }
    }
  }

  // Environment last, and only for the default account: an env var is a
  // machine-wide setting, so treating it as a named account would be wrong.
  if (account === 'default') {
    for (const name of ENV_NAMES[providerId] ?? []) {
      const value = process.env[name];
      if (value) return value;
    }
  }
  return undefined;
}

export function setSecret(providerId: string, value: string, account = 'default'): void {
  const key = secretKey(providerId, account);
  const trimmed = value.trim();
  if (!trimmed) {
    deleteSecret(providerId, account);
    return;
  }

  if (backend === 'memory') {
    // Nothing to write. The cache set below is the whole storage.
  } else if (backend === 'keychain' && keyring) {
    new keyring.Entry(SERVICE, key).setPassword(trimmed);
  } else {
    const all = readFileVault();
    all[key] = encrypt(trimmed);
    writeFileVault(all);
  }
  cache.set(key, trimmed);
  log(`Stored credentials for ${providerId} (${account}) in the ${backend}`);
}

export function deleteSecret(providerId: string, account = 'default'): void {
  const key = secretKey(providerId, account);
  cache.delete(key);

  if (backend === 'memory') {
    // The cache delete above was the whole operation.
  } else if (backend === 'keychain' && keyring) {
    try {
      new keyring.Entry(SERVICE, key).deletePassword();
    } catch {
      // Already absent.
    }
  } else {
    const all = readFileVault();
    delete all[key];
    writeFileVault(all);
  }
  log(`Removed credentials for ${providerId} (${account})`);
}

export function hasSecret(providerId: string, account = 'default'): boolean {
  return getSecret(providerId, account) !== undefined;
}

/**
 * Named accounts stored for a provider. The keychain has no enumeration API, so
 * the account list is tracked separately in node config — this reads the file
 * vault's keys and is only complete on the file backend. Callers use it to
 * populate a picker, and 'default' is always offered regardless.
 */
export function listAccounts(providerId: string): string[] {
  const prefix = `${providerId}:`;
  const fromFile = Object.keys(readFileVault())
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
  const fromCache = [...cache.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  return [...new Set(['default', ...fromFile, ...fromCache])];
}

/** Drop the in-process cache. Used after an account switch. */
export function clearSecretCache(): void {
  cache.clear();
}
