import { useEffect, useState } from 'react';
import { accountsApi } from '../../lib/leadSearchApi';

/** So oft schaut das Cockpit nach neuen Registrierungen (zusätzlich beim Zurückkehren in den Tab). */
const POLL_MS = 120_000;

/**
 * Wie viele selbst registrierte Konten auf Freigabe warten – für den Hinweis am Konto-Menü. Nur für Konten, die
 * Konten verwalten dürfen; Fehler (offline, älteres Backend) zählen als 0.
 */
export function useWaitingRegistrations(enabled: boolean, refreshKey: unknown = null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      accountsApi
        .list({ signal: current.signal })
        .then((response) => !current.signal.aborted && setCount(response.accounts.filter((account) => account.awaitingApproval).length))
        .catch(() => {});
    };
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, POLL_MS);
    return () => {
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [enabled, refreshKey]);
  return count;
}
