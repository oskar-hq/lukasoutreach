import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowUpRight, Check, Copy, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { REGISTER_PATH, type AuthUser } from '../../../shared/auth';
import type { SettingKey, SettingsResponse, SettingsUpdateRequest } from '../../../shared/settings';
import { cn } from '../../lib/cn';
import { ApiError, settingsApi } from '../../lib/leadSearchApi';
import { EASE_OUT } from '../../lib/motion';
import { INPUT } from '../../pages/Login';
import { useAuth } from '../../state/auth';
import { Logo } from '../layout/Logo';
import { Button } from '../ui/Button';
import type { TrackingSummary } from '../../../shared/leadSearch';
import { HistoryStep } from './HistoryStep';
import { TargetStep, type TargetResult } from './TargetStep';
import { SETUP_SERVICES, type SetupService } from './setupServices';

type ServiceState = { status: 'open' | 'ok' | 'skipped'; message?: string };
type Stage = { kind: 'overview' } | { kind: 'service'; index: number } | { kind: 'target' } | { kind: 'history' } | { kind: 'done' };

/**
 * Einrichtung für das erste Konto (`onboarding: 'setup'`): alle Dienste nacheinander, jeweils mit Erklärung, wo der
 * Schlüssel steht, Speichern und Verbindungstest. Gespeichert wird über die normalen Einstellungen
 * (`shared/settings.ts`) – alles lässt sich später unter Einstellungen ändern.
 */
export function SetupWizard({ user }: { user: AuthUser }) {
  const { finishOnboarding, setupPassword } = useAuth();
  const [stage, setStage] = useState<Stage>({ kind: 'overview' });
  const [states, setStates] = useState<Record<string, ServiceState>>({});
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  // Bisherige Leads (Tracking-Liste) – nach dem Hochladen in der Datenbank, hier nur zum Anzeigen.
  const [history, setHistory] = useState<TrackingSummary | null>(null);
  // Tagesziel der automatischen Suche – nur für Konten mit eigenem Gründer (Admins haben keinen Zeitplan für sich).
  const [target, setTarget] = useState<TargetResult | null>(null);
  const afterServices: Stage = user.founder ? { kind: 'target' } : { kind: 'history' };
  // Passwort für Schlüssel (Einstellungen fragen danach): aus der Registrierung oder hier eingegeben.
  const [password, setPassword] = useState<string>(() => setupPassword() ?? '');

  useEffect(() => {
    settingsApi
      .get()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const doneCount = SETUP_SERVICES.filter((service) => states[service.id]?.status === 'ok').length;
  const go = (next: Stage) => {
    setStage(next);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="min-h-dvh" data-testid="setup-wizard">
      <AnimatePresence mode="wait" initial={false}>
        {stage.kind === 'overview' ? (
          <Fade key="overview">
            <Overview name={user.name} onStart={() => go({ kind: 'service', index: 0 })} />
          </Fade>
        ) : stage.kind === 'service' ? (
          <Fade key="services">
            <ServiceStep
              index={stage.index}
              states={states}
              doneCount={doneCount}
              settings={settings}
              password={password}
              setPassword={setPassword}
              onSettings={setSettings}
              onState={(id, state) => setStates((current) => ({ ...current, [id]: state }))}
              onSelect={(index) => go({ kind: 'service', index })}
              onBack={() => go(stage.index === 0 ? { kind: 'overview' } : { kind: 'service', index: stage.index - 1 })}
              onNext={() => go(stage.index === SETUP_SERVICES.length - 1 ? afterServices : { kind: 'service', index: stage.index + 1 })}
            />
          </Fade>
        ) : stage.kind === 'target' && user.founder ? (
          <Fade key="target">
            <TargetStep
              founder={user.founder}
              initial={target}
              onBack={() => go({ kind: 'service', index: SETUP_SERVICES.length - 1 })}
              onDone={(result) => {
                if (result) setTarget(result);
                go({ kind: 'history' });
              }}
            />
          </Fade>
        ) : stage.kind === 'history' ? (
          <Fade key="history">
            <HistoryStep
              summary={history}
              onSummary={setHistory}
              onBack={() => go(user.founder ? { kind: 'target' } : { kind: 'service', index: SETUP_SERVICES.length - 1 })}
              onNext={() => go({ kind: 'done' })}
            />
          </Fade>
        ) : (
          <Fade key="done">
            <Done states={states} history={history} target={target} onBack={() => go({ kind: 'history' })} finish={finishOnboarding} />
          </Fade>
        )}
      </AnimatePresence>
    </div>
  );
}

function Fade({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: EASE_OUT }}>
      {children}
    </motion.div>
  );
}

function Progress({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-2" aria-label={`Schritt ${step + 1} von 4`}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={cn('h-1 w-6 rounded-full sm:w-8', i <= step ? 'bg-ink' : 'bg-white/[0.14]')} />
      ))}
      <span className="ml-2 hidden text-[12.5px] text-ink-3 sm:inline">Schritt {step + 1} von 4</span>
    </div>
  );
}

function Header({ step }: { step: 1 | 2 | 3 }) {
  return (
    <header className="flex h-16 items-center justify-between px-4 sm:px-8 lg:px-16">
      <Logo />
      <Progress step={step} />
    </header>
  );
}

const TAG_DOT: Record<SetupService['tag'], string> = { Pflicht: 'bg-warn', Empfohlen: 'bg-ink-2', Optional: 'bg-transparent' };

function Overview({ name, onStart }: { name: string; onStart: () => void }) {
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => startRef.current?.focus(), []);
  return (
    <>
      <Header step={1} />
      <main className="mx-auto max-w-[1080px] px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
        <p className="text-[12px] font-semibold text-ink-3">Hallo {name}</p>
        <h1 className="display mt-3 max-w-[760px] text-[34px] font-semibold sm:text-[44px]">Sechs Dienste machen das Cockpit lebendig.</h1>
        <p className="mt-4 max-w-[720px] text-[16px] leading-relaxed text-ink-2 sm:text-[17px]">
          Nur LinkedIn ist Pflicht. Alles andere kannst du überspringen und später unter Einstellungen nachholen. Bei jedem
          Dienst zeigen wir dir genau, wo du den Schlüssel findest. Zum Schluss legst du fest, wie viele qualifizierte Leads
          du pro Tag willst, und lädst eure bisherige Outreach-Liste (Excel) hoch, damit niemand doppelt angeschrieben wird.
        </p>
        <ul className="mt-10 space-y-1" data-testid="setup-overview">
          {SETUP_SERVICES.map((service) => (
            <li key={service.id} className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 py-4 sm:grid-cols-[220px_1fr_120px_100px]">
              <span className="text-[15px] font-semibold">{service.name}</span>
              <span className="order-3 col-span-2 text-[14px] text-ink-2 sm:order-none sm:col-span-1">{service.why.split('. ')[0]}.</span>
              <span className="hidden text-[13px] text-ink-3 sm:block">{service.minutes}</span>
              <span className="flex items-center gap-1.5 justify-self-end text-[13px] text-ink-2 sm:justify-self-start">
                <span className={cn('h-1.5 w-1.5 rounded-full', TAG_DOT[service.tag])} aria-hidden />
                {service.tag}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-col-reverse items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Schlüssel liegen verschlüsselt auf deinem Server. Nach dem Speichern zeigt der Browser sie nie wieder.
          </p>
          <Button ref={startRef} variant="primary" size="lg" shortcut="↵" onClick={onStart} data-testid="setup-start">
            Los geht&apos;s
          </Button>
        </div>
      </main>
    </>
  );
}

interface ServiceStepProps {
  index: number;
  states: Record<string, ServiceState>;
  doneCount: number;
  settings: SettingsResponse | null;
  password: string;
  setPassword: (value: string) => void;
  onSettings: (settings: SettingsResponse) => void;
  onState: (id: string, state: ServiceState) => void;
  onSelect: (index: number) => void;
  onBack: () => void;
  onNext: () => void;
}

/** Ist der Schlüssel schon gesetzt (z. B. aus der `.env`)? Dann reicht der Verbindungstest. */
function alreadySet(settings: SettingsResponse | null, key: SettingKey): { set: boolean; hint: string | null } {
  const state = settings?.settings.find((entry) => entry.key === key);
  if (!state) return { set: false, hint: null };
  if (state.secret) return state.secret;
  return { set: state.value !== null && state.value !== undefined && state.value !== '', hint: typeof state.value === 'string' ? state.value : null };
}

function ServiceStep(props: ServiceStepProps) {
  const { index, states, doneCount, settings, password, setPassword, onSettings, onState, onSelect, onBack, onNext } = props;
  const service = SETUP_SERVICES[index];
  const state = states[service.id] ?? { status: 'open' };
  const [values, setValues] = useState<Partial<Record<SettingKey, string>>>({});
  const [busy, setBusy] = useState<'saving' | 'testing' | null>(null);
  const [error, setError] = useState<{ text: string; id: number } | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const counter = useRef(0);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Neuer Dienst: leere Felder, alter Fehler weg.
  useEffect(() => {
    setValues({});
    setError(null);
    setBusy(null);
    firstFieldRef.current?.focus();
  }, [service.id]);

  const fail = (text: string) => setError({ text, id: ++counter.current });
  const canContinue = state.status === 'ok' || service.tag !== 'Pflicht';
  const last = index === SETUP_SERVICES.length - 1;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const changes: SettingsUpdateRequest['changes'] = {};
    for (const field of service.fields) {
      const value = values[field.key]?.trim();
      if (value) changes[field.key] = value;
    }
    const missing = service.fields.find((field) => !changes[field.key] && !alreadySet(settings, field.key).set);
    if (missing) {
      fail(`Bitte trag ${missing.label === 'DSN' ? 'die DSN' : `den Wert für „${missing.label}“`} ein.`);
      return;
    }
    setError(null);
    try {
      if (Object.keys(changes).length > 0) {
        if (!password) {
          setNeedPassword(true);
          fail('Bestätige zum Speichern kurz dein Passwort.');
          requestAnimationFrame(() => passwordRef.current?.focus());
          return;
        }
        setBusy('saving');
        let current = settings ?? (await settingsApi.get());
        try {
          current = await settingsApi.update({ changes, password, version: current.version });
        } catch (caught) {
          // Inzwischen anders gespeichert (z. B. zweiter Tab): einmal mit neuem Stand versuchen.
          if (!(caught instanceof ApiError && caught.code === 'settings_changed')) throw caught;
          current = await settingsApi.update({ changes, password, version: (await settingsApi.get()).version });
        }
        onSettings(current);
        setValues({});
      }
      setBusy('testing');
      const result = await settingsApi.test(service.id);
      setBusy(null);
      if (result.ok) onState(service.id, { status: 'ok', message: result.message });
      else fail(result.message);
    } catch (caught) {
      setBusy(null);
      if (caught instanceof ApiError && caught.code === 'reauth_failed') {
        setNeedPassword(true);
        setPassword('');
        fail(caught.message || 'Das Passwort stimmt nicht.');
        requestAnimationFrame(() => passwordRef.current?.focus());
        return;
      }
      fail(
        caught instanceof ApiError && caught.code === 'offline'
          ? 'Der Server antwortet gerade nicht. Versuch es gleich noch einmal.'
          : caught instanceof ApiError && caught.message
            ? caught.message
            : 'Speichern hat nicht geklappt. Versuch es noch einmal.',
      );
    }
  };

  const skip = () => {
    onState(service.id, { status: 'skipped' });
    onNext();
  };

  return (
    <div className="lg:flex lg:min-h-dvh">
      <nav aria-label="Dienste" className="border-b border-line bg-surface-1 lg:w-[300px] lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="hidden px-8 pb-6 pt-5 lg:block">
          <Logo />
        </div>
        <div className="px-4 pt-4 lg:px-8 lg:pt-2">
          <p className="text-[12px] font-semibold text-ink-3" data-testid="setup-progress">
            {doneCount} von {SETUP_SERVICES.length} verbunden
          </p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full w-full rounded-full bg-ink transition-transform duration-500 ease-out motion-reduce:transition-none"
              style={{ transform: `translateX(${(doneCount / SETUP_SERVICES.length) * 100 - 100}%)` }}
            />
          </div>
        </div>
        <ol className="flex gap-1 overflow-x-auto px-3 py-3 lg:flex-col lg:px-5 lg:py-6">
          {SETUP_SERVICES.map((item, i) => {
            const itemState = states[item.id]?.status ?? 'open';
            const active = i === index;
            return (
              <li key={item.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  aria-current={active ? 'step' : undefined}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] transition-colors',
                    active ? 'bg-surface-3 font-semibold text-ink' : 'text-ink-2 hover:bg-white/[0.04] hover:text-ink',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold',
                      itemState === 'ok'
                        ? 'bg-good/15 text-good'
                        : active
                          ? 'bg-ink text-black'
                          : itemState === 'skipped'
                            ? 'border border-dashed border-white/25'
                            : 'border border-line-strong text-ink-3',
                    )}
                  >
                    {itemState === 'ok' ? <Check className="h-3 w-3" strokeWidth={3} aria-label="verbunden" /> : itemState === 'skipped' ? '' : i + 1}
                  </span>
                  <span className="whitespace-nowrap lg:flex-1">{item.name}</span>
                  <span className="hidden text-[12px] font-normal text-ink-3 lg:inline">
                    {itemState === 'ok' ? 'Verbunden' : itemState === 'skipped' ? 'Später' : item.tag}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="hidden px-8 pb-8 text-[12.5px] leading-relaxed text-ink-3 lg:block">Alles lässt sich später unter Einstellungen ändern.</p>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col px-4 pb-10 pt-6 sm:px-8 lg:px-16 lg:pt-5">
        <div className="hidden justify-end lg:flex">
          <Progress step={2} />
        </div>
        <p className="mt-2 text-[12px] font-semibold text-ink-3 lg:mt-8">
          Dienst {index + 1} von {SETUP_SERVICES.length} · {service.tag}
        </p>
        <h1 className="display mt-3 text-[30px] font-semibold sm:text-[40px]" data-testid="setup-service-title">
          {service.title}
        </h1>
        <p className="mt-3 max-w-[720px] text-[16px] leading-relaxed text-ink-2">{service.why}</p>

        <div className="mt-8 grid gap-10 xl:grid-cols-2">
          <div>
            <p className="text-[15px] font-semibold tracking-[-0.01em]">So findest du den Schlüssel</p>
            <ol className="mt-4 flex flex-col gap-3.5">
              {service.steps.map((step, i) => (
                <li key={step} className="flex items-start gap-3.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold text-ink-2">{i + 1}</span>
                  <span className="pt-0.5 text-[14.5px] leading-relaxed text-ink-2">{step}</span>
                </li>
              ))}
            </ol>
            <a
              href={service.link.href}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-ink underline-offset-4 hover:underline"
            >
              {service.link.label}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </a>
            {service.note && (
              <p className="mt-3 flex items-baseline gap-2.5 text-[13px] leading-relaxed text-ink-2">
                <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-warn" aria-hidden />
                {service.note}
              </p>
            )}
          </div>

          <form onSubmit={(event) => void save(event)} noValidate className="self-start rounded-[20px] bg-surface-2 p-5 sm:p-7" data-testid="setup-form">
            <div className="flex flex-col gap-4">
              {service.fields.map((field, i) => {
                const existing = alreadySet(settings, field.key);
                const id = `setup-${field.key}`;
                return (
                  <div key={field.key}>
                    <label htmlFor={id} className="mb-2 block text-[13px] font-medium text-ink-2">
                      {field.label}
                    </label>
                    <input
                      ref={i === 0 ? firstFieldRef : undefined}
                      id={id}
                      value={values[field.key] ?? ''}
                      onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                      placeholder={existing.set ? `Schon eingetragen${existing.hint ? ` · …${existing.hint.slice(-4)}` : ''} – leer lassen zum Behalten` : field.placeholder}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      data-testid={id}
                      className={cn(INPUT, 'font-mono text-[14px]')}
                    />
                  </div>
                );
              })}
              {needPassword && (
                <div>
                  <label htmlFor="setup-password" className="mb-2 block text-[13px] font-medium text-ink-2">
                    Dein Passwort
                  </label>
                  <input
                    ref={passwordRef}
                    id="setup-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    data-testid="setup-password"
                    className={INPUT}
                  />
                  <p className="mt-2 text-[12.5px] text-ink-3">Schlüssel ändern geht nur mit Passwort – so kann niemand an einem offenen Rechner etwas umstellen.</p>
                </div>
              )}

              {state.status === 'ok' && !busy ? (
                <p role="status" className="flex items-start gap-3 rounded-xl border border-good/25 bg-good/[0.08] px-4 py-3" data-testid="setup-ok">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-good" strokeWidth={2.6} aria-hidden />
                  <span>
                    <span className="block text-[14px] font-semibold text-ink">Verbunden und gespeichert</span>
                    <span className="block text-[13px] text-ink-2">{state.message}</span>
                  </span>
                </p>
              ) : (
                <Button type="submit" variant="secondary" size="lg" disabled={!!busy} aria-busy={!!busy} data-testid="setup-test" className="w-full">
                  {busy ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/15 border-t-white" aria-hidden />
                      {busy === 'saving' ? 'Wird gespeichert…' : 'Wird geprüft…'}
                    </>
                  ) : (
                    'Speichern und testen'
                  )}
                </Button>
              )}
              {error && (
                <p key={error.id} role="alert" className="flex items-baseline gap-2 text-[14px] leading-snug text-ink" data-testid="setup-error">
                  <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
                  {error.text}
                </p>
              )}
              <p className="text-[12.5px] leading-relaxed text-ink-3">Der Schlüssel bleibt auf deinem Server. Danach siehst du nur noch die letzten vier Zeichen.</p>
            </div>
          </form>
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-10">
          <Button variant="ghost" size="lg" onClick={onBack} icon={<ArrowLeft className="h-4 w-4" />}>
            Zurück
          </Button>
          <div className="flex flex-wrap gap-2">
            {service.tag !== 'Pflicht' && state.status !== 'ok' && (
              <Button variant="ghost" size="lg" onClick={skip} data-testid="setup-skip">
                Später einrichten
              </Button>
            )}
            <Button variant="primary" size="lg" onClick={onNext} disabled={!canContinue} data-testid="setup-next">
              {!canContinue ? 'Erst verbinden' : last ? 'Einrichtung abschließen' : 'Weiter'}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

function Done({
  states,
  history,
  target,
  onBack,
  finish,
}: {
  states: Record<string, ServiceState>;
  history: TrackingSummary | null;
  target: TargetResult | null;
  onBack: () => void;
  finish: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = `${window.location.origin}${REGISTER_PATH}`;
  const finishRef = useRef<HTMLButtonElement>(null);
  useEffect(() => finishRef.current?.focus(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  const open = async () => {
    if (finishing) return;
    setFinishing(true);
    setError(null);
    try {
      await finish();
    } catch {
      setFinishing(false);
      setError('Das hat nicht geklappt – der Server antwortet nicht. Versuch es gleich noch einmal.');
    }
  };

  return (
    <>
      <Header step={3} />
      <main className="mx-auto flex max-w-[760px] flex-col items-center px-4 pb-16 pt-8 text-center sm:px-8" data-testid="setup-done">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', bounce: 0.35, duration: 0.7 }}
          className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-ink shadow-[0_0_0_10px_rgb(255_255_255/0.05),0_0_0_22px_rgb(255_255_255/0.025)]"
        >
          <Check className="h-8 w-8 text-black" strokeWidth={2.6} aria-hidden />
        </motion.div>
        <h1 className="display mt-10 text-[44px] font-semibold sm:text-[56px]">Alles bereit.</h1>
        <p className="mt-4 max-w-[560px] text-[17px] leading-relaxed text-ink-2">
          Das Cockpit läuft. Ab hier geht alles im Browser: Einstellungen, Updates, Sicherungen und neue Konten.
        </p>
        <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[14px]">
          {SETUP_SERVICES.map((service) => {
            const ok = states[service.id]?.status === 'ok';
            return (
              <li key={service.id} className={cn('flex items-center gap-2', ok ? 'text-ink' : 'text-ink-3')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-good' : 'border border-ink-3')} aria-hidden />
                {service.name}
                {!ok && ' später'}
              </li>
            );
          })}
          <li className={cn('flex items-center gap-2', target ? 'text-ink' : 'text-ink-3')} data-testid="setup-done-target">
            <span className={cn('h-1.5 w-1.5 rounded-full', target ? 'bg-good' : 'border border-ink-3')} aria-hidden />
            {target ? `${target.dailyTarget} Leads pro Tag · höchstens ${target.dailyBudgetEur} € KI-Budget` : 'Tagesziel später'}
          </li>
          <li className={cn('flex items-center gap-2', history ? 'text-ink' : 'text-ink-3')} data-testid="setup-done-history">
            <span className={cn('h-1.5 w-1.5 rounded-full', history ? 'bg-good' : 'border border-ink-3')} aria-hidden />
            {history ? `${history.count} bisherige Leads` : 'Bisherige Leads später'}
          </li>
        </ul>

        <div className="mt-10 w-full rounded-[20px] bg-surface-2 p-5 text-left sm:p-7">
          <p className="text-[15px] font-semibold tracking-[-0.01em]">Team dazuholen</p>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-2">
            Schick diesen Link an dein Team. Wer sich registriert, landet bei dir zur Freigabe – du legst die Rolle fest, und
            auch, für welche Gründer ein Mitarbeiter arbeitet.
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label htmlFor="setup-register-link" className="sr-only">
              Link zum Registrieren
            </label>
            <input id="setup-register-link" readOnly value={link} className={cn(INPUT, 'font-mono text-[14px]')} onFocus={(event) => event.currentTarget.select()} data-testid="setup-register-link" />
            <Button variant="secondary" size="lg" onClick={() => void copy()} icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
              {copied ? 'Kopiert' : 'Kopieren'}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-6 flex items-baseline gap-2 text-[14px] text-ink">
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
            {error}
          </p>
        )}
        <div className="mt-10 flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" size="lg" onClick={onBack}>
            Zurück
          </Button>
          <Button ref={finishRef} variant="primary" size="lg" shortcut="↵" onClick={() => void open()} disabled={finishing} data-testid="setup-finish">
            {finishing ? 'Einen Moment…' : 'Zum Cockpit'}
          </Button>
        </div>
      </main>
    </>
  );
}
