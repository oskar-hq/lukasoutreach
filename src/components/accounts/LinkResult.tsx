import { motion } from 'motion/react';
import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { inviteLink, validityText } from './accountText';
import { EASE_OUT } from '../../lib/motion';

export interface CreatedLink {
  /** Zählt hoch – ein neuer Link baut die Anzeige neu auf (Fokus, „Kopiert“). */
  id: number;
  token: string;
  username: string;
  name: string;
  expiresAt: number;
  /** true = Link „Passwort neu setzen“ für ein bestehendes Konto. */
  reset: boolean;
}

type CopyState = 'idle' | 'copied' | 'selected';

/**
 * Gerade erzeugter Link zum Weitergeben. Er steht nur im Speicher dieser Seite – beim Verlassen ist er weg
 * (das Backend zeigt das Token nie wieder).
 */
export function LinkResult({ link, onDismiss, announce }: { link: CreatedLink; onDismiss: () => void; announce: (text: string) => void }) {
  const url = inviteLink(link.token);
  const [copy, setCopy] = useState<CopyState>('idle');
  const copyRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    copyRef.current?.focus();
  }, []);

  /** Ohne Clipboard-API (http, ältere Browser, verweigert): Link markieren, kopieren macht man selbst. */
  const selectText = () => {
    const node = textRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const copyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Keine Zwischenablage');
      await navigator.clipboard.writeText(url);
      setCopy('copied');
      announce('Link kopiert.');
    } catch {
      selectText();
      setCopy('selected');
      announce('Link markiert – kopier ihn mit Strg+C bzw. ⌘C.');
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      aria-labelledby="link-result-title"
      className="mt-10 rounded-[24px] bg-surface-2 p-5 sm:p-6"
      data-testid="link-result"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="link-result-title" className="text-[17px] font-semibold tracking-[-0.01em]">
            {link.reset ? `Neues Passwort für ${link.name}` : `Link für ${link.name}`}
          </h2>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Link ausblenden"
          className="-mr-2 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          data-testid="link-dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p
        ref={textRef}
        className="mt-4 select-all break-all rounded-2xl bg-white/[0.04] px-4 py-3 font-mono text-[13.5px] leading-relaxed text-ink"
        data-testid="link-url"
      >
        {url}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          ref={copyRef}
          variant="secondary"
          icon={copy === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          onClick={() => void copyLink()}
          data-testid="link-copy"
        >
          {copy === 'copied' ? 'Kopiert' : 'Link kopieren'}
        </Button>
        {copy === 'selected' && (
          <span className="text-[13px] text-ink-2" data-testid="link-selected">
            Link markiert – kopier ihn mit Strg+C bzw. ⌘C.
          </span>
        )}
      </div>

      <p className="mt-4 text-[13.5px] leading-snug text-ink-2" data-testid="link-validity">
        {validityText(link.reset, link.expiresAt)}
        {link.reset && ' Bis dahin gilt das alte Passwort.'}
      </p>
      <p className="mt-1 text-[13px] leading-snug text-ink-3">
        Nur an {link.name} schicken – wer ihn hat, kann {link.reset ? 'ein neues Passwort setzen' : 'das Konto einrichten'}. Der Link wird nur jetzt
        angezeigt.
      </p>
    </motion.section>
  );
}
