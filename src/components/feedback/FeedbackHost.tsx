import { Check, ImagePlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import {
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGES_MAX,
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_TEXT_MAX,
  type FeedbackItem,
  type FeedbackKind,
} from '../../../shared/feedback';
import { cn } from '../../lib/cn';
import { formatShortDate } from '../../lib/format';
import { ApiError, feedbackApi } from '../../lib/leadSearchApi';
import { currentView, recentErrors, recentTrail } from '../../lib/telemetry';
import { useDemo } from '../../state/demo';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { onOpenFeedback } from './feedbackBus';

/**
 * Feedback vom Kunden (Vertrag `shared/feedback.ts`, Wunsch des Nutzers 09.11.: „so angenehm und schnell wie
 * möglich“). Ein Textfeld, Senden – fertig. Von selbst kommen mit: ein Bildschirmfoto der Seite dahinter (abwählbar),
 * Ansicht, offener Lead, die letzten Schritte, Fehler und gescheiterte Anfragen, Gerät. Eigene Bilder per Einfügen
 * (⌘V), Ziehen oder Knopf. Erreichbar von überall: Knopf oben, Konto-Menü, Glocke, Anzeigefehler und ⌥F – auch
 * während ein anderes Fenster offen ist.
 */

interface Picture {
  src: string;
  auto: boolean;
}

const MAX_SIDE = 1600;

/** Bild verkleinern (längste Seite `MAX_SIDE`) und als JPEG – hält Uploads klein, auch Fotos vom Handy. */
async function shrink(file: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.82);
    return url.length * 0.75 <= FEEDBACK_IMAGE_MAX_BYTES ? url : canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}

/** Bildschirmfoto des sichtbaren Bereichs – ohne das Feedback-Fenster selbst. Scheitert es, eben ohne. */
async function captureScreen(skip: Element | null): Promise<string | null> {
  try {
    const { domToCanvas } = await import('modern-screenshot');
    const scale = Math.min(2, MAX_SIDE / window.innerWidth);
    const canvas = await domToCanvas(document.body, {
      scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#000',
      filter: (node) => !(skip && node === skip),
      timeout: 4000,
    });
    // Nur der sichtbare Ausschnitt (die Seite kann lang sein).
    const crop = document.createElement('canvas');
    crop.width = Math.round(window.innerWidth * scale);
    crop.height = Math.round(window.innerHeight * scale);
    crop.getContext('2d')?.drawImage(canvas, 0, -Math.round(window.scrollY * scale));
    const url = crop.toDataURL('image/jpeg', 0.75);
    return url.length * 0.75 <= FEEDBACK_IMAGE_MAX_BYTES ? url : crop.toDataURL('image/jpeg', 0.5);
  } catch {
    return null;
  }
}

export function FeedbackHost() {
  const { state } = useDemo();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<FeedbackItem | null>(null);
  const [mine, setMine] = useState<FeedbackItem[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Lead, der beim Öffnen offen war (das Panel kann sich danach schließen).
  const leadRef = useRef<string | null>(null);
  const viewRef = useRef<string | null>(null);
  const panelLeadId = state.panelLeadId;

  const start = useCallback(
    (prefill?: string) => {
      leadRef.current = panelLeadId;
      viewRef.current = currentView();
      setText(prefill ?? '');
      setKind(prefill ? 'bug' : null);
      setPictures([]);
      setError(null);
      setSent(null);
      setOpen(true);
      setCapturing(true);
      feedbackApi
        .mine()
        .then((list) => setMine(list.items))
        .catch(() => setMine(null));
    },
    [panelLeadId],
  );

  useEffect(() => onOpenFeedback(({ prefill }) => start(prefill)), [start]);

  // ⌥F (Option+F) öffnet überall – auch in einem offenen Fenster oder Textfeld.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyF') {
        event.preventDefault();
        if (!open) start();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, start]);

  // Bildschirmfoto der Seite dahinter, sobald das Fenster steht (das Fenster selbst wird ausgelassen).
  useEffect(() => {
    if (!open || !capturing) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      const dialog = document.querySelector('[data-testid="feedback-dialog"]')?.closest('.fixed') ?? null;
      void captureScreen(dialog).then((src) => {
        if (cancelled) return;
        setCapturing(false);
        if (src) setPictures((list) => [{ src, auto: true }, ...list].slice(0, FEEDBACK_IMAGES_MAX));
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [open, capturing]);

  const addFiles = async (files: Iterable<Blob>) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const src = await shrink(file);
      if (src) setPictures((list) => (list.length >= FEEDBACK_IMAGES_MAX ? list : [...list, { src, auto: false }]));
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    const images = [...event.clipboardData.items].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
    if (images.length) {
      event.preventDefault();
      void addFiles(images);
    }
  };

  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  };

  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const item = await feedbackApi.create({
        kind,
        text: text.trim(),
        images: pictures.map((picture) => picture.src),
        context: {
          view: viewRef.current,
          leadId: leadRef.current,
          path: `${window.location.pathname}${window.location.search}`,
          trail: recentTrail(),
          errors: recentErrors(),
          version: null,
          device: {
            width: window.innerWidth,
            height: window.innerHeight,
            standalone: window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
            touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
            userAgent: navigator.userAgent,
          },
        },
      });
      setSent(item);
      setMine((list) => [item, ...(list ?? [])]);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Senden hat nicht geklappt – versuch es bitte noch einmal.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) setOpen(false);
  };

  const earlier = (mine ?? []).filter((item) => item.id !== sent?.id).slice(0, 5);

  return (
    <Modal open={open} onClose={close} labelledBy="feedback-title" className="sm:max-w-[560px]">
      <div className="p-6 sm:p-8" data-testid="feedback-dialog" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
        {sent ? (
          <div data-testid="feedback-sent">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black">
              <Check className="h-5 w-5" aria-hidden />
            </span>
            <h2 id="feedback-title" className="mt-5 text-[20px] font-semibold">
              Danke – ist angekommen.
            </h2>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
              Meldung #{sent.number}. Sobald sich etwas tut, siehst du es in der Glocke oben.
            </p>
            <MyReports items={earlier} />
            <div className="mt-7 flex justify-end">
              <Button variant="primary" shortcut="↵" onClick={() => setOpen(false)} data-testid="feedback-done" autoFocus>
                Fertig
              </Button>
            </div>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            // ⌘↵ / Strg+↵ sendet – egal, wo im Fenster der Fokus gerade ist.
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          >
            <h2 id="feedback-title" className="text-[20px] font-semibold">
              Feedback
            </h2>
            <p className="mt-1 text-[14px] leading-relaxed text-ink-3">Was geht nicht, was wünschst du dir? Wo du gerade bist, sehen wir von selbst.</p>

            <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Art (optional)">
              {FEEDBACK_KINDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => setKind(kind === option ? null : option)}
                  data-testid={`feedback-kind-${option}`}
                  className={cn(
                    'h-8 rounded-full px-3 text-[13px] font-medium transition-colors',
                    kind === option ? 'bg-white text-black' : 'bg-surface-3 text-ink-2 hover:bg-surface-4 hover:text-ink',
                  )}
                >
                  {FEEDBACK_KIND_LABELS[option]}
                </button>
              ))}
            </div>

            <label htmlFor="feedback-text" className="sr-only">
              Deine Nachricht
            </label>
            <textarea
              ref={textRef}
              id="feedback-text"
              autoFocus
              rows={5}
              maxLength={FEEDBACK_TEXT_MAX}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onPaste={onPaste}
              placeholder="z. B. „Beim Klick auf Senden passiert nichts“ oder „Ich hätte gern …“"
              className="mt-3 w-full resize-none rounded-2xl border border-transparent bg-surface-3 px-4 py-3 text-[16px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent"
              data-testid="feedback-text"
            />

            <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="feedback-pictures">
              {pictures.map((picture, index) => (
                <figure key={picture.src.slice(-40) + index} className="relative h-16 w-24 overflow-hidden rounded-lg bg-surface-3">
                  <img src={picture.src} alt={picture.auto ? 'Bildschirmfoto' : `Bild ${index + 1}`} className="h-full w-full object-cover object-top" />
                  {picture.auto && <figcaption className="absolute inset-x-0 bottom-0 bg-black/70 px-1 text-center text-[10.5px] text-ink-2">Bildschirm</figcaption>}
                  <button
                    type="button"
                    aria-label={picture.auto ? 'Bildschirmfoto nicht mitschicken' : 'Bild entfernen'}
                    onClick={() => setPictures((list) => list.filter((_, at) => at !== index))}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-ink hover:bg-black"
                    data-testid={picture.auto ? 'feedback-remove-screenshot' : 'feedback-remove-image'}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </figure>
              ))}
              {capturing && (
                <span className="flex h-16 w-24 items-center justify-center rounded-lg bg-surface-3 text-[11.5px] text-ink-3" data-testid="feedback-capturing">
                  Bildschirm …
                </span>
              )}
              {pictures.length < FEEDBACK_IMAGES_MAX && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-16 items-center gap-1.5 rounded-lg px-3 text-[13px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
                  data-testid="feedback-add-image"
                >
                  <ImagePlus className="h-4 w-4" aria-hidden />
                  Bild
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) void addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>

            {error && (
              <p role="alert" className="mt-3 flex items-baseline gap-2 text-[14px] text-ink" data-testid="feedback-error">
                <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
                {error}
              </p>
            )}

            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="hidden text-[12px] text-ink-4 sm:block">⌘V fügt Bilder ein · ⌥F öffnet überall</p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={close} disabled={busy}>
                  Abbrechen
                </Button>
                <Button type="submit" variant="primary" shortcut={busy ? undefined : '⌘↵'} disabled={busy || !text.trim()} data-testid="feedback-send">
                  {busy ? 'Senden …' : 'Senden'}
                </Button>
              </div>
            </div>
            <MyReports items={earlier} />
          </form>
        )}
      </div>
    </Modal>
  );
}

/** Deine letzten Meldungen mit Stand und Antwort – damit niemand nachfragen muss, was daraus wurde. */
function MyReports({ items }: { items: FeedbackItem[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-7 border-t border-white/[0.06] pt-5" aria-labelledby="feedback-mine" data-testid="feedback-mine">
      <h3 id="feedback-mine" className="text-[12px] font-semibold text-ink-3">
        Deine letzten Meldungen
      </h3>
      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            <p className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate text-ink-2">
                #{item.number} · {item.text}
              </span>
              <span className={cn('shrink-0 text-[12px]', item.status === 'done' ? 'text-ink' : 'text-ink-3')}>
                {FEEDBACK_STATUS_LABELS[item.status]} · {formatShortDate(item.updatedAt)}
              </span>
            </p>
            {item.answer && <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">↳ {item.answer}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
