import { ArrowLeft, Check, FileSpreadsheet, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { TrackingSummary } from '../../../shared/leadSearch';
import { cn } from '../../lib/cn';
import { ApiError, leadSearchApi } from '../../lib/leadSearchApi';
import { Logo } from '../layout/Logo';
import { Button } from '../ui/Button';

const dateTime = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Einrichtung, Schritt „Bisherige Leads“: dieselbe Excel-Liste wie bei der Lead-Suche (Tracking-Liste,
 * `PUT /api/lead-search/tracking`). Jedes LinkedIn-Profil darin landet in der Datenbank und wird bei jeder Suche als
 * Dublette aussortiert – wer schon angeschrieben wurde, kommt nicht wieder.
 */
export function HistoryStep({
  summary,
  onSummary,
  onBack,
  onNext,
}: {
  summary: TrackingSummary | null;
  onSummary: (summary: TrackingSummary | null) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<{ text: string; id: number } | null>(null);
  const counter = useRef(0);

  // Schon eine Liste auf dem Server (z. B. Einrichtung neu geöffnet)? Dann zeigen statt neu verlangen.
  useEffect(() => {
    if (summary) return;
    let cancelled = false;
    leadSearchApi
      .config()
      .then((config) => !cancelled && config.tracking && onSummary(config.tracking))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Nur beim ersten Öffnen nachsehen.
  }, []);

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!/\.xlsx$/i.test(file.name)) {
      setError({ text: 'Bitte eine Excel-Datei (.xlsx) wählen.', id: ++counter.current });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSummary(await leadSearchApi.uploadTracking(file));
    } catch (caught) {
      setError({ text: caught instanceof ApiError ? caught.message : 'Die Datei konnte nicht gelesen werden.', id: ++counter.current });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    void upload(event.dataTransfer.files?.[0]);
  };

  const setters = summary
    ? Object.entries(summary.bySetter)
        .map(([name, count]) => `${name} ${count}`)
        .join(' · ')
    : '';

  return (
    <>
      <header className="flex h-16 items-center justify-between px-4 sm:px-8 lg:px-16">
        <Logo />
        <span className="text-[12.5px] text-ink-3">Fast fertig</span>
      </header>
      <main className="mx-auto flex max-w-[860px] flex-col px-4 pb-12 pt-6 sm:px-8 sm:pt-10" data-testid="setup-history">
        <p className="text-[12px] font-semibold text-ink-3">Bisherige Leads · Optional</p>
        <h1 className="display mt-3 text-[30px] font-semibold sm:text-[40px]">Wen habt ihr schon angeschrieben?</h1>
        <p className="mt-4 max-w-[680px] text-[16px] leading-relaxed text-ink-2">
          Lade eure bisherige Outreach-Liste hoch – dieselbe Excel-Datei wie bei der Lead-Suche. Jedes LinkedIn-Profil darin
          kommt in die Datenbank und wird bei jeder Suche aussortiert. So schreibt niemand denselben Lead zweimal an.
        </p>

        <div className="mt-8 grid gap-8 sm:grid-cols-[minmax(0,1fr)_240px]">
          <div>
            {summary ? (
              <div role="status" className="rounded-[20px] border border-good/25 bg-good/[0.06] p-5 sm:p-6" data-testid="setup-history-ok">
                <p className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
                  <Check className="h-4 w-4 text-good" strokeWidth={2.6} aria-hidden />
                  <span>
                    <span className="tabular-nums">{summary.count}</span> Profile übernommen
                  </span>
                </p>
                <p className="mt-2 break-words text-[13.5px] leading-relaxed text-ink-2">
                  {summary.fileName}
                  {setters && ` · ${setters}`} · Stand {dateTime.format(summary.updatedAt)}
                </p>
                <button
                  type="button"
                  onClick={() => input.current?.click()}
                  disabled={busy}
                  className="mt-4 inline-flex min-h-11 items-center gap-2 text-[14px] font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
                >
                  {busy ? 'Wird eingelesen …' : 'Andere Datei hochladen (ersetzt die Liste)'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => input.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                disabled={busy}
                aria-busy={busy}
                data-testid="setup-history-drop"
                className={cn(
                  'flex min-h-[200px] w-full flex-col items-center justify-center gap-3 rounded-[20px] border border-dashed px-6 py-10 text-center transition-colors',
                  dragging ? 'border-ink bg-surface-3' : 'border-line-strong bg-surface-1 hover:border-white/30',
                )}
              >
                {busy ? (
                  <>
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-white" aria-hidden />
                    <span className="text-[14.5px] text-ink-2">Liste wird eingelesen …</span>
                  </>
                ) : (
                  <>
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-3">
                      <Upload className="h-5 w-5 text-ink" aria-hidden />
                    </span>
                    <span className="text-[15px] font-semibold text-ink">Excel-Datei hierher ziehen oder auswählen</span>
                    <span className="text-[13px] text-ink-3">.xlsx · alle Blätter werden gelesen</span>
                  </>
                )}
              </button>
            )}
            {error && (
              <p key={error.id} role="alert" className="mt-4 flex items-baseline gap-2 text-[14px] leading-snug text-ink" data-testid="setup-history-error">
                <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
                {error.text}
              </p>
            )}
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              data-testid="setup-history-file"
              onChange={(event) => void upload(event.target.files?.[0])}
            />
          </div>

          <div className="text-[13.5px] leading-relaxed text-ink-2">
            <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
              So sieht die Datei aus
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              <li>Irgendwo in einer Zeile steht ein LinkedIn-Link (linkedin.com/in/…).</li>
              <li>Optional: Spalten „Setter“ und „Anfrage angenommen“ – dann sieht man, wer angeschrieben hat.</li>
              <li>Später ersetzen oder entfernen: Lead-Suche → Tracking-Liste.</li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" size="lg" onClick={onBack} icon={<ArrowLeft className="h-4 w-4" />}>
            Zurück
          </Button>
          <Button variant="primary" size="lg" onClick={onNext} disabled={busy} data-testid="setup-history-next">
            {summary ? 'Weiter' : 'Ohne Liste weiter'}
          </Button>
        </div>
      </main>
    </>
  );
}
