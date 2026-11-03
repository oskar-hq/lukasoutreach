import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { McpConsentInfo } from '../../../shared/mcp';
import { ApiError, mcpApi } from '../../lib/leadSearchApi';
import { rise } from '../../pages/Login';
import { Logo } from '../layout/Logo';
import { Button } from '../ui/Button';

/**
 * Freigabe für die Claude-App (`shared/mcp.ts`): Die Claude-App leitet nach `/?mcp_consent=<id>` – nach der Anmeldung
 * bestätigt man hier, dass Claude mit diesem Konto lesen und das Cockpit bedienen darf. Danach geht es zurück zu Claude.
 */
export function McpConsent({ id, onDone }: { id: string; onDone: () => void }) {
  const [info, setInfo] = useState<McpConsentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    mcpApi
      .consent(id)
      .then((result) => !cancelled && setInfo(result))
      .catch((caught) => !cancelled && setError(caught instanceof ApiError ? caught.message : 'Die Anfrage lässt sich nicht laden.'));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await mcpApi.decide(id, approve);
      window.location.assign(redirect);
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof ApiError ? caught.message : 'Das hat nicht geklappt.');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col px-4 sm:px-6" data-testid="mcp-consent">
      <header className="flex h-16 items-center">
        <Logo />
      </header>
      <motion.main
        className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center pb-24"
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } } }}
      >
        <motion.div variants={rise} className="flex h-[56px] w-[56px] items-center justify-center rounded-full border border-line-strong">
          <Sparkles className="h-6 w-6 text-ink" strokeWidth={1.6} aria-hidden />
        </motion.div>
        <motion.h1 variants={rise} className="display mt-8 text-[32px] font-semibold leading-[1.1] sm:text-[40px]">
          {info ? `${info.clientName} möchte auf das Cockpit zugreifen` : 'Claude-App verbinden'}
        </motion.h1>
        {info && (
          <motion.div variants={rise} className="mt-5 space-y-3 text-[15px] leading-relaxed text-ink-2">
            <p>Mit deinem Konto darf {info.clientName} dann:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>alle Leads, Chats und Aufgaben lesen, die du auch siehst,</li>
              <li>Aufgaben abarbeiten: Anfragen und Nachrichten senden, Antworten und Termine eintragen, Wiedervorlagen setzen,</li>
              <li>Leads ändern, als verloren markieren und Notizen schreiben.</li>
            </ul>
            <p className="text-[13.5px] text-ink-3">
              Es gelten deine Rechte, Tageslimits und Arbeitszeiten. Danach geht es zurück zu {info.redirectHost}. Trennen kannst du die Verbindung jederzeit im Tab „KI“.
            </p>
          </motion.div>
        )}
        {error && (
          <p className="mt-5 text-[14px] text-ink" role="alert" data-testid="mcp-consent-error">
            {error}
          </p>
        )}
        <motion.div variants={rise} className="mt-8 flex flex-wrap gap-2">
          {info ? (
            <>
              <Button onClick={() => void decide(true)} disabled={busy} data-testid="mcp-consent-approve">
                Zulassen
              </Button>
              <Button variant="ghost" onClick={() => void decide(false)} disabled={busy} data-testid="mcp-consent-deny">
                Ablehnen
              </Button>
            </>
          ) : (
            error && (
              <Button variant="ghost" onClick={onDone} data-testid="mcp-consent-back">
                Zum Cockpit
              </Button>
            )
          )}
        </motion.div>
      </motion.main>
    </div>
  );
}
