import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SEARCH_PROFILE, type RunSnapshot, type StartRunRequest } from '../../shared/leadSearch.js';
import { MockAdapter } from '../src/adapters/mock/mockAdapter.js';
import { DEMO_PROVIDER_IDS } from '../src/adapters/mock/mockData.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { LeadSearchAdapter } from '../src/pipeline/adapter.js';

/** Eigener, leerer Datenordner je Test – eine lokale Tracking-Liste darf Tests nicht beeinflussen. */
export function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'lead-search-'));
}

/** App für die Pipeline-Tests – ohne Pflicht-Sitzung (die Anmeldung prüft `auth.test.ts`). */
export function mockApp(adapter: LeadSearchAdapter = new MockAdapter(0), env: NodeJS.ProcessEnv = {}, requireSession = false) {
  return buildApp({ config: loadConfig({ LEAD_SEARCH_MODE: 'mock', DATA_DIR: tempDataDir(), ...env }), adapter, logger: false, requireSession });
}

/** Die vier Demo-Leads, die in der simulierten Suche erneut auftauchen. */
export const DEMO_KNOWN = [
  { providerId: DEMO_PROVIDER_IDS.n01, owner: 'Nick' },
  { providerId: DEMO_PROVIDER_IDS.n03, owner: 'Nick' },
  { providerId: DEMO_PROVIDER_IDS.n05, owner: 'Nick' },
  { providerId: DEMO_PROVIDER_IDS.j15, owner: 'Johannes' },
];

export function startBody(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return { profile: { ...DEFAULT_SEARCH_PROFILE }, known: DEMO_KNOWN, pendingInvitations: [], checked: [], ...overrides };
}

type App = ReturnType<typeof mockApp>;

export async function waitForEnd(app: App, id: string, timeoutMs = 5000): Promise<RunSnapshot> {
  const started = Date.now();
  for (;;) {
    const response = await app.inject({ method: 'GET', url: `/api/lead-search/runs/${id}` });
    const { run } = response.json() as { run: RunSnapshot };
    if (run.status !== 'running') return run;
    if (Date.now() - started > timeoutMs) throw new Error(`Lauf ${id} nicht fertig geworden`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
