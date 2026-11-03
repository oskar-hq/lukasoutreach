import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { HANDOVER_NOTE_MAX_LENGTH, type CrmMode } from '../../../shared/crm';
import { LEAD_STAGE_LABELS, type CockpitLead } from '../../../shared/leads';
import type { LeadConversation } from '../../../shared/messages';
import { FOUNDERS } from '../../data/founders';
import {
  leadCompany,
  leadFit,
  leadIndustry,
  leadName,
  leadPosition,
  leadRegion,
  linkedinProfileUrl,
  replyAssessmentParts,
  shortUrl,
  type LeadSignal,
  type ThreadMessage,
} from '../../lib/leadView';
import { Button } from '../ui/Button';
import { DisclosureToggle } from '../ui/Disclosure';
import { Modal } from '../ui/Modal';
import { isActivatableTarget } from '../../lib/useHotkeys';
import { copyText } from './MessageEditor';

interface CloseExportModalProps {
  open: boolean;
  lead: CockpitLead;
  messages: ThreadMessage[];
  signal: LeadSignal | null;
  /** Modus von `GET /api/crm/status`; null = noch unbekannt (dann kein Bestätigen). */
  crmMode: CrmMode | null;
  onClose: () => void;
  /** Mit Notiz für Close (leer = keine). */
  onConfirm: (note: string) => void;
}

function replyText(conversation: LeadConversation): string {
  const { label, detail } = replyAssessmentParts(conversation);
  return detail ? `${label} – ${detail}` : label;
}

/** Felder für Close – aus dem Lead in der Datenbank. */
function exportFields(lead: CockpitLead, messages: ThreadMessage[], signal: LeadSignal | null): [string, string][] {
  const own = messages.filter((message) => message.from === 'founder').length;
  const conversation = lead.conversation;
  return [
    ['Kontakt', leadName(lead)],
    ['Position', leadPosition(lead)],
    ['Firma', leadCompany(lead)],
    ['Branche', leadIndustry(lead) ?? '–'],
    ['KI-Einschätzung', leadFit(lead)?.label ?? '–'],
    ['Region', leadRegion(lead) ?? '–'],
    ['LinkedIn', linkedinProfileUrl(lead) ? shortUrl(linkedinProfileUrl(lead)!) : '–'],
    ['Lead-Status', LEAD_STAGE_LABELS[lead.stage]],
    ['Zuständig', FOUNDERS[lead.owner].name],
    ['Quelle', `LinkedIn Outreach${lead.template ? ` · Vorlage ${lead.template}` : ''}`],
    ['Signal', signal?.label ?? '–'],
    ['Nachrichten', `${own} gesendet · ${messages.length - own} erhalten`],
    ['Antwort', conversation ? replyText(conversation) : '–'],
    ['Nächster Schritt', lead.nextStep ?? '–'],
  ];
}

export function CloseExportModal({ open, lead, messages, signal, crmMode, onClose, onConfirm }: CloseExportModalProps) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [note, setNote] = useState('');
  // Die Angaben sind einen Klick entfernt – Close bekommt sie ohnehin, „Angaben kopieren“ nimmt alle.
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const fields = exportFields(lead, messages, signal);
  // Mit Close-Anbindung legt das Backend den Lead an – sonst kopierst du die Angaben und trägst nur ein.
  const viaClose = crmMode === 'mock' || crmMode === 'live';
  const ready = crmMode !== null;
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const noteRef = useRef(note);
  noteRef.current = note;

  useEffect(() => {
    if (!open) return;
    setNote('');
    setFieldsOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || !ready) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat) return;
      // ↵ bestätigt – außer auf einem Knopf im Dialog selbst (der macht seins). Ein Knopf der Karte dahinter zählt nicht.
      // Im Notizfeld macht ↵ eine neue Zeile, ⌘↵ bestätigt.
      const target = event.target as HTMLElement | null;
      const ownButton = isActivatableTarget(event.target) && !!target?.closest('[role="dialog"]');
      const inNote = target?.tagName === 'TEXTAREA';
      if (ownButton || (inNote && !event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      confirmRef.current(noteRef.current.trim());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, ready]);

  const copyFields = async () => {
    const ok = await copyText(fields.map(([label, value]) => `${label}: ${value}`).join('\n'));
    setCopied(ok ? 'ok' : 'failed');
    // Kopieren ging nicht: Angaben zeigen, damit man sie markieren kann.
    if (!ok) setFieldsOpen(true);
    window.setTimeout(() => setCopied(null), ok ? 1500 : 4000);
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="close-export-title">
      <div className="flex max-h-[var(--sheet-inner-max-h)] flex-col" data-testid="close-export">
        <div className="px-5 pt-6 sm:px-7">
          <h2 id="close-export-title" className="display text-[24px] font-semibold">
            {leadName(lead)} an Close übergeben
          </h2>
          <p className="mt-1 text-[13.5px] text-ink-2" data-testid="close-export-hint">
            {!ready
              ? 'Close-Anbindung wird geprüft …'
              : viaClose
                ? 'Das Cockpit legt ihn mit Einschätzung und Verlauf in Close an.'
                : 'Close ist noch nicht angebunden (Einstellungen → Close und Slack) – kopier die Angaben und leg den Lead selbst an.'}
          </p>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-5 pb-6 pt-4 sm:px-7">
          <DisclosureToggle look="chip" className="-ml-2" open={fieldsOpen} onToggle={() => setFieldsOpen((o) => !o)} controls={fieldsOpen ? 'close-fields' : undefined}>
            Angaben ansehen
          </DisclosureToggle>
          {fieldsOpen && (
            <dl id="close-fields" className="mt-2 grid gap-y-1.5 text-[13.5px]">
              {fields.map(([label, value]) => (
                <div key={label} className="flex gap-3">
                  <dt className="w-36 shrink-0 text-ink-3">{label}</dt>
                  <dd className="min-w-0 break-words text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* Immer selbst etwas dazuschreiben können (Wunsch des Nutzers 07.10.) – ohne Close landet die Notiz im Verlauf. */}
          {ready && (
            <div className="mt-5">
              <label htmlFor="close-note" className="mb-1.5 block text-[13px] font-medium text-ink-2">
                {viaClose ? 'Deine Notiz für Close' : 'Deine Notiz zur Übergabe'} <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <textarea
                id="close-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={HANDOVER_NOTE_MAX_LENGTH}
                rows={3}
                className="w-full resize-none rounded-xl bg-surface-2 px-3.5 py-2.5 text-[14px] leading-[1.5] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong"
                placeholder="Was soll der Kollege wissen? z. B. Termin Do. 10 Uhr"
                data-testid="close-note"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-white/[0.015] px-5 py-4 sm:px-7">
          <Button variant="ghost" size="lg" shortcut="Esc" onClick={onClose}>
            Abbrechen
          </Button>
          {ready && !viaClose && (
            <Button variant="secondary" size="lg" onClick={() => void copyFields()} icon={copied === 'ok' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}>
              {copied === 'ok' ? 'Kopiert' : copied === 'failed' ? 'Kopieren ging nicht – bitte markieren' : 'Angaben kopieren'}
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            shortcut="↵"
            disabled={!ready}
            onClick={() => onConfirm(note.trim())}
            icon={<ArrowUpRight className="h-4 w-4" />}
            data-testid="close-export-confirm"
          >
            {viaClose ? 'An Close übergeben' : 'Als übergeben eintragen'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
