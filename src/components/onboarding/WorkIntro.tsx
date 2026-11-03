import { AnimatePresence, motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { authRole, workingFounders, type AuthUser } from '../../../shared/auth';
import { FOUNDERS } from '../../data/founders';
import { cn } from '../../lib/cn';
import { useHotkeys } from '../../lib/useHotkeys';
import { EASE_OUT } from '../../lib/motion';
import { useAuth } from '../../state/auth';
import { Logo } from '../layout/Logo';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';

interface Slide {
  eyebrow: string;
  title: string;
  text: string;
  visual: ReactNode;
}

/** „Nick“, „Nick und Johannes“ */
const namesOf = (user: AuthUser) => workingFounders(user).map((id) => FOUNDERS[id].name).join(' und ');

function slidesFor(user: AuthUser): Slide[] {
  const role = authRole(user);
  const founders = namesOf(user);
  const several = workingFounders(user).length > 1;
  const forWhom =
    role === 'assistant'
      ? several
        ? `Du arbeitest für ${founders} – oben rechts wechselst du, wessen Stapel du gerade abarbeitest.`
        : `Du arbeitest für ${founders}.`
      : 'Das ist dein eigener Stapel.';
  const handover = role === 'assistant' ? `Wird es ernst, übergibst du den Lead an ${founders}.` : 'Wird es ernst, übergibst du den Lead ans CRM.';
  return [
    {
      eyebrow: 'Dein Tag',
      title: 'Jeden Morgen liegt ein Stapel bereit.',
      text: `${forWhom} Das Cockpit sucht passende Leads und legt dir hin, was heute dran ist: neue Kontakte, Follow-ups und Antworten.`,
      visual: (
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-[12px] font-semibold text-ink-3">Heute</p>
          <p className="text-[96px] font-semibold leading-none tracking-[-0.04em] sm:text-[112px]">23</p>
          <p className="text-[14.5px] text-ink-2">Aufgaben · neue Leads, Follow-ups, Antworten</p>
        </div>
      ),
    },
    {
      eyebrow: 'Eine Aufgabe',
      title: 'Eine Aufgabe, zwei Entscheidungen.',
      text: 'Du siehst immer nur einen Lead, mit allem, was du zur Entscheidung brauchst. Passt er, vernetzt du dich. Passt er nicht, sortierst du ihn aus. Dann kommt der nächste.',
      visual: (
        <div className="flex w-full flex-col gap-4">
          <p className="text-[12.5px] text-ink-3">Beispiel</p>
          <div>
            <p className="text-[26px] font-semibold tracking-[-0.025em]">[Lead-Name]</p>
            <p className="mt-1 text-[14px] text-ink-2">Geschäftsführung · [Firma]</p>
          </div>
          <p className="flex items-center gap-2 text-[14px]">
            <span className="h-1.5 w-1.5 rounded-full bg-good" aria-hidden />
            Passt laut KI zur Zielgruppe
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <span className="flex h-11 items-center justify-center gap-2 rounded-full bg-surface-3 text-[14px] font-medium">
              Aussortieren <Kbd>←</Kbd>
            </span>
            <span className="flex h-11 items-center justify-center gap-2 rounded-full bg-ink text-[14px] font-medium text-black">
              Vernetzen <Kbd tone="dark">↵</Kbd>
            </span>
          </div>
        </div>
      ),
    },
    {
      eyebrow: 'Schneller',
      title: 'Mit der Tastatur geht es doppelt so schnell.',
      text: 'Die Kürzel stehen auf jedem Knopf. Vertippt? Z macht die letzte Entscheidung rückgängig – ohne Nachfrage.',
      visual: (
        <div className="grid w-full grid-cols-2 gap-3">
          {[
            ['↵', 'Haupt-Aktion'],
            ['←', 'Aussortieren'],
            ['Z', 'Rückgängig'],
            ['Esc', 'Zurück'],
          ].map(([key, label]) => (
            <div key={key} className="flex flex-col gap-3 rounded-2xl bg-surface-2 p-4">
              <span className="flex h-11 min-w-11 items-center justify-center self-start rounded-[10px] border border-b-[3px] border-white/20 px-3 text-[15px] font-semibold">
                {key}
              </span>
              <span className="text-[14px] text-ink-2">{label}</span>
            </div>
          ))}
        </div>
      ),
    },
    {
      eyebrow: 'Antworten',
      title: 'Antworten schreibst du mit Vorschlag.',
      text: `Schreibt ein Lead zurück, liegt ein Antwortvorschlag schon bereit. Du passt ihn an und sendest. ${handover}`,
      visual: (
        <div className="flex w-full flex-col gap-3">
          <p className="flex items-center gap-2 text-[13px] text-ink-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            Neue Antwort
          </p>
          <p className="max-w-[85%] self-start rounded-[18px] rounded-bl-md bg-surface-3 px-4 py-3 text-[14.5px] leading-relaxed">
            Klingt spannend. Können wir nächste Woche kurz telefonieren?
          </p>
          <div className="max-w-[85%] self-end rounded-[18px] rounded-br-md bg-surface-4 px-4 py-3 text-[14.5px] leading-relaxed text-ink-2">
            Gern! Passt dir Dienstag um 10 Uhr?
            <p className="mt-2 text-[12px] text-ink-3">Vorschlag · anpassen oder senden</p>
          </div>
        </div>
      ),
    },
  ];
}

/** Einarbeitung neuer Gründer und Mitarbeiter (`onboarding: 'intro'`): vier kurze Folien, dann der erste Stapel. */
export function WorkIntro({ user }: { user: AuthUser }) {
  const { finishOnboarding } = useAuth();
  const slides = slidesFor(user);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = index === slides.length - 1;
  const slide = slides[index];

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    setError(null);
    try {
      await finishOnboarding();
    } catch {
      setFinishing(false);
      setError('Das hat nicht geklappt – der Server antwortet nicht. Versuch es gleich noch einmal.');
    }
  };
  const next = () => {
    if (last) void finish();
    else {
      setDirection(1);
      setIndex(index + 1);
    }
  };
  const back = () => {
    if (index === 0) return;
    setDirection(-1);
    setIndex(index - 1);
  };
  useHotkeys({ enter: next, arrowright: next, arrowleft: back });

  return (
    <div className="flex min-h-dvh flex-col px-4 pb-8 sm:px-8 lg:px-24" data-testid="work-intro">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <Button variant="ghost" size="sm" onClick={() => void finish()} disabled={finishing} data-testid="intro-skip">
          Einführung überspringen
        </Button>
      </header>

      <main className="grid flex-1 items-center gap-10 py-6 lg:grid-cols-2 lg:gap-20">
        <AnimatePresence mode="wait" initial={false} custom={direction}>
          <motion.div
            key={index}
            custom={direction}
            initial={{ opacity: 0, x: 24 * direction }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 * direction }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
            className="flex flex-col gap-5"
          >
            <p className="text-[12px] font-semibold text-ink-3">
              {index + 1} von {slides.length} · {slide.eyebrow}
            </p>
            <h1 className="display text-[36px] font-semibold sm:text-[52px]" data-testid="intro-title">
              {slide.title}
            </h1>
            <p className="max-w-[480px] text-[16px] leading-relaxed text-ink-2 sm:text-[17px]">{slide.text}</p>
          </motion.div>
        </AnimatePresence>

        <div className="flex min-h-[340px] items-center justify-center rounded-[24px] bg-surface-2 p-6 sm:min-h-[420px] sm:p-10" aria-hidden>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={index}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.3, ease: EASE_OUT }}
              className="flex w-full max-w-[420px] justify-center"
            >
              {slide.visual}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {error && (
        <p role="alert" className="mb-4 flex items-baseline gap-2 text-[14px] text-ink">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {error}
        </p>
      )}
      <footer className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2" aria-label={`Folie ${index + 1} von ${slides.length}`}>
          {slides.map((_, i) => (
            <span key={i} className={cn('h-1.5 rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none', i === index ? 'w-6 bg-ink' : 'w-1.5 bg-white/20')} />
          ))}
        </div>
        <div className="flex gap-2">
          {index > 0 && (
            <Button variant="secondary" size="lg" onClick={back} shortcut="←" shortcutPosition="start">
              Zurück
            </Button>
          )}
          <Button variant="primary" size="lg" onClick={next} disabled={finishing} shortcut="↵" data-testid="intro-next">
            {last ? (finishing ? 'Einen Moment…' : 'Ersten Stapel öffnen') : 'Weiter'}
          </Button>
        </div>
      </footer>
    </div>
  );
}
