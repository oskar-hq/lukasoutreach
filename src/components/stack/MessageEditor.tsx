import { Check, Copy, PenLine } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ForwardedRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { findHighlights, type TemplateVariable } from '../../lib/template';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';

interface MessageEditorProps {
  value: string;
  onChange: (value: string) => void;
  variables: TemplateVariable[];
  placeholder?: string;
  onSubmit?: () => void;
  label?: string;
  /** Verb im Tastenhinweis („⌘ ↵ senden“ bzw. „⌘ ↵ eintragen“). */
  submitVerb?: string;
  /** Knopf „Kopieren“ – zum Einfügen auf LinkedIn, solange das Cockpit nicht selbst sendet. */
  copyable?: boolean;
  /** Kopieren gesperrt (z. B. Platzhalter offen). */
  copyDisabled?: boolean;
  describedBy?: string;
  /** Weitere Textknöpfe in der Zeile unter dem Feld (z. B. „Vorschlag“). */
  actions?: ReactNode;
  /** Höchstlänge – der Zähler erscheint erst kurz davor. */
  limit?: number;
}

/** In die Zwischenablage – mit Ausweg für Seiten ohne sicheren Kontext (http im Heimnetz). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // weiter mit dem Ausweg
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Noch offene Platzhalter wie {{stelle}} – werden gestrichelt markiert. */
function placeholderRanges(text: string) {
  return [...text.matchAll(/\{\{\w+\}\}/g)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/** Cursor ans Ende setzen und Feld fokussieren. */
export function focusAtEnd(field: HTMLTextAreaElement | null) {
  if (!field) return;
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

/**
 * Editierbares Nachrichtenfeld. Eine Textarea mit transparentem Text liegt exakt über einem
 * Backdrop, der denselben Text rendert – dort werden die Variablen farbig hervorgehoben.
 */
export const MessageEditor = forwardRef<HTMLTextAreaElement, MessageEditorProps>(function MessageEditor(
  { value, onChange, variables, placeholder, onSubmit, label = 'Nachricht', submitVerb = 'senden', copyable = false, copyDisabled = false, describedBy, actions, limit },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), copied === 'ok' ? 1500 : 4000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      fieldRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  const segments = useMemo(() => {
    const ranges = [
      ...findHighlights(value, variables).map((range) => ({ ...range, open: false })),
      ...placeholderRanges(value).map((range) => ({ ...range, key: 'placeholder', open: true })),
    ].sort((a, b) => a.start - b.start);
    const parts: { text: string; key?: string; open?: boolean }[] = [];
    let cursor = 0;
    for (const range of ranges) {
      if (range.start < cursor) continue;
      if (range.start > cursor) parts.push({ text: value.slice(cursor, range.start) });
      parts.push({ text: value.slice(range.start, range.end), key: range.key, open: range.open });
      cursor = range.end;
    }
    if (cursor < value.length) parts.push({ text: value.slice(cursor) });
    return parts;
  }, [value, variables]);

  return (
    <div>
      <div
        className={cn(
          'relative rounded-[22px] border text-left transition-[border-color,background-color] duration-200',
          focused ? 'border-accent/60 bg-surface-3' : 'border-transparent bg-surface-3 hover:bg-surface-4/70',
        )}
      >
        <div aria-hidden className="editor-layer min-h-[140px] text-ink">
          {value.length === 0 && <span className="text-ink-3">{placeholder}</span>}
          {segments.map((part, index) =>
            part.key ? (
              <span key={index} className={cn('variable-mark', part.open && 'outline-dashed outline-1 outline-offset-2 outline-accent/70')}>
                {part.text}
              </span>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
          {value.endsWith('\n') && ' '}
        </div>
        <textarea
          ref={setRefs}
          aria-label={label}
          aria-describedby={describedBy}
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmit?.();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.blur();
            }
          }}
          className="editor-layer editor-input absolute inset-0 h-full w-full resize-none overflow-hidden rounded-[22px] bg-transparent outline-none"
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 px-1 text-[12.5px] text-ink-3">
        <div className="flex flex-wrap items-center gap-1">
          {focused ? (
            <span className="inline-flex h-8 items-center gap-1.5">
              <Kbd>⌘ ↵</Kbd> {submitVerb} · <Kbd>Esc</Kbd> fertig
            </span>
          ) : (
            <Button variant="ghost" size="sm" shortcut="E" icon={<PenLine className="h-3.5 w-3.5" />} className="-ml-3" onClick={() => focusAtEnd(fieldRef.current)}>
              Bearbeiten
            </Button>
          )}
          {actions}
          {copyable && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="copy-message"
              disabled={copyDisabled || !value.trim()}
              // Fokus bleibt im Feld, falls man gerade tippt.
              onMouseDown={(event) => event.preventDefault()}
              onClick={async () => setCopied((await copyText(value)) ? 'ok' : 'failed')}
              icon={copied === 'ok' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            >
              {copied === 'ok' ? 'Kopiert' : 'Kopieren'}
            </Button>
          )}
          {copied === 'failed' && (
            <span role="status" className="text-ink-2">
              Kopieren geht hier nicht – markiere den Text und drücke ⌘C.
            </span>
          )}
        </div>
        {/* Zähler erst kurz vor der Grenze – vorher ist er nur Rauschen. */}
        {limit && value.length >= limit * 0.9 ? (
          <span className={cn('shrink-0 tabular-nums', value.length > limit && 'text-warn')}>
            {value.length.toLocaleString('de-DE')} / {limit.toLocaleString('de-DE')}
          </span>
        ) : null}
      </div>
    </div>
  );
});
