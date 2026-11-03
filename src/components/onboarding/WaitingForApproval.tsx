import { motion, useReducedMotion } from 'motion/react';
import { Check, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { EASE_OUT } from '../../lib/motion';
import { rise } from '../../pages/Login';
import { useAuth } from '../../state/auth';
import { Logo } from '../layout/Logo';
import { Button } from '../ui/Button';

/** So oft fragt die Seite nach, ob die Freigabe da ist. */
const POLL_MS = 5_000;

/**
 * Registriert, aber noch nicht freigegeben (Vertrag „Registrierung und Einarbeitung“): Warteseite, die von selbst
 * weitergeht, sobald ein Gründer oder Admin freigibt.
 */
export function WaitingForApproval({ name }: { name: string }) {
  const { refresh, logout } = useAuth();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const signOut = async () => {
    if (leaving) return;
    setLeaving(true);
    setError(null);
    try {
      await logout();
    } catch (caught) {
      setLeaving(false);
      setError(caught instanceof Error ? caught.message : 'Abmelden hat nicht geklappt.');
    }
  };

  return (
    <div className="flex min-h-dvh flex-col px-4 sm:px-6" data-testid="waiting-page">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <Button variant="ghost" size="sm" onClick={() => void signOut()} disabled={leaving} data-testid="waiting-logout">
          {leaving ? 'Abmelden…' : 'Abmelden'}
        </Button>
      </header>
      <motion.main
        className="flex flex-1 flex-col items-center justify-center pb-24 text-center"
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.15 } } }}
      >
        <motion.div variants={rise} className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-line-strong">
          <Clock className="h-7 w-7 text-ink" strokeWidth={1.6} aria-hidden />
        </motion.div>
        <motion.h1 variants={rise} className="display mt-10 text-[40px] font-semibold sm:text-[52px]">
          Danke, {name}.
        </motion.h1>
        <motion.p variants={rise} className="mt-4 max-w-[520px] text-[17px] leading-relaxed text-ink-2">
          Dein Konto ist angelegt. Ein Gründer schaut sich deine Anfrage an und legt fest, was du im Cockpit machst.
        </motion.p>

        <motion.ol variants={rise} className="mt-12 grid w-full max-w-[560px] grid-cols-3 gap-2" aria-label="Fortschritt">
          <Step state="done" title="Registriert" meta="erledigt" />
          <Step state="current" title="Freigabe" meta="läuft" />
          <Step state="open" title="Einarbeitung" meta="etwa 2 Minuten" />
        </motion.ol>

        <motion.p variants={rise} className="mt-14 text-[13px] text-ink-3" role="status" data-testid="waiting-status">
          Lass diese Seite ruhig offen. Sie geht von selbst weiter, sobald du freigegeben bist.
        </motion.p>
        {error && (
          <p role="alert" className="mt-4 flex items-baseline gap-2 text-[14px] text-ink">
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
            {error}
          </p>
        )}
      </motion.main>
    </div>
  );
}

function Step({ state, title, meta }: { state: 'done' | 'current' | 'open'; title: string; meta: string }) {
  // Endlos-Pulsieren hält MotionConfig nicht an (nur Opacity) – bei „Bewegung reduzieren“ steht der Punkt still.
  const still = useReducedMotion() ?? false;
  return (
    <li className="flex flex-col items-center gap-3" aria-current={state === 'current' ? 'step' : undefined}>
      <span
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-full',
          state === 'done' && 'bg-ink text-black',
          state === 'current' && 'border border-ink',
          state === 'open' && 'border border-line-strong',
        )}
      >
        {state === 'done' && <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />}
        {state === 'current' && (
          <motion.span
            className="h-2 w-2 rounded-full bg-ink"
            animate={still ? { opacity: 1 } : { opacity: [1, 0.3, 1] }}
            transition={still ? { duration: 0 } : { duration: 1.6, repeat: Infinity, ease: EASE_OUT }}
            aria-hidden
          />
        )}
      </span>
      <span className={cn('text-[14px] font-medium', state === 'open' ? 'text-ink-3' : 'text-ink')}>{title}</span>
      <span className="text-[12.5px] text-ink-3">{meta}</span>
    </li>
  );
}
