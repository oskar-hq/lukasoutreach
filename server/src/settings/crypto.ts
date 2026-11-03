import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Geheimnisse (API-Schlüssel, Token) liegen verschlüsselt in der Datenbank: AES-256-GCM, je Wert eigene Zufallszahl.
 * Der Schlüssel kommt aus `SETTINGS_KEY` (32 Byte, base64 oder 64 Hex-Zeichen) oder – wenn der fehlt – aus der Datei
 * `DATA_DIR/settings.key` (Rechte 600), die beim ersten Geheimnis angelegt wird. Sicherungen kopieren nur die
 * Datenbank, nie den Schlüssel: Eine gestohlene Sicherung verrät keine Geheimnisse.
 */

const KEY_FILE = 'settings.key';
const PREFIX = 'v1';

/** 64 Hex-Zeichen oder base64 mit 32 Byte → Schlüssel, sonst null. */
export function parseKey(text: string): Buffer | null {
  const trimmed = text.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const buffer = Buffer.from(trimmed, 'base64');
  return buffer.length === 32 ? buffer : null;
}

export class SecretBox {
  private cached: Buffer | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly envKey: string | null,
  ) {}

  private get keyPath(): string {
    return path.join(this.dataDir, KEY_FILE);
  }

  /** Schlüssel zum Lesen: nie neu anlegen (ohne Schlüssel ist ein gespeichertes Geheimnis nicht lesbar). */
  private readKey(): Buffer | null {
    if (this.cached) return this.cached;
    if (this.envKey) {
      this.cached = parseKey(this.envKey);
      return this.cached;
    }
    if (existsSync(this.keyPath)) this.cached = parseKey(readFileSync(this.keyPath, 'utf8'));
    return this.cached;
  }

  /** Schlüssel zum Schreiben: bei Bedarf Datei im Datenordner anlegen. */
  private writeKey(): Buffer {
    const existing = this.readKey();
    if (existing) return existing;
    if (this.envKey) throw new Error('SETTINGS_KEY ist ungültig (32 Byte als base64 oder 64 Hex-Zeichen, z. B. openssl rand -hex 32).');
    if (existsSync(this.keyPath)) throw new Error(`${KEY_FILE} im Datenordner ist nicht lesbar – bitte prüfen oder löschen (gespeicherte Geheimnisse gehen dann verloren).`);
    mkdirSync(this.dataDir, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(this.keyPath, `${key.toString('base64')}\n`, { mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
    this.cached = key;
    return key;
  }

  encrypt(plain: string): string {
    const key = this.writeKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** null = nicht entschlüsselbar (falscher oder fehlender Schlüssel, beschädigter Wert). */
  decrypt(encrypted: string): string | null {
    const key = this.readKey();
    if (!key) return null;
    const [prefix, iv, tag, data] = encrypted.split(':');
    if (prefix !== PREFIX || !iv || !tag || data === undefined) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/**
 * Schlüssel zum Ablegen im Passwort-Manager (Einstellungen → Sicherungen und Updates → „Schlüssel für Geheimnisse
 * anzeigen“): Ohne ihn sind die Geheimnisse einer Sicherung nach dem Verlust des Servers nicht mehr lesbar.
 * `env`: kommt aus `SETTINGS_KEY` – dann steht er schon in der `.env` und wird nicht herausgegeben. `none`: noch keine
 * Schlüsseldatei (erst das erste Geheimnis legt sie an). Nie angelegt, nur gelesen.
 */
export function readSettingsKey(dataDir: string, envKey: string | null): { source: 'env' | 'file' | 'none'; key: string | null } {
  if (envKey) return { source: 'env', key: null };
  const file = path.join(dataDir, KEY_FILE);
  if (!existsSync(file)) return { source: 'none', key: null };
  const text = readFileSync(file, 'utf8').trim();
  return parseKey(text) ? { source: 'file', key: text } : { source: 'none', key: null };
}
