import { Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { CockpitLead } from '../../../shared/leads';
import type { LeadCategory } from '../../../shared/leadSearch';
import type { AuthFounderId } from '../../../shared/auth';
import { ApiError, leadsApi } from '../../lib/leadSearchApi';
import { leadCompany, leadName } from '../../lib/leadView';
import { formatRelative } from '../../lib/time';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

/**
 * Archiv „Verloren“ (Wunsch des Nutzers 22.10., wie „Zuletzt gelöscht“): Verlorene Leads stehen nicht mehr im Board,
 * nur hier – zum Wiederherstellen, falls einer aus Versehen verloren ging. Schreibt ein verlorener Lead wieder, holt
 * ihn der Chat-Abgleich von selbst zurück (Stufe Antwort, Aufgabe).
 */
export function LostLeadsDialog({
  open,
  owner,
  category,
  onClose,
  onOpenLead,
  onChanged,
}: {
  open: boolean;
  owner?: AuthFounderId;
  category?: LeadCategory[];
  onClose: () => void;
  onOpenLead: (leadId: string) => void;
  /** Ein Lead wurde wieder geöffnet – Board neu laden. */
  onChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [leads, setLeads] = useState<CockpitLead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await leadsApi.list({ owner, category, stage: ['lost'], q: query, sort: 'recent', limit: 200 });
      setLeads(response.leads);
      setTotal(response.total);
      setError(null);
    } catch {
      setError('Die verlorenen Leads konnten nicht geladen werden.');
    }
  }, [owner, category, query]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [open, load, query]);

  const reopen = async (lead: CockpitLead) => {
    setBusy(lead.id);
    try {
      await leadsApi.act(lead.id, { action: 'reopened' });
      setLeads((current) => current?.filter((entry) => entry.id !== lead.id) ?? null);
      setTotal((current) => Math.max(0, current - 1));
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Wieder öffnen hat nicht geklappt.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="lost-title" className="sm:max-w-[560px]">
      <div className="flex max-h-[min(80dvh,720px)] flex-col p-6" data-testid="lost-dialog">
        <h2 id="lost-title" className="text-[20px] font-semibold tracking-[-0.01em]">
          Verloren <span className="text-ink-3">{total}</span>
        </h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          Archiviert – nicht mehr im Board und in den Aufgaben. Schreibt jemand wieder, ist er von selbst zurück. Aus Versehen verloren? „Wieder öffnen“.
        </p>
        <label className="relative mt-4 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, Firma …"
            aria-label="Verlorene Leads durchsuchen"
            className="h-10 w-full rounded-[10px] bg-surface-3 pl-9 pr-3 text-[16px] text-ink outline-none placeholder:text-ink-4 sm:text-[14px]"
            data-testid="lost-search"
          />
        </label>
        {error && (
          <p className="mt-3 text-[13.5px] text-ink" role="alert">
            {error}
          </p>
        )}
        <ul className="scroll-thin -mx-2 mt-3 min-h-0 flex-1 overflow-y-auto" data-testid="lost-list">
          {leads === null ? (
            <li className="px-2 py-2 text-[13.5px] text-ink-3">Wird geladen …</li>
          ) : leads.length === 0 ? (
            <li className="px-2 py-2 text-[13.5px] text-ink-3">{query ? 'Nichts gefunden.' : 'Keine verlorenen Leads.'}</li>
          ) : (
            leads.map((lead) => (
              <li key={lead.id} className="flex items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-surface-3" data-testid="lost-item">
                <button type="button" onClick={() => onOpenLead(lead.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[14px] font-semibold text-ink">{leadName(lead)}</span>
                  <span className="block truncate text-[12.5px] text-ink-3">
                    {leadCompany(lead)} · {formatRelative(lead.lastActivityAt)}
                  </span>
                </button>
                <Button size="sm" variant="ghost" onClick={() => void reopen(lead)} disabled={busy === lead.id} data-testid="lost-reopen">
                  Wieder öffnen
                </Button>
              </li>
            ))
          )}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>Fertig</Button>
        </div>
      </div>
    </Modal>
  );
}
