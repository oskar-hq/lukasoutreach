import { useState } from 'react';
import type { CockpitLead } from '../../../shared/leads';
import { ApiError, leadsApi, saveBlob } from '../../lib/leadSearchApi';
import { leadName } from '../../lib/leadView';
import { useAccess } from '../../state/auth';
import { useCockpit } from '../../state/cockpit';
import { useDemo } from '../../state/demo';

/**
 * Betroffenenrechte (DSGVO, `shared/leads.ts`): „Daten exportieren“ (Auskunft) und „Lead endgültig löschen“ – im
 * Lead-Panel unter „Mehr“, nur für Gründer und Admins. Löschen erst nach einer Rückfrage (`DeleteConfirm`).
 */
export function useLeadDataActions(lead: CockpitLead) {
  const access = useAccess();
  const { dispatch } = useDemo();
  const { reload, forgetLead } = useCockpit();
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportData = async () => {
    setBusy('export');
    setError(null);
    try {
      const day = new Date().toISOString().slice(0, 10);
      saveBlob(await leadsApi.exportData(lead.id), `lead-${lead.id}-${day}.json`);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Der Export hat nicht geklappt.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('delete');
    setError(null);
    try {
      const result = await leadsApi.remove(lead.id);
      forgetLead(lead.id);
      dispatch({ type: 'CLOSE_PANEL' });
      dispatch({ type: 'NOTIFY', title: `${leadName(lead)} gelöscht`, detail: result.message });
      void reload();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Löschen hat nicht geklappt.');
      setBusy(null);
    }
  };

  return { allowed: access.role !== 'assistant', busy, error, exportData, remove };
}

/** Rückfrage vor dem Löschen – im Sheet des Panels. */
export function DeleteConfirm({
  lead,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  lead: CockpitLead;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div data-testid="lead-delete-confirm">
      <p className="mx-1 text-[14px] leading-[1.55] text-ink-2">
        {leadName(lead)}, Verlauf und alle Nachrichten sind sofort weg – das lässt sich nicht rückgängig machen. Es bleibt nur ein
        anonymer Fingerabdruck, damit die Lead-Suche diese Person nie wieder vorschlägt.
      </p>
      {error && (
        <p role="alert" className="mx-1 mt-3 flex items-baseline gap-2 text-[13px] text-ink">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        data-testid="lead-delete-confirm-button"
        className="mt-4 h-[50px] w-full rounded-[14px] bg-surface-4 text-[16px] font-bold text-bad transition-transform active:scale-[0.98] disabled:opacity-50"
      >
        {busy ? 'Wird gelöscht …' : 'Endgültig löschen'}
      </button>
      <button type="button" disabled={busy} onClick={onCancel} className="mt-2 h-[46px] w-full rounded-[14px] text-[15px] font-semibold text-ink-2 hover:text-ink">
        Abbrechen
      </button>
    </div>
  );
}
