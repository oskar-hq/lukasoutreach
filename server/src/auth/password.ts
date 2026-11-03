import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../../shared/auth.js';

/**
 * Passwort-Hashes mit scrypt (in Node eingebaut, speicherhart).
 * Format: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>` – die Parameter stehen im Hash,
 * damit sie später erhöht werden können, ohne alte Hashes ungültig zu machen.
 */

const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
/** scrypt braucht 128 · N · r Bytes (hier 32 MiB); Node erlaubt standardmäßig nur 32 MiB. */
const MAX_MEMORY = 64 * 1024 * 1024;

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

/** Gleiche Regel wie in der Oberfläche: Länge des unveränderten Strings, kein trim. */
export function passwordLengthOk(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...options, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Vergleicht in konstanter Zeit. Ein kaputter Hash gilt einfach als „falsch“. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltText, keyText] = stored.split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64');
  const key = await derive(password, Buffer.from(saltText, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Für unbekannte Namen: gleich viel Rechenzeit wie bei einem echten Konto (verrät nicht, ob es den Namen gibt). */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('base64'));
  return dummyHash;
}
