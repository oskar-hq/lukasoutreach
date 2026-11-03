import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

interface PasswordDialogProps {
  open: boolean;
  title: string;
  /** Was passiert – ein bis zwei Sätze. */
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  /** Fehlermeldung des Servers (z. B. falsches Passwort); jede neue `id` leert das Feld. */
  error: { text: string; id: number } | null;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}

/** Rückfrage mit Passwort vor einer folgenreichen Aktion (Update, Sicherung herunterladen oder einspielen). */
export function PasswordDialog({ open, title, children, confirmLabel, busyLabel, busy, error, onCancel, onConfirm }: PasswordDialogProps) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = error?.id;

  useEffect(() => {
    if (!open) setPassword('');
  }, [open]);
  useEffect(() => {
    if (errorId === undefined) return;
    setPassword('');
    inputRef.current?.focus();
  }, [errorId]);

  return (
    <Modal open={open} onClose={() => !busy && onCancel()} labelledBy="password-dialog-title">
      <form
        className="p-6 sm:p-8"
        data-testid="password-dialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!busy && password) onConfirm(password);
        }}
      >
        <h2 id="password-dialog-title" className="text-[20px] font-semibold">
          {title}
        </h2>
        <div className="mt-3 space-y-2 text-[14.5px] leading-relaxed text-ink-2">{children}</div>
        <label htmlFor="password-dialog-input" className="mb-2 mt-5 block text-[13px] font-medium text-ink-2">
          Dein Passwort
        </label>
        <input
          ref={inputRef}
          id="password-dialog-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? 'password-dialog-error' : undefined}
          className="h-12 w-full rounded-2xl border border-transparent bg-surface-3 px-4 text-[16px] text-ink outline-none transition-colors focus:border-accent"
        />
        {error && (
          <p key={error.id} id="password-dialog-error" role="alert" className="mt-3 flex items-baseline gap-2 text-[14px] text-ink" data-testid="password-dialog-error">
            <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
            {error.text}
          </p>
        )}
        <div className="mt-7 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Abbrechen
          </Button>
          <Button type="submit" variant="primary" shortcut={busy ? undefined : '↵'} disabled={busy || !password} data-testid="password-dialog-confirm">
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
