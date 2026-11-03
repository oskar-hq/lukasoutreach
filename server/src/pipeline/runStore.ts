import type { RunEvent, RunSnapshot } from '../../../shared/leadSearch.js';

export type RunListener = (data: string, event: RunEvent) => void;

export interface RunRecord {
  snapshot: RunSnapshot;
  controller: AbortController;
  listeners: Set<RunListener>;
}

/** Läufe im Arbeitsspeicher. Reicht für die Demo – nach einem Neustart beginnt man einfach neu. */
export class RunStore {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly keep = 20) {}

  add(snapshot: RunSnapshot): RunRecord {
    const record: RunRecord = { snapshot, controller: new AbortController(), listeners: new Set() };
    this.runs.set(snapshot.id, record);
    // Älteste abgeschlossene Läufe verwerfen.
    for (const [id, entry] of this.runs) {
      if (this.runs.size <= this.keep) break;
      if (entry.snapshot.status !== 'running') this.runs.delete(id);
    }
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** Höchstens ein Lauf gleichzeitig – schützt den LinkedIn-Account vor parallelen Abrufen. */
  active(): RunRecord | undefined {
    for (const record of this.runs.values()) {
      if (record.snapshot.status === 'running') return record;
    }
    return undefined;
  }

  subscribe(id: string, listener: RunListener): () => void {
    const record = this.runs.get(id);
    if (!record) return () => {};
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /** Serialisiert sofort – spätere Änderungen an den Objekten verändern das gesendete Ereignis nicht. */
  emit(id: string, event: RunEvent): void {
    const record = this.runs.get(id);
    if (!record || record.listeners.size === 0) return;
    const data = JSON.stringify(event);
    for (const listener of record.listeners) listener(data, event);
  }
}
