import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatSyncStatus } from '../../../shared/linkedin';
import { cn } from '../../lib/cn';
import { ApiError, linkedinApi } from '../../lib/leadSearchApi';
import { useCockpit } from '../../state/cockpit';
import { Button } from '../ui/Button';
import { HEADING } from './look';

const POLL_MS = 2000;

/** „3 Nachrichten in 2 Chats übernommen.“ bzw. „Nichts Neues …“ plus Probleme. */
function summary(status: ChatSyncStatus): string {
  const result =
    status.imported === 0
      ? `Nichts Neues – ${status.leadsDone === 1 ? 'ein Chat' : `${status.leadsDone} Chats`} geprüft.`
      : `${status.imported === 1 ? 'Eine Nachricht' : `${status.imported} Nachrichten`} in ${status.leadsUpdated === 1 ? 'einem Chat' : `${status.leadsUpdated} Chats`} übernommen.`;
  return [result, ...status.problems].join(' ');
}

/**
 * Chats nachträglich mit LinkedIn abgleichen (Wunsch des Nutzers 19.10., nach der Sperre eines Gründer-Accounts). Seit
 * 20.10. unter Einstellungen → LinkedIn statt in den Chats und erst nach Rückfrage – es ist für Ausnahmen gedacht, neue
 * Nachrichten holt der automatische Abgleich. Läuft im Hintergrund mit Pausen; der Fortschritt steht am Knopf.
 */
export function ChatSync() {
  const { refresh } = useCockpit();
  const [status, setStatus] = useState<ChatSyncStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number | null>(null);
  const running = !!status?.running;

  const poll = useCallback(async () => {
    try {
      const next = await linkedinApi.chatSyncStatus();
      setStatus(next);
      if (next.running) {
        timer.current = window.setTimeout(() => void poll(), POLL_MS);
      } else {
        setMessage(summary(next));
        refresh();
      }
    } catch {
      setMessage('Der Stand des Abgleichs ließ sich nicht laden.');
    }
  }, [refresh]);

  // Lief beim Öffnen schon ein Abgleich (z. B. vom anderen Gründer gestartet): Fortschritt weiter zeigen.
  useEffect(() => {
    linkedinApi
      .chatSyncStatus()
      .then((current) => {
        if (current.running) {
          setStatus(current);
          void poll();
        }
      })
      .catch(() => undefined);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [poll]);

  const start = async () => {
    setConfirming(false);
    setMessage(null);
    try {
      setStatus(await linkedinApi.chatSync());
      void poll();
    } catch (error) {
      setMessage(error instanceof ApiError && error.message ? error.message : 'Der Abgleich ließ sich nicht starten.');
    }
  };

  return (
    <section aria-labelledby="chat-sync-title" data-testid="chat-sync">
      <h3 id="chat-sync-title" className={HEADING}>
        Chats nachträglich abgleichen
      </h3>
      <p className="mt-1.5 max-w-[60ch] text-[13px] leading-relaxed text-ink-2">
        Nur für Ausnahmen, z. B. nachdem ein Account gesperrt oder bei Unipile getrennt war: holt für alle vernetzten Leads
        den LinkedIn-Verlauf und übernimmt fehlende Nachrichten. Neue Nachrichten holt das Cockpit sonst von selbst.
      </p>
      <div className="mt-4">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="chat-sync-confirm">
            <span className="text-[13px] text-ink">Wirklich starten? Das dauert bei vielen Chats einige Minuten.</span>
            <Button size="sm" variant="primary" onClick={() => void start()} data-testid="chat-sync-confirm-start">
              Abgleich starten
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Abbrechen
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirming(true)}
            disabled={running}
            aria-busy={running}
            icon={<RefreshCw className={cn('h-4 w-4', running && 'animate-spin motion-reduce:animate-none')} aria-hidden />}
            data-testid="chat-sync-start"
          >
            {running ? `Abgleich läuft … ${status!.leadsDone} von ${status!.leadsTotal}` : 'Chats abgleichen'}
          </Button>
        )}
      </div>
      {message && (
        <p role="status" className="mt-2 text-[13px] leading-snug text-ink-2" data-testid="chat-sync-result">
          {message}
        </p>
      )}
    </section>
  );
}
