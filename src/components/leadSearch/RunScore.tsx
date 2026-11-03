import { useReducedMotion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { handoffCount, type RunSnapshot } from '../../../shared/leadSearch';
import { cn } from '../../lib/cn';
import { autoSearchApi } from '../../lib/leadSearchApi';
import { useDemo } from '../../state/demo';
import { Confetti } from '../stack/SuccessScreen';
import { CountUp } from './Funnel';

/** Konfetti nur beim ersten Anblick eines Laufs – nicht nach jedem Tab-Wechsel. */
const celebrated = new Set<string>();

const euro = (value: number) =>
  value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: value < 0.1 ? 3 : 2 });

/** Preis je Lead der letzten Suche – nur in diesem Browser (Vergleich „günstiger als letztes Mal“). */
function usePreviousPrice(founder: string | null, runId: string, price: number | null): number | null {
  const key = `lead-search-price:${founder ?? 'anon'}`;
  const [previous] = useState<number | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { runId: string; price: number; before: number | null } | null;
      if (!saved) return null;
      // Derselbe Lauf noch einmal angesehen: mit dem Wert davor vergleichen.
      return saved.runId === runId ? saved.before : saved.price;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (price === null) return;
    try {
      localStorage.setItem(key, JSON.stringify({ runId, price, before: previous }));
    } catch {
      // Speicher gesperrt (privates Fenster) – dann eben ohne Vergleich.
    }
  }, [key, runId, price, previous]);
  return previous;
}

/** Tagesziel der automatischen Suche (Einstellung „qualifizierte Leads pro Tag“) – null ohne Ziel oder ohne Rechte. */
function useDailyGoal(founder: string | null, refreshKey: string): { done: number; target: number } | null {
  const [goal, setGoal] = useState<{ done: number; target: number } | null>(null);
  useEffect(() => {
    if (!founder) return;
    const controller = new AbortController();
    autoSearchApi
      .list({ signal: controller.signal })
      .then((response) => {
        const own = response.schedules.find((schedule) => schedule.founder === founder);
        setGoal(own?.enabled && own.dailyTarget ? { done: own.today?.created ?? 0, target: own.dailyTarget } : null);
      })
      .catch(() => setGoal(null));
    return () => controller.abort();
  }, [founder, refreshKey]);
  return goal;
}

/**
 * Spielstand nach einer Suche (Wunsch des Nutzers 12.10.: „mehr gamifiziert, damit man es besser versteht“):
 * neue Leads, Preis je Lead (mit Vergleich zur letzten Suche), Trefferquote und – falls gesetzt – das Tagesziel,
 * sonst wie viele Treffer auf die nächste Suche warten. Konfetti, wenn es neue Leads gab (nicht bei „Bewegung reduzieren“).
 */
export function RunScore({ run }: { run: RunSnapshot }) {
  const { state } = useDemo();
  const reduced = useReducedMotion();
  const founder = state.founder;
  const leads = handoffCount(run.leads);
  const found = run.leads.length;
  const manual = run.leads.filter((lead) => lead.manual).length;
  const cost = run.costEur ?? null;
  // Von Hand qualifizierte Leads haben keine KI-Kosten verursacht, zählen aber als Ertrag.
  const price = cost !== null && leads > 0 ? cost / leads : null;
  const previous = usePreviousPrice(founder, run.id, price);
  const goal = useDailyGoal(founder, `${run.id}:${run.handedOff}`);
  const waiting = run.leads.filter((lead) => lead.status === 'deferred').length;
  const [confetti] = useState(() => leads > 0 && run.status === 'done' && !celebrated.has(run.id));
  useEffect(() => {
    celebrated.add(run.id);
  }, [run.id]);

  const delta = price !== null && previous !== null && previous > 0 ? (price - previous) / previous : null;
  const rate = found > 0 ? leads / found : 0;

  return (
    <section aria-label="Ergebnis in Zahlen" className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4" data-testid="run-score">
      {confetti && !reduced && <Confetti seed={run.startedAt % 97} />}
      <Tile label={leads === 1 ? 'neuer Lead' : 'neue Leads'} testId="score-leads" sub={manual ? `${manual} davon von Hand` : undefined}>
        <span className={cn(leads > 0 ? 'text-good' : 'text-ink-2')}>+</span>
        <CountUp value={leads} />
      </Tile>
      <Tile
        label="KI-Kosten je Lead"
        testId="score-price"
        sub={
          delta === null || Math.abs(delta) < 0.01 ? (cost !== null ? `Suche gesamt ${euro(cost)}` : undefined) : (
            <span className={delta < 0 ? 'text-good' : 'text-warn'} data-testid="score-price-delta">
              {delta < 0 ? '↓' : '↑'} {Math.round(Math.abs(delta) * 100)} % {delta < 0 ? 'günstiger' : 'teurer'} als letzte Suche
            </span>
          )
        }
      >
        {price !== null ? euro(price) : '–'}
      </Tile>
      <Tile label="Trefferquote" testId="score-rate" sub={`${leads} von ${found} Treffern`}>
        {`${(rate * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`}
      </Tile>
      {goal ? (
        <Tile
          label="Tagesziel"
          testId="score-goal"
          sub={goal.done >= goal.target ? 'geschafft' : `noch ${goal.target - goal.done} bis zum Ziel`}
          bar={
            <span className="mt-2 flex max-w-[180px] gap-0.5" aria-hidden>
              {Array.from({ length: Math.min(goal.target, 20) }, (_, index) => (
                <span
                  key={index}
                  className={cn('h-1.5 flex-1 rounded-full', index < Math.round((Math.min(goal.done, goal.target) / goal.target) * Math.min(goal.target, 20)) ? 'bg-good' : 'bg-surface-4')}
                />
              ))}
            </span>
          }
        >
          {goal.done}
          <span className="text-ink-3">/{goal.target}</span>
        </Tile>
      ) : (
        <Tile label="warten auf die nächste Suche" testId="score-waiting" sub={waiting ? 'kommen dann zuerst dran' : 'nichts liegen geblieben'}>
          <CountUp value={waiting} />
        </Tile>
      )}
    </section>
  );
}

function Tile({ label, sub, bar, testId, children }: { label: string; sub?: ReactNode; bar?: ReactNode; testId: string; children: ReactNode }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="display flex items-baseline text-[26px] font-semibold leading-none tabular-nums sm:text-[30px]" data-testid={`${testId}-value`}>
        {children}
      </p>
      {bar}
      <p className="mt-1.5 text-[13px] text-ink-2">{label}</p>
      {sub && <p className="mt-0.5 text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}
