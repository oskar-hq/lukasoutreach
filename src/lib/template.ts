import { FOUNDERS } from '../data/founders';
import { TOPIC_BY_SIGNAL } from '../data/templates';
import type { Lead } from '../state/types';
import type { CockpitLead } from '../../shared/leads';
import { DEFAULT_TOPIC, hiringRoleText, metaPauseText, metaStopText, type TemplateAudience } from '../../shared/messages';

export type VariableKey = 'vorname' | 'firma' | 'stelle' | 'thema' | 'grussformel' | 'metapause' | 'metastopp';

export interface TemplateVariable {
  key: VariableKey;
  label: string;
  value: string;
}

const LABELS: Record<VariableKey, string> = {
  vorname: 'Vorname',
  firma: 'Firma',
  stelle: 'Stelle',
  thema: 'Thema',
  grussformel: 'Grußformel',
  metapause: 'Meta-Ads aus seit',
  metastopp: 'Meta-Ads aufgehört',
};

export function variablesForLead(lead: Lead): TemplateVariable[] {
  const values: Partial<Record<VariableKey, string>> = {
    vorname: lead.firstName,
    firma: lead.company,
    stelle: lead.signal.type === 'hiring' ? lead.signal.role : '',
    thema: TOPIC_BY_SIGNAL[lead.signal.type],
    grussformel: FOUNDERS[lead.owner].greeting,
  };
  return (Object.keys(values) as VariableKey[])
    .filter((key) => values[key])
    .map((key) => ({ key, label: LABELS[key], value: values[key]! }));
}

/** Variablen für einen Lead aus der Datenbank – dieselben Werte wie beim Vorschlag im Backend (`shared/messages.ts`). */
export function variablesForCockpitLead(lead: CockpitLead): TemplateVariable[] {
  const values: Partial<Record<VariableKey, string>> = {
    vorname: lead.person.firstName,
    firma: lead.company.name,
    thema: DEFAULT_TOPIC,
    grussformel: FOUNDERS[lead.owner].greeting,
    // Wie im Backend (`metaPauseText`) – auch ohne Datum („seit einiger Zeit“), damit Vorlagen nie offen bleiben.
    metapause: metaPauseText(lead.metaAds?.lastStop),
    metastopp: metaStopText(lead.metaAds?.lastStop),
    // Nur mit Hiring-Signal anbieten – der Vorschlag im Backend füllt {{stelle}} immer (`hiringRoleText`).
    stelle: lead.hiring ? hiringRoleText(lead.hiring.role) : '',
  };
  return (Object.keys(values) as VariableKey[])
    .filter((key) => values[key])
    .map((key) => ({ key, label: LABELS[key], value: values[key]! }));
}

/**
 * Zielgruppe der Erstnachricht – wie das Backend beim Vorschlag (`server/src/messages/suggest.ts`): Reactivation, wenn
 * die Firma früher Meta-Ads geschaltet hat, „active“, wenn sie gerade schaltet (seit 12.10.), sonst Greenfield (auch bei
 * „unklar“).
 */
export function audienceFor(lead: CockpitLead): Exclude<TemplateAudience, 'any' | 'hiring'> {
  const ads = lead.metaAds?.state;
  const type = lead.score?.leadType ?? (ads === 'stopped' ? 'reactivation' : ads === 'active' ? 'active' : null);
  return type === 'reactivation' || type === 'active' ? type : 'greenfield';
}

/**
 * Erstnachrichten in der Reihenfolge, in der die Karte sie anbietet: mit Hiring-Signal zuerst die Recruiting-Vorlagen
 * (wie das Backend beim Vorschlag), danach die zum Lead-Typ – beide bleiben wählbar.
 */
export function firstAudiences(lead: CockpitLead): Exclude<TemplateAudience, 'any'>[] {
  return lead.hiring ? ['hiring', audienceFor(lead)] : [audienceFor(lead)];
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** Noch nicht ersetzte Platzhalter, z. B. ["firma"] – so darf die Nachricht nicht hinausgehen. */
export function unresolvedPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

export function fillTemplate(template: string, variables: TemplateVariable[]): string {
  return template.replace(PLACEHOLDER, (match, key: string) => {
    const variable = variables.find((v) => v.key === key);
    return variable ? variable.value : match;
  });
}

export interface HighlightRange {
  start: number;
  end: number;
  key: VariableKey;
}

/** Findet die eingesetzten Variablenwerte im (ggf. bearbeiteten) Text. */
export function findHighlights(text: string, variables: TemplateVariable[]): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  for (const variable of variables) {
    let from = 0;
    while (variable.value) {
      const index = text.indexOf(variable.value, from);
      if (index === -1) break;
      ranges.push({ start: index, end: index + variable.value.length, key: variable.key });
      from = index + variable.value.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: HighlightRange[] = [];
  let cursor = -1;
  for (const range of ranges) {
    if (range.start >= cursor) {
      result.push(range);
      cursor = range.end;
    }
  }
  return result;
}
