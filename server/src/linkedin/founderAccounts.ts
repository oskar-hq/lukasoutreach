import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../../shared/auth.js';
import { UnipileClient, type UnipileAccount } from '../adapters/live/unipileClient.js';
import type { Config } from '../config.js';

/**
 * Ist der LinkedIn-Account eines Gründers gerade nutzbar? (Wunsch des Nutzers 17.10., Nicks Account gesperrt und bei
 * Unipile getrennt.) Nicht nutzbar heißt: Aufgaben dieses Gründers pausieren (`TasksResponse.accountPaused`), seine
 * neuen Leads übernimmt der andere Gründer.
 *   - Simulation: immer nutzbar.
 *   - Ist für keinen Gründer ein Account zugeordnet, gilt wie bisher jeder als nutzbar (Senden von Hand ohne Unipile).
 *   - Sonst: Account zugeordnet und – falls Unipile antwortet – dort als LinkedIn-Account mit Status OK gelistet.
 *     Ist Unipile nicht erreichbar, wird nichts pausiert (kein Stillstand wegen einer Störung).
 * Die Account-Liste (GET /api/v1/accounts, nur lesend) bleibt eine Minute zwischengespeichert.
 */
export const FOUNDER_ACCOUNTS_TTL_MS = 60_000;

export class FounderAccounts {
  private cache: { at: number; items: UnipileAccount[] | null } | null = null;

  constructor(
    private readonly deps: { config: Config; fetch?: typeof fetch; now?: () => number },
  ) {}

  async available(): Promise<Record<AuthFounderId, boolean>> {
    const { config } = this.deps;
    const all = Object.fromEntries(AUTH_FOUNDER_IDS.map((id) => [id, true])) as Record<AuthFounderId, boolean>;
    if (config.mode === 'mock') return all;
    const assigned = config.linkedin.accounts;
    if (!AUTH_FOUNDER_IDS.some((id) => assigned[id])) return all;
    const items = await this.list();
    return Object.fromEntries(
      AUTH_FOUNDER_IDS.map((id) => {
        const accountId = assigned[id];
        if (!accountId) return [id, false];
        if (items === null) return [id, true];
        const listed = items.find((account) => account.id === accountId && (account.type ?? '').toUpperCase() === 'LINKEDIN');
        const ok = Boolean(listed) && (listed!.sources ?? []).every((source) => !source.status || source.status === 'OK');
        return [id, ok];
      }),
    ) as Record<AuthFounderId, boolean>;
  }

  /** Account-Liste von Unipile oder null (nicht eingerichtet, nicht erreichbar). */
  private async list(): Promise<UnipileAccount[] | null> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cache && now - this.cache.at < FOUNDER_ACCOUNTS_TTL_MS) return this.cache.items;
    const { dsn, apiKey } = this.deps.config.unipile;
    let items: UnipileAccount[] | null = null;
    if (dsn && apiKey) {
      try {
        const client = new UnipileClient({ dsn, apiKey, fetch: this.deps.fetch, timeoutMs: 10_000 });
        items = (await client.listAccounts(AbortSignal.timeout(12_000))).items ?? [];
      } catch {
        items = null;
      }
    }
    this.cache = { at: now, items };
    return items;
  }
}
