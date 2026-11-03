import { ArrowRight, BellRing } from 'lucide-react';
import { ACCOUNT_PAUSED_MESSAGE } from '../../../shared/tasks';
import { motion } from 'motion/react';
import { useRef, useState, type ReactNode } from 'react';
import { FOUNDER_IDS, FOUNDERS } from '../../data/founders';
import { cn } from '../../lib/cn';
import { formatTime, greetingForTime } from '../../lib/time';
import { useHotkeys } from '../../lib/useHotkeys';
import { useAccess } from '../../state/auth';
import { useCockpit } from '../../state/cockpit';
import { founderCards, useDemo, type StackScope } from '../../state/demo';
import type { FounderId } from '../../state/types';
import { AutoSearchHint } from '../autoSearch/AutoSearchHint';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { CountUp } from '../leadSearch/Funnel';
import { DelayedStatus } from './FocusView';
import { HomeLists } from './HomeLists';
import { LinkedInStatus } from './LinkedInStatus';
import { SuccessScreen, useHomeStreak } from './SuccessScreen';
import { TYPE_ORDER, typeLabel } from './summary';

/** Hochzählen der Zahlen beim Betreten der Startseite – kurz, damit man trotzdem sofort weiterklicken kann. */
const COUNT_UP_SECONDS = 0.45;

/** Ruhige Startseite: wie viel heute ansteht – und ein einziger Button zum Loslegen. */
export function HomeView() {
  const { state, dispatch } = useDemo();
  const { reload, retryWaiting } = useCockpit();
  const access = useAccess();
  const founder = state.founder as FounderId;
  const stack = state.stack;
  const all = founderCards(state, founder);
  const pending = all.filter((card) => card.status === 'pending');
  const doneCount = all.length - pending.length;
  const waiting = Object.values(stack.outcomes).filter((outcome) => outcome.commit === 'waiting').length;
  // „Neu“-Marker für Leads, die heute (in dieser Sitzung) aus der Lead-Suche kamen.
  const freshLeads = pending.some((card) => card.type === 'lead' && stack.handoffFirst.includes(card.leadId));
  // Fällige Follow-ups (seit FOLLOWUP_AFTER_DAYS ohne Antwort) bekommen einen eigenen Hinweis mit Namen.
  const followups = pending.filter((card) => card.type === 'followup');
  const followupNames = followups.slice(0, 3).map((card) => {
    const person = stack.tasks[card.id]?.lead.person;
    return person ? `${person.firstName} ${person.lastName}` : null;
  }).filter(Boolean);
  const ready = stack.status === 'ready';
  const start = () => dispatch({ type: 'START_FOCUS', filter: 'all' });
  // „Meine“ gehört zum eigenen Account (Wunsch des Nutzers 24.10.): Ist dort alles erledigt, geht es nur unter „Alle“
  // weiter – mit den Aufgaben des anderen Gründers.
  const changeScope = useScopeChange();
  const toAll = access.role === 'founder' && state.scope === 'mine';
  const switchToAll = () => void changeScope('all');
  const search = () => dispatch({ type: 'SET_VIEW', view: 'search' });

  // Eigener LinkedIn-Account nicht verbunden (17.10.): unter „Meine“ ist alles pausiert, unter „Alle“ gehen die Aufgaben
  // des anderen Gründers weiter.
  const paused = ready && stack.owner === founder && (stack.accountPaused ?? []).includes(founder);
  const phase = !ready
    ? stack.status === 'error'
      ? 'error'
      : 'loading'
    : paused && pending.length === 0
      ? 'paused'
      : pending.length > 0
        ? 'open'
        : doneCount > 0
          ? 'done'
          : 'empty';

  useHotkeys(
    {
      enter:
        phase === 'open' ? start : phase === 'empty' ? (toAll ? switchToAll : search) : phase === 'done' && toAll ? switchToAll : phase === 'error' ? () => void reload() : () => {},
    },
    (phase === 'open' || phase === 'empty' || phase === 'error' || (phase === 'done' && toAll)) && !state.panelLeadId,
  );

  // Kurze Fenster: Abstände und die große Zahl schrumpfen, damit die Startseite ohne Scrollen auf einen Bildschirm passt.
  const body = (
    <>
      {phase === 'loading' && (
        // Platz der großen Zahl freihalten, damit nichts springt, wenn die Aufgaben da sind.
        <div className="mt-10 flex h-[200px] items-center [@media(max-height:920px)]:mt-6 [@media(max-height:920px)]:h-[160px]">
          <DelayedStatus>Aufgaben werden geladen …</DelayedStatus>
        </div>
      )}

      {phase === 'error' && (
        <div role="alert" className="mt-10 flex flex-col items-center [@media(max-height:920px)]:mt-6">
          <p className="display text-[26px] font-semibold">Deine Aufgaben konnten nicht geladen werden.</p>
          <p className="mt-2 text-[16px] text-ink-2">{stack.error}</p>
          <Button variant="primary" size="xl" shortcut="↵" className="mt-8" onClick={() => void reload()}>
            Erneut versuchen
          </Button>
        </div>
      )}

      {phase === 'paused' && (
        <div className="mt-10 flex max-w-[480px] flex-col items-center [@media(max-height:920px)]:mt-6" role="status" data-testid="account-paused">
          <p className="display text-[28px] font-semibold leading-tight sm:text-[32px]">Deine Aufgaben sind pausiert.</p>
          <p className="mt-3 text-[16px] leading-[1.55] text-ink-2">{ACCOUNT_PAUSED_MESSAGE}</p>
          {access.role === 'founder' && (
            <p className="mt-2 text-[14px] leading-[1.55] text-ink-3">Unter „Alle“ arbeitest du solange die Aufgaben des anderen Gründers ab.</p>
          )}
        </div>
      )}

      {(phase === 'empty' || phase === 'done') && toAll && (
        <div className="mt-10 flex flex-col items-center [@media(max-height:920px)]:mt-6" data-testid="mine-done">
          <p className="display text-[32px] font-semibold">
            {phase === 'done' ? 'Deine Aufgaben sind erledigt.' : 'Für deinen Account steht heute nichts an.'}
          </p>
          <p className="mt-2 text-[17px] text-ink-2">Weiter geht es unter „Alle“.</p>
          <Button variant="primary" size="xl" shortcut="↵" className="mt-8" onClick={switchToAll} data-testid="to-all">
            Zu „Alle“
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {phase === 'empty' && !toAll && (
        <div className="mt-10 flex flex-col items-center [@media(max-height:920px)]:mt-6">
          <p className="display text-[32px] font-semibold">Heute steht nichts an.</p>
          <Button variant="primary" size="xl" shortcut="↵" className="mt-8" onClick={search} data-testid="home-search">
            Neue Leads suchen
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {phase === 'open' && (
        <>
          <p
            className="display mt-10 text-[96px] font-semibold leading-none tracking-[-0.04em] sm:text-[112px] [@media(max-height:920px)]:mt-6 [@media(max-height:920px)]:text-[80px]"
            data-testid="open-count"
          >
            {/* Kurz von 0 hochzählen beim Betreten (Wunsch des Nutzers 23.10.) – schnell genug, um gleich loszulegen. */}
            <CountUp value={pending.length} duration={COUNT_UP_SECONDS} className="tabular-nums" />
          </p>
          <p className="mt-3 text-[19px] text-ink-2 [@media(max-height:920px)]:mt-2 [@media(max-height:920px)]:text-[17px]">
            {doneCount === 0 ? 'Aufgaben für heute' : `${pending.length === 1 ? 'Aufgabe' : 'Aufgaben'} offen · ${doneCount} von ${all.length} erledigt`}
          </p>
          {/* Schon angefangen: der Weg zum Ziel als Balken (Goal-Gradient, Wunsch des Nutzers 25.10.). */}
          {doneCount > 0 && (
            <div className="mt-3 h-1 w-56 overflow-hidden rounded-full bg-surface-4" aria-hidden data-testid="home-progress">
              <motion.div
                className="h-full origin-left rounded-full bg-ink"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: doneCount / all.length }}
                transition={{ type: 'spring', bounce: 0, duration: 0.8 }}
              />
            </div>
          )}

          {/* Feste Höhe (zwei Zeilen auf dem Handy, eine am Rechner): Mehr oder weniger Arten verschieben nichts darunter. */}
          <div className="mt-4 flex min-h-[68px] flex-wrap content-start justify-center gap-x-1 gap-y-1 sm:min-h-8 [@media(max-height:920px)]:mt-3">
            {TYPE_ORDER.map((type) => {
              const count = pending.filter((card) => card.type === type).length;
              if (count === 0) return null;
              return (
                <button
                  key={type}
                  type="button"
                  data-testid={`start-${type}`}
                  onClick={() => dispatch({ type: 'START_FOCUS', filter: type })}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[14px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  {type === 'lead' && freshLeads && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                  <CountUp value={count} duration={COUNT_UP_SECONDS} className="tabular-nums text-ink-2" /> {typeLabel(type, count)}
                </button>
              );
            })}
          </div>

          {/* Eine Zeile statt eines Kastens. Ihr Platz bleibt auch ohne Follow-ups frei, damit „Starten“ nicht springt. */}
          {followups.length > 0 ? (
            <button
              type="button"
              data-testid="followup-notice"
              onClick={() => dispatch({ type: 'START_FOCUS', filter: 'followup' })}
              className="mt-5 flex h-9 max-w-[min(560px,calc(100vw-2.5rem))] items-center gap-2.5 rounded-full bg-surface-3 px-4 py-2 text-left text-[13.5px] transition-colors hover:bg-white/[0.07] [@media(max-height:920px)]:mt-4"
            >
              <BellRing className="h-4 w-4 shrink-0 text-accent" aria-hidden />
              <span className="min-w-0 truncate">
                <span className="font-medium text-ink">{followups.length === 1 ? 'Follow-up nötig' : `${followups.length} Follow-ups nötig`}</span>
                <span className="text-ink-3">
                  {' · '}
                  {followupNames.join(', ')}
                  {followups.length > followupNames.length ? ` und ${followups.length - followupNames.length} weitere` : ''} – seit{' '}
                  {stack.rules?.followUpAfterDays ?? 2} Tagen keine Antwort →
                </span>
              </span>
            </button>
          ) : (
            <div aria-hidden className="mt-5 h-9 [@media(max-height:920px)]:mt-4" />
          )}

          <Button
            variant="primary"
            size="xl"
            onClick={start}
            shortcut="↵"
            data-testid="start-focus"
            className="mt-8 h-16 px-8 text-[17px] [@media(max-height:920px)]:mt-6 [@media(max-height:920px)]:h-14"
          >
            {doneCount === 0 ? 'Starten' : 'Weitermachen'}
            <ArrowRight className="h-5 w-5" />
          </Button>
          <StreakLine founder={founder} />
        </>
      )}

      {phase === 'done' && !toAll && <AllDone />}

      {/* Einen Klick entfernt: „Braucht Aufmerksamkeit“ und offene Vernetzungsanfragen (angenommen eintragen). */}
      {ready && <HomeLists founder={founder} />}

      {/* Unter dem Hero: zuerst Probleme (offline, Aktualisieren fehlgeschlagen), dann eine ruhige Zeile zum Senden. */}
      <div className="mt-6 flex flex-col items-center gap-2 [@media(max-height:920px)]:mt-4">
        {waiting > 0 && (
          <p role="status" className="flex items-center gap-2 text-[13.5px] text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden />
            Offline – {waiting} {waiting === 1 ? 'Entscheidung wartet' : 'Entscheidungen warten'} aufs Speichern
            <button type="button" onClick={retryWaiting} className="font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline">
              Erneut versuchen
            </button>
          </p>
        )}
        {ready && stack.refreshError && stack.fetchedAt && (
          <p className="text-[12.5px] text-ink-3">Stand {formatTime(stack.fetchedAt)} Uhr – Aktualisieren hat nicht geklappt.</p>
        )}
        {/* Mitarbeiter dürfen den Zeitplan nicht lesen (`shared/autoSearch.ts`) – nur dann gibt es den Hinweis. */}
        {ready && <LinkedInStatus details={access.canEditSettings ? <AutoSearchHint founder={founder} /> : undefined} />}
      </div>
    </>
  );

  // Umschalten „Meine / Alle“ lädt den Stapel neu. Bis er da ist, bleibt der letzte Stand stehen – leicht abgeblendet –,
  // statt dass die Seite kurz zusammenfällt und wieder aufspringt (Wunsch des Nutzers 23.10.).
  const lastBody = useRef<{ founder: FounderId; body: ReactNode } | null>(null);
  const stale = phase === 'loading' && lastBody.current?.founder === founder;
  if (ready) lastBody.current = { founder, body };

  return (
    // Fester Abstand von oben statt senkrecht mittig (Wunsch des Nutzers 23.10.): Gruß, Schalter, Zahl und „Starten“
    // stehen immer an derselben Stelle – egal, wie viele Hinweise darunter dazukommen. Der Abstand hängt nur von der
    // Fensterhöhe ab (≈ mittig für den üblichen Inhalt).
    <div
      className="flex min-h-[var(--app-h)] flex-col items-center px-5 pb-28 pt-[max(1rem,calc((var(--app-h)-600px)/2))] text-center sm:pb-10 [@media(max-height:720px)]:pb-24"
      data-testid="home"
    >
      {/* Keine eigene Einblendung: Die Ansicht als Ganzes blendet schon ein (App.tsx) – zwei übereinander wirken träge. */}
      <div className="flex flex-col items-center">
        <h1 className="display text-[34px] font-semibold text-ink-2 sm:text-[40px] [@media(max-height:920px)]:sm:text-[36px]">
          {greetingForTime()}, <span className="text-ink">{access.user?.name ?? FOUNDERS[founder].name}.</span>
        </h1>
        {/* Admin und Mitarbeiter arbeiten die Aufgaben eines Gründers ab – das soll immer sichtbar sein. */}
        {access.role !== 'founder' && (
          <p className="mt-2 text-[15px] text-ink-2" data-testid="working-for">
            Aufgaben von <span className="font-medium text-ink">{FOUNDERS[founder].name}</span>
          </p>
        )}
        {access.role === 'founder' && <ScopeSwitch founder={founder} />}

        <div
          className={cn('flex flex-col items-center transition-opacity duration-200 motion-reduce:transition-none', stale && 'pointer-events-none opacity-50')}
          aria-busy={stale || undefined}
        >
          {stale ? lastBody.current!.body : body}
        </div>
      </div>
    </div>
  );
}

/**
 * Serie schon vor dem Start (Goal-Gradient, 25.10.): ab zwei Tagen in Folge eine ruhige Zeile mit Punktreihe wie auf
 * dem Erfolgsbildschirm. Platz bleibt immer frei, damit nichts springt, wenn die Zahlen nachkommen.
 */
function StreakLine({ founder }: { founder: FounderId }) {
  const streak = useHomeStreak(founder);
  const show = streak !== null && streak.count >= 2;
  return (
    <div className="mt-4 flex h-5 items-center justify-center gap-2.5 text-[13px] [@media(max-height:920px)]:mt-3" data-testid="home-streak">
      {show && (
        <>
          <span className="flex gap-1" aria-hidden>
            {Array.from({ length: Math.min(streak.count, 7) }, (_, index) => (
              <span key={index} className={cn('h-1 w-4 rounded-full', streak.today && index === Math.min(streak.count, 7) - 1 ? 'bg-good' : 'bg-ink')} />
            ))}
          </span>
          <span>
            <span className="font-semibold text-ink">{streak.count} Tage in Folge</span>
            <span className="text-ink-3 max-sm:hidden">{streak.today ? ' · weiter so' : ' · heute weitermachen hält die Serie'}</span>
          </span>
        </>
      )}
    </div>
  );
}

function AllDone() {
  const { state, dispatch } = useDemo();
  const founder = state.founder as FounderId;
  return (
    <div className="mt-14 w-full">
      <SuccessScreen cards={founderCards(state, founder)} founder={founder} celebrate={false} onNext={() => dispatch({ type: 'SET_VIEW', view: 'dashboard' })} />
    </div>
  );
}

/**
 * „Meine / Alle“ (Wunsch des Nutzers 16.10.): unter „Alle“ stehen auch die Aufgaben des anderen Gründers im Stapel –
 * erledigt in seinem Namen. Vorher werden offene Entscheidungen gespeichert (wie beim Gründerwechsel), sonst gingen
 * Rückgängig und Fehlermeldungen der alten Karten verloren.
 */
function useScopeChange() {
  const { state, dispatch } = useDemo();
  const { prepareSignOut } = useCockpit();
  const [busy, setBusy] = useState(false);
  return async (scope: StackScope) => {
    if (scope === state.scope || busy) return;
    setBusy(true);
    const waiting = await prepareSignOut();
    setBusy(false);
    if (waiting > 0) {
      dispatch({ type: 'NOTIFY', title: 'Noch nicht umgeschaltet', detail: `${waiting} Entscheidung${waiting === 1 ? '' : 'en'} warten aufs Speichern – gleich noch einmal versuchen.` });
      return;
    }
    dispatch({ type: 'SET_SCOPE', scope });
  };
}

function ScopeSwitch({ founder }: { founder: FounderId }) {
  const { state } = useDemo();
  const change = useScopeChange();
  const other = FOUNDER_IDS.find((id) => id !== founder) ?? founder;
  return (
    // Die Erklärung zu „Alle“ steht im Hinweis beim Überfahren – eine Zeile, die beim Umschalten auf- und zugeht, schob die
    // ganze Seite (Wunsch des Nutzers 23.10.).
    <div
      className="mt-4 flex flex-col items-center gap-1.5 [@media(max-height:920px)]:mt-3"
      title={`Unter „Alle“ erledigst du Aufgaben von ${FOUNDERS[other].name} für ${FOUNDERS[other].name} – mit Grußformel und Tageslimit von ${FOUNDERS[other].name}.`}
      data-testid="stack-scope"
    >
      <Segmented<StackScope>
        ariaLabel="Welche Aufgaben"
        size="sm"
        value={state.scope}
        onChange={(scope) => void change(scope)}
        options={[
          { value: 'mine', label: <span data-testid="scope-mine">Meine</span> },
          { value: 'all', label: <span data-testid="scope-all">Alle</span> },
        ]}
      />
    </div>
  );
}
