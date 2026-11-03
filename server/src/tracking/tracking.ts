import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { SearchHit, TrackingSummary } from '../../../shared/leadSearch.js';
import type { Database } from '../db/database.js';

/**
 * Abgleich mit der bestehenden Outreach-Tracking-Liste (Excel). Aus der Datei wird nur ein Index der
 * LinkedIn-Profile übernommen (plus Setter, Blatt und Status) – andere Inhalte der Datei werden nicht gespeichert.
 */

export interface TrackingEntry {
  setter: string | null;
  sheet: string;
  status: string | null;
}

export interface TrackingIndex {
  summary: TrackingSummary;
  entries: Record<string, TrackingEntry>;
}

export class TrackingFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackingFileError';
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Schlüssel für einen LinkedIn-Link:
 * - linkedin.com/in/<name>                     → in:<name> (klein, URL-dekodiert)
 * - linkedin.com/sales/lead/<ID>,… bzw. /people → id:<ID>
 */
export function keyFromLinkedinUrl(raw: string): string | null {
  const text = raw.trim();
  const profile = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(text);
  if (profile) return `in:${safeDecode(profile[1]).toLowerCase()}`;
  const sales = /linkedin\.com\/sales\/(?:lead|people)\/([A-Za-z0-9_-]+)/i.exec(text);
  if (sales) return `id:${sales[1]}`;
  return null;
}

/** Alle Schlüssel, unter denen ein Suchtreffer in der Tracking-Liste stehen könnte. */
export function keysForHit(hit: Pick<SearchHit, 'providerId' | 'publicIdentifier' | 'profileUrl'>): string[] {
  const keys = new Set<string>();
  if (hit.publicIdentifier) keys.add(`in:${safeDecode(hit.publicIdentifier).toLowerCase()}`);
  if (hit.providerId) keys.add(`id:${hit.providerId}`);
  const fromUrl = hit.profileUrl ? keyFromLinkedinUrl(hit.profileUrl) : null;
  if (fromUrl) keys.add(fromUrl);
  return [...keys];
}

/** Text einer Excel-Zelle – Links, Rich-Text und Formel-Ergebnisse eingeschlossen. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return '';
  if (typeof value === 'object') {
    if ('hyperlink' in value && typeof value.hyperlink === 'string' && /linkedin\.com/i.test(value.hyperlink)) return value.hyperlink;
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return cellText(value.text as ExcelJS.CellValue);
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
  }
  return '';
}

function findColumn(headers: string[], pattern: RegExp): number {
  return headers.findIndex((header) => pattern.test(header));
}

export async function parseTrackingWorkbook(buffer: Buffer | ArrayBuffer, fileName: string): Promise<TrackingIndex> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as ArrayBuffer);
  } catch {
    throw new TrackingFileError('Die Datei ist keine gültige Excel-Datei (.xlsx).');
  }

  const entries: Record<string, TrackingEntry> = {};
  const bySetter: Record<string, number> = {};
  const sheets: string[] = [];

  for (const sheet of workbook.worksheets) {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        values[column - 1] = cellText(cell.value).trim();
      });
      rows.push(values);
    });

    // Kopfzeile: die erste Zeile mit einer Spalte „Setter“ (so ist die Tracking-Liste aufgebaut).
    const headerIndex = rows.findIndex((row) => row.some((value) => /^setter$/i.test(value ?? '')));
    const headers = headerIndex >= 0 ? rows[headerIndex].map((value) => value ?? '') : [];
    const setterColumn = findColumn(headers, /^setter$/i);
    const acceptedColumn = findColumn(headers, /anfrage\s*ange/i);
    const requestColumn = findColumn(headers, /^vern/i);

    let found = 0;
    rows.forEach((row, index) => {
      if (index === headerIndex) return;
      for (const value of row) {
        if (!value || !/linkedin\.com/i.test(value)) continue;
        const key = keyFromLinkedinUrl(value);
        if (!key || entries[key]) continue;
        const setter = setterColumn >= 0 ? row[setterColumn] || null : null;
        const accepted = acceptedColumn >= 0 ? row[acceptedColumn] || null : null;
        const request = requestColumn >= 0 ? row[requestColumn] || null : null;
        const status = accepted ?? (request ? (/bereits vernetzt/i.test(request) ? 'Bereits vernetzt' : 'Anfrage gesendet') : null);
        entries[key] = { setter, sheet: sheet.name, status };
        if (setter) bySetter[setter] = (bySetter[setter] ?? 0) + 1;
        found++;
      }
    });
    if (found) sheets.push(sheet.name);
  }

  const count = Object.keys(entries).length;
  if (count === 0) {
    throw new TrackingFileError('In der Datei wurden keine LinkedIn-Profil-Links gefunden.');
  }
  return { summary: { count, fileName, updatedAt: Date.now(), bySetter, sheets }, entries };
}

/**
 * Speichert den Index in der Datenbank (Tabelle `tracking_profiles`, Zusammenfassung in `settings`).
 * Eine ältere Ablage als `tracking.json` im Datenordner wird beim ersten Start einmalig übernommen
 * und danach in `tracking.json.imported` umbenannt.
 */
export class TrackingStore {
  private readonly legacyFile: string;

  constructor(
    private readonly db: Database,
    dataDir: string,
  ) {
    this.legacyFile = path.join(dataDir, 'tracking.json');
  }

  /** Übernimmt eine alte `tracking.json`, falls die Datenbank noch keine Liste hat. */
  async load(): Promise<void> {
    if (this.summary()) return;
    let legacy: TrackingIndex;
    try {
      legacy = JSON.parse(await readFile(this.legacyFile, 'utf8')) as TrackingIndex;
    } catch {
      return;
    }
    await this.replace(legacy);
    await rename(this.legacyFile, `${this.legacyFile}.imported`);
  }

  async replace(index: TrackingIndex): Promise<void> {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM tracking_profiles');
      const insert = this.db.prepare('INSERT INTO tracking_profiles (key, setter, sheet, status) VALUES (?, ?, ?, ?)');
      for (const [key, entry] of Object.entries(index.entries)) insert.run(key, entry.setter, entry.sheet, entry.status);
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(SUMMARY_KEY, JSON.stringify(index.summary));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM tracking_profiles');
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(SUMMARY_KEY);
  }

  summary(): TrackingSummary | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SUMMARY_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as TrackingSummary) : null;
  }

  lookup(hit: Pick<SearchHit, 'providerId' | 'publicIdentifier' | 'profileUrl'>): TrackingEntry | null {
    const select = this.db.prepare('SELECT setter, sheet, status FROM tracking_profiles WHERE key = ?');
    for (const key of keysForHit(hit)) {
      const entry = select.get(key) as TrackingEntry | undefined;
      if (entry) return { setter: entry.setter, sheet: entry.sheet, status: entry.status };
    }
    return null;
  }
}

const SUMMARY_KEY = 'tracking.summary';

/** Grund im Dubletten-Filter, z. B. „Bereits im Tracking · Nick · July 2026 · Angenommen“. */
export function trackingNote(entry: TrackingEntry): string {
  return ['Bereits im Tracking', entry.setter, entry.sheet, entry.status].filter(Boolean).join(' · ');
}
