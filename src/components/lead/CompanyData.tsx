import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SOCIAL_LABELS, type CompanySocials, type EnrichmentStatusResponse } from '../../../shared/enrichment';
import type { CockpitLead } from '../../../shared/leads';
import { ApiError, enrichmentApi, leadsApi } from '../../lib/leadSearchApi';
import { readableError } from '../../lib/leadView';
import { formatRelative } from '../../lib/time';
import { useCockpit } from '../../state/cockpit';
import { Button } from '../ui/Button';
import { safeHref } from '../../lib/safeHref';
import { Eyebrow } from './Eyebrow';

/** Solange die Anfrage läuft (Clay: Sekunden bis Minuten), so oft nachfragen – und nach dieser Zeit aufgeben. */
const POLL_MS = 2500;
const POLL_GIVE_UP_MS = 5 * 60_000;

const yesNo = (value: boolean | null) => (value === null ? 'unbekannt' : value ? 'ja' : 'nein');

/** Firmendaten (Treg oder Clay, `shared/enrichment.ts`): anzeigen oder auf Knopfdruck holen. */
export function CompanyData({ lead, disabled }: { lead: CockpitLead; disabled: boolean }) {
  const { ensureDetail, mutateLead } = useCockpit();
  const [status, setStatus] = useState<EnrichmentStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enrichment = lead.enrichment ?? null;
  const pending = enrichment?.status === 'pending';

  useEffect(() => {
    let cancelled = false;
    enrichmentApi
      .status()
      .then((response) => !cancelled && setStatus(response))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enrichment?.status]);

  // Ergebnis steht aus: Lead neu laden, bis es da ist.
  useEffect(() => {
    const requestedAt = enrichment?.requestedAt;
    if (!pending || !requestedAt) return;
    const timer = window.setInterval(() => {
      if (Date.now() - requestedAt > POLL_GIVE_UP_MS) window.clearInterval(timer);
      else ensureDetail(lead.id, true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, enrichment?.requestedAt, lead.id, ensureDetail]);

  const off = status?.mode === 'off';
  const limitReached = !!status && status.usedToday >= status.dailyLimit;
  const canRequest = !off && !pending && enrichment?.status !== 'done';

  const request = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await mutateLead(() => leadsApi.enrich(lead.id), lead.id);
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.code === 'enrichment_limit'
            ? 'Tageslimit für Firmendaten erreicht – morgen wieder.'
            : failure.code === 'enrichment_off'
              ? 'Firmendaten sind nicht eingerichtet (Einstellungen).'
              : readableError(failure, 'Firmendaten konnten nicht geholt werden.')
          : 'Firmendaten konnten nicht geholt werden.',
      );
    } finally {
      setBusy(false);
    }
  };

  const socials = enrichment
    ? (Object.entries(enrichment.socials) as [keyof CompanySocials, string | null][]).filter((entry): entry is [keyof CompanySocials, string] => !!entry[1])
    : [];

  return (
    <section data-testid="company-data">
      <Eyebrow>Firmendaten</Eyebrow>
      <div className="rounded-2xl bg-surface-3 p-3.5">

      {enrichment?.status === 'done' && (
        // Ersetzt den Lade-Satz: kurz einblenden, ohne Verschiebung – das ist Inhalt zum Lesen.
        <div className="transition-opacity duration-150 ease-out starting:opacity-0">
          <dl className="space-y-1.5 text-[13px]">
            {(
              [
                ['Mitarbeiter', enrichment.employeesRange ?? (enrichment.employees !== null ? String(enrichment.employees) : '')],
                ['Umsatz (Schätzung)', enrichment.revenue ?? ''],
                ['Meta-Pixel', yesNo(enrichment.metaPixel)],
                ['Google Tag Manager', yesNo(enrichment.googleTagManager)],
                ...(enrichment.techStack.length > 0 ? [['Website', enrichment.techStack.join(' · ')] as const] : []),
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="flex gap-4">
                <dt className="w-36 shrink-0 text-ink-3">{label}</dt>
                <dd className="min-w-0 break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          {socials.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
              {socials.map(([key, url]) => (
                <a key={key} href={safeHref(url)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-ink hover:underline">
                  {SOCIAL_LABELS[key]}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </a>
              ))}
            </p>
          )}
          <p className="mt-2 text-[12px] text-ink-3">
            {enrichment.source === 'mock' ? 'Beispieldaten' : enrichment.source === 'clay' ? 'Von Clay' : 'Von Treg'}
            {enrichment.receivedAt ? ` · ${formatRelative(enrichment.receivedAt)}` : ''}
          </p>
        </div>
      )}

      {pending && (
        <p role="status" className="flex items-center gap-2 text-[13.5px] text-ink-2">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.75px] border-white/20 border-t-ink" aria-hidden />
          {/* Sagen, was gerade gelesen wird (Labor Illusion, Wunsch des Nutzers 25.10.) – die Felder unten kommen genau daher. */}
          {domainOf(lead.company.website) ? `Liest ${domainOf(lead.company.website)} · Mitarbeiter, Umsatz, Tracking …` : 'Firmendaten werden geholt …'}
        </p>
      )}

      {enrichment?.status === 'failed' && <p className="mb-3 text-[13.5px] text-ink-2">{enrichment.error ?? 'Es kamen keine Firmendaten zurück.'}</p>}

      {!enrichment && off && <p className="text-[13.5px] text-ink-3">Firmendaten sind nicht eingerichtet (Einstellungen).</p>}

      {canRequest && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button variant="secondary" size="sm" onClick={() => void request()} disabled={busy || disabled || limitReached} aria-busy={busy}>
            {busy ? 'Wird geholt …' : enrichment?.status === 'failed' ? 'Erneut versuchen' : 'Firmendaten holen'}
          </Button>
          {status && (
            <span className="text-[12px] tabular-nums text-ink-3">
              {limitReached ? 'Tageslimit erreicht' : `heute ${status.usedToday} von ${status.dailyLimit}`}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 flex items-baseline gap-2 text-[12.5px] text-ink">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {error}
        </p>
      )}
      </div>
    </section>
  );
}

/** „https://www.beispiel.de/kontakt“ → „beispiel.de“ – null ohne lesbare Adresse. */
function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
