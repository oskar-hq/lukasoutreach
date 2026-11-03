import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { Fragment, useEffect } from 'react';
import { funnelOf, type RunSnapshot } from '../../../shared/leadSearch';
import { cn } from '../../lib/cn';
import { EASE_OUT } from '../../lib/motion';

const integer = new Intl.NumberFormat('de-DE');

/** Zahl, die vom alten zum neuen Wert hochzählt. */
export function CountUp({ value, className, duration = 0.6 }: { value: number; className?: string; /** Sekunden. */ duration?: number }) {
  const reduce = useReducedMotion();
  const motionValue = useMotionValue(0);
  const text = useTransform(motionValue, (latest) => integer.format(Math.round(latest)));

  useEffect(() => {
    if (reduce) {
      motionValue.set(value);
      return;
    }
    const controls = animate(motionValue, value, { duration, ease: EASE_OUT });
    return () => controls.stop();
  }, [value, reduce, motionValue, duration]);

  return <motion.span className={className}>{text}</motion.span>;
}

interface Stage {
  key: string;
  label: string;
  value: number;
  active: boolean;
}

/**
 * Der Trichter als eine Zeile: Treffer → ohne Dubletten → vorgeprüft (KI anhand der Headline) → Profil gelesen →
 * passend → ohne aktive Meta-Ads. „Profil gelesen“ hieß früher „angereichert“ – gemeint ist nur das LinkedIn-Profil.
 */
export function Funnel({ run }: { run: RunSnapshot }) {
  const funnel = funnelOf(run.leads);
  const running = run.status === 'running';
  const unchecked = run.leads.filter((lead) => lead.status === 'qualified' && lead.metaAds?.state === 'unchecked').length;
  // Aktive Meta-Ads gehen markiert mit in den Tagesstapel (07.10.) – im Trichter als Zusatz zur letzten Stufe.
  const adsActive = run.leads.filter((lead) => lead.status === 'ads_active').length;
  // Meta-Ads sind kein Ausschluss (Wunsch des Nutzers 12.10.) – nur der Aufhänger für die Nachricht.
  const adsNote = adsActive ? ` · ${adsActive} davon ${adsActive === 1 ? 'schaltet' : 'schalten'} gerade Meta-Ads` : '';
  const ready = funnel.qualified + adsActive;

  const stages: Stage[] = [
    { key: 'found', label: 'Treffer', value: funnel.found, active: running && run.phase === 'search' },
    { key: 'unique', label: 'ohne Dubletten', value: funnel.unique, active: running && run.phase === 'dedupe' },
    // Ältere Backends kennen die Vorprüfung nicht (kein `screened`) – dann ohne diese Stufe.
    ...(funnel.screened === undefined
      ? []
      : [{ key: 'screened', label: 'vorgeprüft', value: funnel.screened, active: running && run.phase === 'screen' }]),
    {
      key: 'enriched',
      label: 'Profil gelesen',
      value: funnel.enriched,
      active: running && run.leads.some((lead) => lead.status === 'enriching'),
    },
    {
      key: 'qualified',
      label: (unchecked === 0 ? 'qualifiziert' : unchecked === ready ? 'qualifiziert · Meta-Ads ungeprüft' : `qualifiziert · ${unchecked} Meta-Ads ungeprüft`) + adsNote,
      value: ready,
      active: running && run.leads.some((lead) => lead.status === 'qualifying' || lead.status === 'checking_ads'),
    },
  ];

  return (
    <ol aria-label="Trichter der Lead-Suche" className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
      {stages.map((stage, index) => (
        <Fragment key={stage.key}>
          {index > 0 && (
            <li aria-hidden className="self-center text-ink-4">
              <ChevronRight className="h-4 w-4" />
            </li>
          )}
          <li className="flex items-baseline gap-1.5" data-testid={`funnel-${stage.key}`}>
            <CountUp
              value={stage.value}
              className={cn(
                'display text-[26px] font-semibold leading-none tabular-nums sm:text-[30px]',
                stage.key === 'qualified' ? 'text-ink' : 'text-ink-2',
              )}
            />
            <span className="text-[13px] text-ink-3">{stage.label}</span>
            {stage.active && <Spinner />}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-white/20 border-t-ink', className)}
    />
  );
}
