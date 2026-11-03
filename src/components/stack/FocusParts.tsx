import { motion, useTransform, type MotionValue } from 'motion/react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Briefcase, Check, ChevronRight, Megaphone, UserSearch } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CockpitLead } from '../../../shared/leads';
import { cn } from '../../lib/cn';
import { leadCompany, leadName, leadPosition, linkedinProfileUrl, type LeadSignal } from '../../lib/leadView';
import { FOUNDERS } from '../../data/founders';
import { useCockpit } from '../../state/cockpit';
import { useCrm } from '../../state/crm';
import { useDemo } from '../../state/demo';
import type { CardType } from '../../state/types';
import { useSwipeContext, type SwipeActions } from './swipe';

/** Eine Aufgabe = eine Seite: Inhalt mittig, Entscheidung unten in fester Position. */
export function FocusPage({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  const swipe = useSwipeContext();
  return (
    <div className="relative flex min-h-[calc(100dvh-64px-var(--safe-top))] flex-col">
      {swipe?.actionsRef.current && <SwipeHints x={swipe.x} actions={swipe.actionsRef.current} />}
      <div className="flex flex-1 flex-col items-center px-5 pb-10 pt-6 sm:pt-8">
        <div className="w-full max-w-[600px]">{children}</div>
      </div>
      <div className="sticky bottom-0 z-10 bg-gradient-to-t from-canvas from-70% to-transparent px-5 pb-[calc(1.25rem+var(--safe-bottom))] pt-7">
        <div className="mx-auto grid w-full max-w-[600px] grid-cols-2 gap-3">{actions}</div>
      </div>
    </div>
  );
}

/**
 * Hinweis in Richtung der Geste: Schon während des Wischens zeigt ein Label, welche Entscheidung
 * gleich fällt – es blendet proportional zur Auslenkung ein.
 */
function SwipeHints({ x, actions }: { x: MotionValue<number>; actions: SwipeActions }) {
  const rightOpacity = useTransform(x, [24, 140], [0, 1]);
  const leftOpacity = useTransform(x, [-140, -24], [1, 0]);
  const rightScale = useTransform(x, [24, 140], [0.9, 1]);
  const leftScale = useTransform(x, [-140, -24], [1, 0.9]);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-[18px] z-20 flex justify-center sm:top-[26px]">
      <motion.span
        style={{ opacity: rightOpacity, scale: rightScale }}
        className={cn(
          'absolute flex h-9 items-center gap-2 rounded-full px-4 text-[14px] font-semibold shadow-[0_12px_32px_-8px_rgb(0_0_0/0.8)]',
          actions.right.enabled === false ? 'bg-surface-4 text-ink-3' : 'bg-ink text-black',
        )}
      >
        {actions.right.label}
        <ArrowRight className="h-4 w-4" />
      </motion.span>
      <motion.span
        style={{ opacity: leftOpacity, scale: leftScale }}
        className="absolute flex h-9 items-center gap-2 rounded-full border border-line-strong bg-surface-3 px-4 text-[14px] font-semibold text-ink shadow-[0_12px_32px_-8px_rgb(0_0_0/0.8)]"
      >
        <ArrowLeft className="h-4 w-4" />
        {actions.left.label}
      </motion.span>
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  const swipe = useSwipeContext();
  const className = 'mb-5 text-center text-[12px] font-semibold text-ink-3';
  return swipe ? (
    <SwipeAwareEyebrow x={swipe.x} className={className}>
      {children}
    </SwipeAwareEyebrow>
  ) : (
    <div className={className}>{children}</div>
  );
}

/** Die Überschrift weicht dem Richtungs-Hinweis, der an ihrer Stelle erscheint. */
function SwipeAwareEyebrow({ x, className, children }: { x: MotionValue<number>; className: string; children: ReactNode }) {
  const opacity = useTransform(x, [-60, -16, 16, 60], [0, 1, 1, 0]);
  return (
    <motion.div style={{ opacity }} className={className}>
      {children}
    </motion.div>
  );
}

/** Die fünf Schritte eines Leads – die Schrittleiste zeigt, wo er gerade steht. Übergabe kommt aus der Antwort-Karte. */
const STEPS: { key: CardType | 'export'; label: string; done: string }[] = [
  { key: 'lead', label: 'Vernetzen', done: 'Vernetzt' },
  { key: 'first', label: 'Nachricht', done: 'Nachricht' },
  { key: 'followup', label: 'Follow-up', done: 'Follow-up' },
  { key: 'reply', label: 'Antwort', done: 'Antwort' },
  { key: 'export', label: 'Übergabe', done: 'Übergabe' },
];

/**
 * Schrittleiste statt Überschrift: erledigte Schritte mit Haken, der aktuelle weiß hinterlegt, die übrigen leise.
 * Eine Antwort kann auch ohne Follow-up kommen – „Follow-up“ zählt dann trotzdem als erledigt (Orientierung, kein Verlauf).
 */
export function StepRail({ step, extra }: { step: CardType; extra?: ReactNode }) {
  // Übergabe an Close ausgeschaltet (Einstellung, 22.10.): der Schritt fällt weg.
  const { handover } = useCrm();
  const steps = handover ? STEPS : STEPS.filter((entry) => entry.key !== 'export');
  const current = steps.findIndex((entry) => entry.key === step);
  return (
    <Eyebrow>
      <span className="flex flex-col items-center gap-2">
        <ol aria-label="Schritt" className="flex flex-wrap justify-center gap-0.5 text-[12px] sm:gap-1 sm:text-[12.5px] font-medium normal-case tracking-normal" data-testid="step-rail">
          {steps.map((entry, index) => (
            <li
              key={entry.key}
              aria-current={index === current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1 rounded-full px-2 py-1 sm:px-2.5',
                index === current ? 'bg-surface-3 font-semibold text-ink' : index < current ? 'text-ink-3' : 'text-ink-4',
              )}
            >
              {index < current && <Check className="h-3 w-3" aria-hidden />}
              {index < current ? entry.done : entry.label}
              {index < current && <span className="sr-only"> (erledigt)</span>}
            </li>
          ))}
        </ol>
        {extra && <span className="text-[12px] font-medium normal-case tracking-normal text-ink-3">{extra}</span>}
      </span>
    </Eyebrow>
  );
}

/** Ein Satz, warum diese Aufgabe jetzt dran ist – mit Statuspunkt (gut, Achtung, neutral). */
export function StatusSentence({ tone = 'neutral', children, testId }: { tone?: 'good' | 'warn' | 'neutral'; children: ReactNode; testId?: string }) {
  return (
    <p className="mx-auto mt-4 flex max-w-[520px] items-baseline justify-center gap-2 text-center text-[15px] leading-[1.5] text-ink" data-testid={testId}>
      <span
        aria-hidden
        className={cn('h-[7px] w-[7px] shrink-0 -translate-y-px rounded-full', tone === 'good' ? 'bg-good' : tone === 'warn' ? 'bg-warn' : 'bg-ink-3')}
      />
      <span>{children}</span>
    </p>
  );
}

/**
 * Zeile über jedem Schreibfeld: Hier schreibst du selbst (Wunsch des Nutzers 07.10.) – der Text ist nur ein Vorschlag.
 * „Leeren & selbst schreiben“ macht das Feld frei und setzt den Cursor hinein.
 */
export function WriteLabel({ children, onClear, hint = 'Vorschlag – einfach überschreiben' }: { children: ReactNode; onClear?: () => void; hint?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 text-[13px]">
      {/* Kein <label>: Das Feld trägt sein aria-label selbst (MessageEditor). */}
      <span className="font-medium text-ink-2">{children}</span>
      <span className="flex items-baseline gap-3 text-ink-3">
        {hint && <span className="hidden sm:inline">{hint}</span>}
        {onClear && (
          <button type="button" onClick={onClear} className="font-medium text-ink-2 underline-offset-4 transition-colors hover:text-ink hover:underline" data-testid="write-own">
            Leeren & selbst schreiben
          </button>
        )}
      </span>
    </div>
  );
}

interface PersonHeaderProps {
  lead: CockpitLead;
  onOpen: () => void;
  /** Eine Zeile Kontext unter Position und Firma (darf eine MetaLine sein). */
  subtitle?: ReactNode;
  /** Link „LinkedIn-Profil öffnen“ – nur wo man selbst auf LinkedIn handeln muss. */
  profileLink?: boolean;
  /** Kleinerer Name für Seiten mit Nachrichtenfeld. */
  compact?: boolean;
}

/** Zentrierter Kopf: Name (öffnet die Historie), Position und Firma, optional eine Zeile Kontext und der Profil-Link. */
export function PersonHeader({ lead, onOpen, subtitle, profileLink = false, compact = false }: PersonHeaderProps) {
  const name = leadName(lead);
  const profile = profileLink ? linkedinProfileUrl(lead) : null;
  return (
    <div className="flex flex-col items-center text-center">
      <button type="button" onClick={onOpen} title="Lead-Historie öffnen" className="group flex items-center gap-1 rounded-lg px-1 font-semibold text-ink">
        <span
          className={cn(
            'display decoration-white/30 underline-offset-[6px] group-hover:underline',
            compact ? 'text-[28px] sm:text-[30px]' : 'text-[30px] sm:text-[36px]',
          )}
          data-testid="lead-name"
        >
          {name}
        </span>
        <ChevronRight className="h-6 w-6 shrink-0 text-ink-3 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink-2" />
      </button>
      <p className="mt-1.5 text-[16px] text-ink-2">
        {leadPosition(lead)} · {leadCompany(lead)}
      </p>
      {subtitle && <div className="mt-1 text-[14px] text-ink-3">{subtitle}</div>}
      <ForOtherFounder lead={lead} />
      {profile && (
        <a
          href={profile}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-0.5 text-[13px] text-ink-3 underline-offset-4 transition-colors hover:text-ink-2 hover:underline"
        >
          LinkedIn-Profil öffnen
          <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

/** Signal als Text mit kleinem Symbol – für die Kontextzeile unter dem Namen. */
export function SignalText({ signal, ready }: { signal: LeadSignal | null; ready: boolean }) {
  // Eigener Span statt <Placeholder>: cn führt block/inline-block nicht zusammen.
  if (!ready) return <span aria-hidden className="inline-block h-4 w-40 rounded-full bg-white/[0.04] align-middle" />;
  if (!signal) return null;
  const Icon = signal.kind === 'meta_ads' ? Megaphone : signal.kind === 'hiring' ? Briefcase : UserSearch;
  return (
    <span className="text-ink-2" data-testid="signal">
      <Icon aria-hidden className="mr-1.5 inline h-3.5 w-3.5 -translate-y-px text-ink-3" />
      {signal.label}
    </span>
  );
}

/** Ruhiger Platzhalter in fester Höhe, solange Verlauf/Signal noch laden – damit nichts springt. */
export function Placeholder({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block rounded-full bg-white/[0.04]', className)} />;
}

/** Kleiner Abschnitt ohne Rahmen: Label + Inhalt. `className` ersetzt den Standardabstand (cn mischt nicht). */
export function Block({ label, icon, children, className, testId }: { label: string; icon?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={className ?? 'mt-10'} data-testid={testId}>
      <h2 className="mb-2.5 flex items-center justify-center gap-1.5 text-[12px] font-semibold text-ink-3 [&>svg]:h-3.5 [&>svg]:w-3.5">
        {icon}
        {label}
      </h2>
      {children}
    </section>
  );
}

/** Verlauf konnte nicht geladen werden – mit „Erneut laden“ statt einer toten Karte. */
export function DetailError({ leadId, className }: { leadId: string; className?: string }) {
  const { ensureDetail } = useCockpit();
  return (
    <p role="alert" className={cn('flex flex-wrap items-center justify-center gap-x-2 text-center text-[14px] text-ink-2', className)} data-testid="detail-error">
      Verlauf konnte nicht geladen werden.
      <button
        type="button"
        onClick={() => ensureDetail(leadId, true)}
        className="font-medium text-ink underline-offset-4 hover:underline"
      >
        Erneut laden
      </button>
    </p>
  );
}

/**
 * Über welchen LinkedIn-Account (Wunsch des Nutzers 12.10.: ist der eigene voll, geht es über den des anderen weiter).
 * `invite`: die nächste Anfrage geht über `account` · `message`: die Anfrage ging über `account`, also auch die
 * Nachricht – nur dort ist man vernetzt. Nichts, wenn es der eigene Account ist.
 */
export function AccountHint({ kind, account, owner }: { kind: 'invite' | 'message'; account: CockpitLead['owner'] | null | undefined; owner: CockpitLead['owner'] }) {
  if (!account || account === owner) return null;
  const name = FOUNDERS[account]?.name ?? account;
  return (
    <p className="mx-auto mt-4 max-w-[480px] text-center text-[13.5px] font-medium leading-[1.55] text-accent" data-testid="account-hint">
      {kind === 'invite'
        ? `Über den LinkedIn-Account von ${name} – deiner hat heute keine Anfragen mehr frei.`
        : `Vernetzt über den LinkedIn-Account von ${name} – schreib auch von dort.`}
    </p>
  );
}

/**
 * Unter „Alle“ (Umschalter auf der Startseite): Aufgabe eines Leads des anderen Gründers – du erledigst sie in dessen
 * Namen, gesendet wird über dessen LinkedIn-Account, eingetragen wird von Hand.
 */
/** „Johannes'“, „Nicks“ – deutscher Genitiv eines Vornamens. */
const genitive = (name: string) => (/[sßxz]$/i.test(name) ? `${name}'` : `${name}s`);

function ForOtherFounder({ lead }: { lead: CockpitLead }) {
  const { state } = useDemo();
  if (!state.founder || lead.owner === state.founder) return null;
  const name = FOUNDERS[lead.owner].name;
  return (
    <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-3 py-1 text-[13px] text-ink-2" data-testid="for-founder">
      <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
      Für {name} · über {genitive(name)} LinkedIn
    </p>
  );
}
