import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DashboardDay } from '../../../shared/dashboard';
import { FOUNDERS } from '../../data/founders';
import { cn } from '../../lib/cn';
import { dashboardApi } from '../../lib/leadSearchApi';
import { formatDuration } from '../../lib/time';
import type { CardState, FounderId } from '../../state/types';
import { Button } from '../ui/Button';
import { daySummary } from './summary';
import { EASE_OUT } from '../../lib/motion';

/**
 * „Alles erledigt“ – der Moment, der sich lohnen soll (Wunsch des Nutzers 07.10.): grüner Haken, Konfetti,
 * die Tagesbilanz in vier Zahlen und die Serie „Tage in Folge“. Seltene Momente dürfen glänzen (DESIGN.md §1.4);
 * mit „Bewegung reduzieren“ bleibt alles ruhig und ohne Konfetti.
 */
export function SuccessScreen({
  cards,
  founder,
  onNext,
  nextLabel = 'Zum Dashboard',
  celebrate = true,
}: {
  cards: CardState[];
  founder: FounderId;
  onNext: () => void;
  nextLabel?: string;
  /** Konfetti beim Erscheinen – auf der Startseite (späterer Besuch) aus. */
  celebrate?: boolean;
}) {
  const reduced = useReducedMotion();
  const [round, setRound] = useState(celebrate ? 1 : 0);
  const summary = daySummary(cards);
  const count = (label: string) => summary.stats.find((stat) => stat.label === label)?.value ?? 0;
  const tiles = [
    { label: 'Aufgaben', value: summary.done },
    { label: 'Anfragen', value: count('Vernetzungsanfragen') },
    { label: 'Nachrichten', value: summary.messages },
    { label: 'Übergaben', value: count('Übergaben an Close') },
  ];
  const streak = useStreak(founder);
  const firstName = FOUNDERS[founder]?.name.split(' ')[0];

  return (
    <div className="relative flex w-full flex-col items-center" data-testid="success-screen">
      {!reduced && round > 0 && <Confetti key={round} seed={round} />}

      {/* Grüner Schein hinter dem Haken – pulsiert leise. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -top-16 h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgb(48_209_88/0.28),transparent_65%)]"
        initial={{ opacity: 0 }}
        animate={reduced ? { opacity: 0.45 } : { opacity: [0.35, 0.6, 0.35] }}
        transition={reduced ? { duration: 0 } : { duration: 3, repeat: Infinity, ease: 'easeInOut' }}
      />

      <motion.div
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', bounce: 0.45, duration: 0.7, delay: 0.1 }}
        className="relative flex h-24 w-24 items-center justify-center rounded-full bg-good sm:h-28 sm:w-28"
      >
        <svg viewBox="0 0 24 24" className="h-12 w-12 sm:h-14 sm:w-14" fill="none" stroke="#000" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            initial={{ pathLength: reduced ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.45, delay: 0.45, ease: EASE_OUT }}
          />
        </svg>
      </motion.div>

      <Rise delay={0.5}>
        <h1 className="display mt-8 text-center text-[44px] font-semibold leading-[1.05] sm:text-[56px]">Alles erledigt!</h1>
      </Rise>
      <Rise delay={0.6}>
        <p className="mt-3 text-center text-[17px] text-ink-2 sm:text-[19px]">
          {/* formatDuration endet z. B. auf „Sek.“ – dann keinen zweiten Punkt. */}
          {`Stark${firstName ? `, ${firstName}` : ''}. Dein Stapel für heute ist leer${
            summary.duration ? ` – ${summary.done} Aufgaben in ${formatDuration(summary.duration)}` : ''
          }`.replace(/\.?$/, '.')}
        </p>
      </Rise>

      <Rise delay={0.75} className="mt-10 w-full max-w-[560px]">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="day-summary">
          {tiles.map((tile) => (
            <div key={tile.label} className="flex flex-col-reverse rounded-2xl bg-surface-1 px-2 py-4 text-center">
              <dt className="mt-1 text-[13px] text-ink-3">{tile.label}</dt>
              <dd className="text-[34px] font-semibold leading-none tabular-nums">{tile.value}</dd>
            </div>
          ))}
        </dl>
      </Rise>

      {streak !== null && streak.count >= 2 && (
        <Rise delay={0.9} className="mt-8 flex flex-col items-center gap-3">
          <div className="flex gap-1.5" aria-hidden>
            {Array.from({ length: Math.min(streak.count, 7) }, (_, index) => (
              <span key={index} className={cn('h-1.5 w-7 rounded-full', index === Math.min(streak.count, 7) - 1 ? 'bg-good' : 'bg-ink')} />
            ))}
          </div>
          <p className="text-[15px]" data-testid="streak">
            <span className="font-semibold">{streak.count} Tage in Folge</span>
            <span className="text-ink-3"> · bleib dran</span>
          </p>
        </Rise>
      )}

      <Rise delay={1.05} className="mt-10 flex flex-wrap justify-center gap-3">
        <Button variant="primary" size="xl" onClick={onNext}>
          {nextLabel}
          <ArrowRight className="h-4 w-4" />
        </Button>
        {!reduced && (
          <Button variant="outline" size="xl" onClick={() => setRound((value) => value + 1)} data-testid="celebrate-again">
            Nochmal feiern
          </Button>
        )}
      </Rise>
    </div>
  );
}

function Rise({ delay, className, children }: { delay: number; className?: string; children: ReactNode }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', bounce: 0, duration: 0.6, delay }}
    >
      {children}
    </motion.div>
  );
}

const CONFETTI_COLORS = ['#f5f5f7', '#30d158', '#2997ff', '#ff9f0a', '#a1a1a6'];

/** Konfetti fällt einmal über den ganzen Bildschirm – nur transform/opacity, danach weg. */
export function Confetti({ seed }: { seed: number }) {
  const pieces = useMemo(() => {
    let state = 7 + seed * 13;
    const random = () => {
      state = (state * 9301 + 49297) % 233280;
      return state / 233280;
    };
    return Array.from({ length: 48 }, (_, index) => ({
      left: random() * 100,
      width: 6 + random() * 6,
      height: 10 + random() * 8,
      color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
      delay: random() * 0.9,
      duration: 2.6 + random() * 1.6,
      drift: (random() - 0.5) * 160,
      spin: (random() - 0.5) * 1080,
    }));
  }, [seed]);
  const height = typeof window === 'undefined' ? 900 : window.innerHeight;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-40 overflow-hidden" data-testid="confetti">
      {pieces.map((piece, index) => (
        <motion.span
          key={index}
          className="absolute top-0 rounded-[2px]"
          style={{ left: `${piece.left}%`, width: piece.width, height: piece.height, backgroundColor: piece.color }}
          initial={{ y: -40, x: 0, rotate: 0, opacity: 0 }}
          animate={{ y: height + 40, x: piece.drift, rotate: piece.spin, opacity: [0, 1, 1, 0] }}
          transition={{ duration: piece.duration, delay: piece.delay, ease: [0.2, 0.6, 0.4, 1], opacity: { duration: piece.duration, delay: piece.delay, times: [0, 0.08, 0.8, 1] } }}
        />
      ))}
    </div>
  );
}

/** Eigene Aktivität eines Tages: Anfragen, Nachrichten oder Übergaben. */
const active = (day: DashboardDay) => day.requests + day.messaged + day.handovers > 0;

/**
 * Serie aus `GET /api/dashboard` (letzte 30 Tage): Werktage in Folge mit eigener Aktivität bis heute.
 * Wochenenden ohne Aktivität unterbrechen nicht. Fehler → keine Serie (der Moment bleibt trotzdem schön).
 */
export function useStreak(founder: FounderId): { count: number } | null {
  const days = useStreakDays(founder);
  return useMemo(() => (days ? streakOf(days) : null), [days]);
}

/**
 * Serie für die Startseite (Goal-Gradient, 25.10.): Werktage in Folge mit Aktivität. Heute zählt hier nur, wenn schon
 * etwas erledigt ist – `today` sagt, ob die Serie heute schon fortgesetzt wurde.
 */
export function useHomeStreak(founder: FounderId): { count: number; today: boolean } | null {
  const days = useStreakDays(founder);
  return useMemo(() => {
    if (!days || days.length === 0) return null;
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const today = active(sorted[sorted.length - 1]);
    const withToday = streakOf(sorted).count;
    return { count: today ? withToday : withToday - 1, today };
  }, [days]);
}

/** Kurzer Zwischenspeicher: Die Startseite erscheint oft – nicht jedes Mal 30 Tage Kennzahlen neu rechnen lassen. */
const STREAK_CACHE_MS = 2 * 60_000;
const streakCache = new Map<FounderId, { at: number; days: DashboardDay[] }>();

function useStreakDays(founder: FounderId): DashboardDay[] | null {
  const cached = streakCache.get(founder);
  const fresh = cached && Date.now() - cached.at < STREAK_CACHE_MS ? cached.days : null;
  const [days, setDays] = useState<DashboardDay[] | null>(fresh);
  useEffect(() => {
    const hit = streakCache.get(founder);
    if (hit && Date.now() - hit.at < STREAK_CACHE_MS) {
      setDays(hit.days);
      return;
    }
    const controller = new AbortController();
    dashboardApi
      .get(30, { signal: controller.signal })
      .then((response) => {
        const list = response.days[founder] ?? [];
        streakCache.set(founder, { at: Date.now(), days: list });
        setDays(list);
      })
      .catch(() => setDays(null));
    return () => controller.abort();
  }, [founder]);
  return days;
}

export function streakOf(days: DashboardDay[]): { count: number } {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  // Heute zählt immer – der Stapel ist ja gerade leer geworden.
  let count = 0;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const day = sorted[index];
    const isToday = index === sorted.length - 1;
    if (isToday || active(day)) {
      count += 1;
      continue;
    }
    const weekday = new Date(`${day.date}T12:00:00`).getDay();
    if (weekday === 0 || weekday === 6) continue;
    break;
  }
  return { count };
}
