import { statfsSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import { DISK_LOW_BYTES, DISK_LOW_PERCENT, type DiskSpaceInfo } from '../../../shared/system.js';

/**
 * Speicherplatz im Datenordner (`DATA_DIR`): Läuft die Platte voll, scheitern Sicherungen, Updates (Docker baut neu)
 * und am Ende jeder Schreibzugriff auf die Datenbank. Geprüft wird stündlich und vor jeder Sicherung; knapp heißt
 * unter `DISK_LOW_BYTES` (1 GB) oder unter `DISK_LOW_PERCENT` (10 %) frei. Dann eine Meldung in den Neuigkeiten
 * (und an Slack), die von selbst verschwindet, sobald wieder genug Platz ist.
 */

const CHECK_EVERY_MS = 60 * 60 * 1000;

export type StatFs = (dir: string) => { bavail: number | bigint; blocks: number | bigint; bsize: number | bigint };

/** Freier Platz in `dir` (null = nicht lesbar, z. B. Ordner fehlt). */
export function readDiskSpace(dir: string, now = Date.now(), statfs: StatFs = statfsSync): DiskSpaceInfo | null {
  try {
    const stats = statfs(dir);
    const size = Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * size;
    const totalBytes = Number(stats.blocks) * size;
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const low = freeBytes < DISK_LOW_BYTES || (freeBytes / totalBytes) * 100 < DISK_LOW_PERCENT;
    return { freeBytes, totalBytes, low, checkedAt: now };
  } catch {
    return null;
  }
}

/** „1,4 GB“ bzw. „850 MB“ – für fertige Sätze. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(bytes / 1024 ** 2).toLocaleString('de-DE')} MB`;
}

export interface DiskMonitorDeps {
  /** Datenordner (aus der laufenden Konfiguration). */
  dir: () => string;
  log: FastifyBaseLogger;
  onLow: (info: DiskSpaceInfo) => void;
  onOk: () => void;
  statfs?: StatFs;
  now?: () => number;
}

export class DiskMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DiskMonitorDeps) {}

  /** Jetzt prüfen und melden bzw. Meldung aufheben. Wirft nie. */
  check(): DiskSpaceInfo | null {
    const info = readDiskSpace(this.deps.dir(), this.deps.now?.() ?? Date.now(), this.deps.statfs);
    if (!info) return null;
    try {
      if (info.low) {
        this.deps.log.warn({ freeBytes: info.freeBytes, totalBytes: info.totalBytes }, 'Speicherplatz knapp');
        this.deps.onLow(info);
      } else {
        this.deps.onOk();
      }
    } catch {
      // Meldungen dürfen nie stören.
    }
    return info;
  }

  /** Nur lesen (für die Anzeige), ohne zu melden. */
  read(): DiskSpaceInfo | null {
    return readDiskSpace(this.deps.dir(), this.deps.now?.() ?? Date.now(), this.deps.statfs);
  }

  startTimer(intervalMs = CHECK_EVERY_MS): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
