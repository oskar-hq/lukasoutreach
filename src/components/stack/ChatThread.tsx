import type { CockpitLead } from '../../../shared/leads';
import { FOUNDERS } from '../../data/founders';
import { cn } from '../../lib/cn';
import { leadInitials, leadName, type ThreadMessage } from '../../lib/leadView';
import { formatDateTime } from '../../lib/time';
import { Avatar } from '../ui/Avatar';

interface ChatThreadProps {
  lead: CockpitLead;
  messages: ThreadMessage[];
  /** Letzte Nachricht des Leads hervorheben. */
  highlightLatestReply?: boolean;
  compact?: boolean;
  /** Zeile über der Blase (Absender, Zeit). Aus, solange nur die neue Antwort zu sehen ist. */
  showMeta?: boolean;
}

export function ChatThread({ lead, messages, highlightLatestReply, compact, showMeta = true }: ChatThreadProps) {
  const latestReplyId = highlightLatestReply ? [...messages].reverse().find((m) => m.from === 'lead')?.id : undefined;
  const name = leadName(lead);

  return (
    <ol className={cn('flex flex-col', compact ? 'gap-3' : 'gap-4')}>
      {messages.map((message) => {
        const own = message.from === 'founder';
        const highlighted = message.id === latestReplyId;
        return (
          <li key={message.id} className={cn('flex items-end gap-2.5', own ? 'justify-end' : 'justify-start')}>
            {!own && <Avatar name={name} initials={leadInitials(lead)} size={28} className="mb-0.5" />}
            <div className={cn('flex min-w-0 max-w-[82%] flex-col', own ? 'items-end' : 'items-start')}>
              {(showMeta || highlighted) && (
                <div className="mb-1 flex items-center gap-1.5 px-1 text-[11.5px] text-ink-3">
                  {highlighted && (
                    <span className="mr-0.5 inline-flex items-center gap-1 font-medium text-accent">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      Neue Antwort
                    </span>
                  )}
                  {showMeta && (
                    <>
                      <span>{own ? (message.label ?? FOUNDERS[message.founder ?? lead.owner].name) : lead.person.firstName}</span>
                      <span aria-hidden>·</span>
                      <span>{message.pending ? 'noch nicht gespeichert' : formatDateTime(message.at)}</span>
                    </>
                  )}
                </div>
              )}
              <div
                className={cn(
                  // Lange Links oder Wörter ohne Leerzeichen umbrechen statt die Blase zu sprengen.
                  'min-w-0 max-w-full whitespace-pre-wrap rounded-[20px] text-ink [overflow-wrap:anywhere]',
                  compact ? 'px-3.5 py-2.5 text-[13.5px] leading-[1.55]' : 'px-4 py-3 text-[14.5px] leading-[1.55]',
                  own ? 'rounded-br-md bg-surface-4' : 'rounded-bl-md border border-line bg-surface-2',
                  highlighted && 'border-accent/50 bg-accent-soft shadow-[0_0_0_4px_rgb(41_151_255/0.08)]',
                  message.pending && 'opacity-70',
                )}
              >
                {message.text}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
