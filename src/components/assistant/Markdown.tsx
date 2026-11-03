import { Fragment, type ReactNode } from 'react';
import { ASSISTANT_LEAD_LINK } from '../../../shared/assistant';

/**
 * Antworten des KI-Assistenten als Markdown – bewusst klein: Überschriften, Absätze, Listen, Tabellen, **fett**,
 * *kursiv*, `Code`, Links. Keine HTML-Einbettung (nur React-Knoten). Lead-Links `[Name](lead:<id>)` öffnen das Lead-Panel.
 */
export function Markdown({ text, onLead }: { text: string; onLead: (leadId: string) => void }) {
  return <div className="space-y-3 text-[15px] leading-[1.6] text-ink">{blocks(text, onLead)}</div>;
}

function blocks(text: string, onLead: (leadId: string) => void): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(
        <p key={index} className={level <= 2 ? 'pt-2 text-[17px] font-semibold tracking-[-0.01em]' : 'pt-1 text-[15px] font-semibold'}>
          {inline(heading[2], onLead)}
        </p>,
      );
      index++;
      continue;
    }
    // Tabelle: Kopfzeile, Trennzeile (|---|), Zeilen.
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1] ?? '')) {
      const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) rows.push(cells(lines[index++]));
      out.push(
        <div key={index} className="scroll-thin overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr>
                {head.map((cell, column) => (
                  <th key={column} className="border-b border-line px-2 py-1.5 text-left font-semibold text-ink-2">
                    {inline(cell, onLead)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column} className="border-b border-line/60 px-2 py-1.5 align-top tabular-nums">
                      {inline(cell, onLead)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index])) {
        let item = lines[index++].replace(pattern, '');
        // Fortsetzungszeilen (eingerückt) gehören zum Punkt.
        while (index < lines.length && /^\s{2,}\S/.test(lines[index]) && !bullet.test(lines[index]) && !numbered.test(lines[index])) item += ` ${lines[index++].trim()}`;
        items.push(item);
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={index} className={ordered ? 'list-decimal space-y-1.5 pl-5 marker:text-ink-3' : 'list-disc space-y-1.5 pl-5 marker:text-ink-3'}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, onLead)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      out.push(
        <blockquote key={index} className="border-l-2 border-line-strong pl-3 text-ink-2">
          {inline(quote.join(' '), onLead)}
        </blockquote>,
      );
      continue;
    }
    // Absatz: bis zur nächsten Leerzeile oder einem anderen Block.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|>|\|)/.test(lines[index])) paragraph.push(lines[index++]);
    if (!paragraph.length) paragraph.push(lines[index++]);
    out.push(
      <p key={index}>
        {paragraph.map((part, partIndex) => (
          <Fragment key={partIndex}>
            {partIndex > 0 && <br />}
            {inline(part, onLead)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

/** Inline: Links, **fett**, *kursiv* / _kursiv_, `Code`. */
function inline(text: string, onLead: (leadId: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [, label, href, bold, code, italic, underscore] = match;
    if (label !== undefined && href !== undefined) {
      if (href.startsWith(ASSISTANT_LEAD_LINK)) {
        const leadId = href.slice(ASSISTANT_LEAD_LINK.length);
        out.push(
          <button
            key={key++}
            type="button"
            onClick={() => onLead(leadId)}
            className="font-medium text-accent underline-offset-4 hover:underline"
            data-testid="assistant-lead-link"
          >
            {label}
          </button>,
        );
      } else if (/^https?:\/\//.test(href)) {
        out.push(
          <a key={key++} href={href} target="_blank" rel="noreferrer" className="text-accent underline-offset-4 hover:underline">
            {label}
          </a>,
        );
      } else {
        out.push(label);
      }
    } else if (bold !== undefined) {
      out.push(
        <strong key={key++} className="font-semibold">
          {inline(bold, onLead)}
        </strong>,
      );
    } else if (code !== undefined) {
      out.push(
        <code key={key++} className="rounded bg-surface-3 px-1 py-0.5 text-[13px]">
          {code}
        </code>,
      );
    } else {
      out.push(<em key={key++}>{italic ?? underscore}</em>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
