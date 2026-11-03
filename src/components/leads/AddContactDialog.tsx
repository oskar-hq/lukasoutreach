import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthFounderId } from '../../../shared/auth';
import { CONTACT_PROFILE_MAX_LENGTH, type AddContactResponse } from '../../../shared/leads';
import { cn } from '../../lib/cn';
import { ApiError, leadsApi } from '../../lib/leadSearchApi';
import { INPUT } from '../../pages/Login';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

interface AddContactDialogProps {
  open: boolean;
  /** Wem der Kontakt gehört – gelesen wird über dessen LinkedIn-Account. */
  owner: AuthFounderId;
  /** Anzeigename des Besitzers; null = der angemeldete Gründer selbst („du“). */
  ownerName: string | null;
  onClose: () => void;
  onAdded: (response: AddContactResponse) => void;
}

/** Grobe Vorprüfung im Browser – entscheidend ist das Backend (`POST /api/leads/contact`). */
const PROFILE_LINK = /linkedin\.com\/in\/[^/?#\s]+/i;

/**
 * Dialog „Kontakt hinzufügen“ (Wunsch des Nutzers 19.10.): Profil-Link eines persönlichen Kontakts einfügen – das
 * Cockpit liest das Profil einmal und legt einen normalen Lead an (vernetzt → „Vernetzt“). ↵ sendet, Esc schließt.
 */
export function AddContactDialog({ open, onClose, ...props }: AddContactDialogProps) {
  const [sending, setSending] = useState(false);
  return (
    <Modal open={open} onClose={() => !sending && onClose()} labelledBy="contact-dialog-title">
      {/* Jedes Öffnen beginnt mit einem leeren Feld. */}
      <ContactForm {...props} sending={sending} setSending={setSending} onClose={onClose} />
    </Modal>
  );
}

function ContactForm({
  owner,
  ownerName,
  sending,
  setSending,
  onClose,
  onAdded,
}: Omit<AddContactDialogProps, 'open'> & { sending: boolean; setSending: (value: boolean) => void }) {
  const [profile, setProfile] = useState('');
  // Jede Meldung ein neuer Knoten, damit Screenreader auch eine gleichlautende neu ansagen.
  const [error, setError] = useState<{ text: string; id: number } | null>(null);
  const errorCount = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const fail = (text: string) => {
    setError({ text, id: ++errorCount.current });
    inputRef.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Portale reichen Ereignisse im React-Baum weiter – ein Formular der Seite darf das nicht noch einmal bekommen.
    event.stopPropagation();
    if (sending) return;
    const value = profile.trim();
    if (!value) return fail('Füg den Link zum LinkedIn-Profil ein.');
    if (/^https?:\/\//i.test(value) && !PROFILE_LINK.test(value)) return fail('Das ist kein LinkedIn-Profil-Link – er sieht so aus: https://www.linkedin.com/in/…');
    setError(null);
    setSending(true);
    try {
      const response = await leadsApi.addContact({ profile: value, owner });
      setSending(false);
      onAdded(response);
    } catch (caught) {
      setSending(false);
      fail(caught instanceof ApiError && caught.message ? caught.message : 'Der Kontakt ließ sich nicht hinzufügen. Versuch es noch einmal.');
    }
  };

  return (
    <form className="max-h-[var(--sheet-inner-max-h)] overflow-y-auto overscroll-contain p-6 sm:p-8" noValidate onSubmit={(event) => void submit(event)} data-testid="contact-dialog">
      <h2 id="contact-dialog-title" className="text-[20px] font-semibold tracking-[-0.01em]">
        Kontakt hinzufügen
      </h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
        {ownerName
          ? `Für Leute, mit denen ${ownerName} auf LinkedIn schon vernetzt ist. Das Cockpit liest das Profil einmal über den LinkedIn-Account von ${ownerName} – ohne Suche – und legt einen Lead an.`
          : 'Für Leute, mit denen du auf LinkedIn schon vernetzt bist. Das Cockpit liest das Profil einmal über deinen LinkedIn-Account – ohne Suche – und legt einen Lead an.'}
      </p>

      <label htmlFor="contact-profile-input" className="mb-2 mt-6 block text-[13px] font-medium text-ink-2">
        Link zum LinkedIn-Profil
      </label>
      <input
        ref={inputRef}
        id="contact-profile-input"
        type="url"
        inputMode="url"
        value={profile}
        maxLength={CONTACT_PROFILE_MAX_LENGTH}
        onChange={(event) => {
          setProfile(event.target.value);
          setError(null);
        }}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        aria-invalid={!!error}
        aria-describedby={error ? 'contact-error' : undefined}
        placeholder="https://www.linkedin.com/in/…"
        data-testid="contact-profile-input"
        className={cn(INPUT, error && 'border-white/25')}
      />
      {error && (
        <p key={error.id} id="contact-error" role="alert" className="mt-2 flex items-baseline gap-2 text-[13.5px] leading-snug text-ink" data-testid="contact-error">
          <span className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full bg-bad" aria-hidden />
          {error.text}
        </p>
      )}

      <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose} disabled={sending}>
          Abbrechen
        </Button>
        <Button type="submit" variant="primary" shortcut={sending ? undefined : '↵'} disabled={sending} aria-busy={sending} data-testid="contact-submit">
          {sending ? 'Profil wird gelesen…' : 'Hinzufügen'}
        </Button>
      </div>
    </form>
  );
}
