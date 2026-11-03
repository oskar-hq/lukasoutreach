import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CockpitLead } from '../../../shared/leads';
import { useHotkeys } from '../../lib/useHotkeys';
import { MESSAGE_TEXT_LIMIT } from '../../state/cockpit';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import type { DecideArgs } from './cardTypes';

/**
 * „Hat geantwortet“ auf Erstnachricht und Follow-up (manueller Betrieb): Antwort von LinkedIn direkt hier einfügen,
 * statt den Umweg über das Lead-Panel zu gehen. Danach steht die Antwort-Aufgabe gleich als Nächstes im Stapel.
 */
export function LogReply({ lead, onDecide, hotkeysEnabled }: { lead: CockpitLead; onDecide: (args: DecideArgs) => void; hotkeysEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const body = text.trim();
  const tooLong = text.length > MESSAGE_TEXT_LIMIT;

  useEffect(() => {
    if (open) fieldRef.current?.focus();
  }, [open]);
  useHotkeys({ a: () => setOpen(true) }, hotkeysEnabled && !open);

  const submit = () => {
    if (!body || tooLong) return;
    onDecide({
      decision: 'reply_logged',
      positive: true,
      action: { action: 'message_received', text: body },
      toast: { pending: 'Antwort wird eingetragen', done: 'Antwort eingetragen', short: { pending: 'Wird eingetragen', done: 'Eingetragen' } },
    });
  };

  if (!open) {
    return (
      <div className="mt-6 flex justify-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-2"
          data-testid="log-reply"
        >
          {lead.person.firstName} hat geantwortet
          <Kbd>A</Kbd>
        </button>
      </div>
    );
  }

  return (
    <form
      className="mx-auto mt-6 w-full max-w-[560px]"
      data-testid="log-reply-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="mb-1.5 block px-1 text-[13px] font-medium text-ink-2" htmlFor={`log-reply-${lead.id}`}>
        Antwort von {lead.person.firstName}
      </label>
      <textarea
        id={`log-reply-${lead.id}`}
        ref={fieldRef}
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
          }
        }}
        placeholder="Antwort aus LinkedIn hier einfügen …"
        className="w-full resize-y rounded-xl border border-transparent bg-surface-3 px-3 py-2.5 text-[14px] leading-[1.5] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
      />
      {tooLong && <p className="mt-1 px-1 text-[12px] text-ink">Höchstens {MESSAGE_TEXT_LIMIT.toLocaleString('de-DE')} Zeichen.</p>}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
          Abbrechen
        </Button>
        <Button variant="secondary" size="sm" type="submit" disabled={!body || tooLong} icon={<Check className="h-3.5 w-3.5" />} data-testid="log-reply-submit">
          Antwort eintragen
        </Button>
      </div>
    </form>
  );
}
