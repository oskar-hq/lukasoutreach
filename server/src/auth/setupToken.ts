import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTER_PATH, SETUP_FRAGMENT } from '../../../shared/auth.js';

/**
 * Einmal-Schlüssel für das allererste Konto (Vertrag `shared/auth.ts` → „Registrierung und Einarbeitung“).
 *
 * Ohne ihn würde Gründer, wer die frisch installierte Seite zuerst öffnet – auch ein Fremder, der schneller ist. Solange
 * es kein Konto gibt, legt das Backend beim Start einen Zufallsschlüssel in `DATA_DIR/setup-token` an (Rechte 600) und
 * schreibt den Link ins Protokoll; nur mit ihm wird die erste Registrierung angenommen. Mit `SETUP_TOKEN` in der .env
 * gilt stattdessen dieser Wert. Nach dem ersten Konto wird die Datei gelöscht.
 */

export const SETUP_TOKEN_FILE = 'setup-token';

/** Vergleich in konstanter Zeit (über die Hashes, damit auch die Länge nichts verrät). */
function sameSecret(given: string, expected: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

export class SetupTokenStore {
  private readonly path: string;
  private current: string | null = null;

  constructor(
    private readonly dataDir: string,
    /** `SETUP_TOKEN` aus der .env – hat Vorrang vor der Datei. */
    private readonly fixed: string | null = null,
  ) {
    this.path = join(dataDir, SETUP_TOKEN_FILE);
  }

  /** Schlüssel lesen oder (ohne Datei) neu anlegen. Bleibt über Neustarts gleich, damit der Link gilt. */
  ensure(): string {
    if (this.fixed) return this.fixed;
    if (this.current) return this.current;
    if (existsSync(this.path)) {
      const stored = readFileSync(this.path, 'utf8').trim();
      if (stored) {
        this.current = stored;
        return stored;
      }
    }
    mkdirSync(this.dataDir, { recursive: true });
    const token = randomBytes(32).toString('base64url');
    writeFileSync(this.path, `${token}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.current = token;
    return token;
  }

  /** Gibt es schon einen Schlüssel (fest, im Speicher oder als Datei)? */
  exists(): boolean {
    if (this.fixed || this.current) return true;
    return existsSync(this.path) && readFileSync(this.path, 'utf8').trim() !== '';
  }

  /** Stimmt der mitgeschickte Schlüssel? Ohne angelegten Schlüssel nie. */
  matches(given: unknown): boolean {
    if (typeof given !== 'string' || !given) return false;
    const expected = this.fixed ?? this.current ?? (existsSync(this.path) ? readFileSync(this.path, 'utf8').trim() : '');
    return Boolean(expected) && sameSecret(given.trim(), expected);
  }

  /** Erstes Konto steht: Datei löschen (ein fester `SETUP_TOKEN` bleibt wirkungslos, weil es dann Konten gibt). */
  clear(): void {
    this.current = null;
    rmSync(this.path, { force: true });
  }
}

/** Link für die erste Registrierung, z. B. `https://crm.example.de/registrieren#setup=…`. */
export function setupLink(publicUrl: string | null, token: string): string {
  return `${publicUrl ?? ''}${REGISTER_PATH}#${SETUP_FRAGMENT}${token}`;
}
