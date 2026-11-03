/**
 * Erzeugt `src/leads/demoSeed.ts` aus den Demo-Daten des Frontends (`src/data/`, nur gelesen).
 * So zeigt die Simulation im Backend dieselben 30 Leads mit demselben Verlauf wie die bisherige Demo.
 * Zeitstempel werden relativ gespeichert (ms vor dem Anlegen) – die Demo wirkt an jedem Tag „frisch“.
 *
 * Neu erzeugen, wenn sich die Demo-Daten im Frontend ändern:
 *   npx tsx scripts/buildDemoSeed.ts   (im Ordner server/)
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHistory } from '../../src/data/history';
import { LEADS } from '../../src/data/leads';
import { linkedinUrl } from '../../src/lib/leadInfo';
import type { Lead, TimelineEvent } from '../../src/state/types';
import type { LeadCategory } from '../../shared/leadSearch.js';
import type { LeadEventKind, LeadStage } from '../../shared/leads.js';
import type { DemoSeedLead } from '../src/leads/demoTypes.js';

const NOW = Date.UTC(2026, 9, 1, 9, 0, 0);

const CATEGORY: Record<Lead['fit'], LeadCategory> = {
  kapitalanlage: 'kapitalanlage_vertrieb',
  bautraeger: 'bautraeger_projektentwickler',
  makler: 'makler',
  hausverwaltung: 'hausverwaltung',
};

const KIND: Record<TimelineEvent['kind'], LeadEventKind | null> = {
  scraped: 'created',
  assessed: 'assessed',
  connection_sent: 'invite_sent',
  connection_accepted: 'invite_accepted',
  message_sent: 'message_sent',
  message_received: 'message_received',
  rejected: null,
  skipped: null,
  exported: null,
  discarded: null,
};

function stageOf(lead: Lead): LeadStage {
  switch (lead.stage) {
    case 'lead':
      return 'new';
    case 'first':
      return 'connected';
    case 'followup':
      return 'contacted';
    case 'reply':
      // Antworten per Slack-Ping sind zu Beginn noch nicht da.
      return lead.arrivesViaPing ? 'contacted' : 'replied';
  }
}

/**
 * Alte Demo-Vorlagen (A/B/C, „gerade Meta Ads“) auf die heutigen IDs aus `server/src/messages/defaults.ts`:
 * Erstnachricht A → G1, B → G2, C → R1; Follow-up-Variante A → F<n>A, B/C → F<n>B.
 */
const FIRST_TEMPLATE: Record<string, string> = { A: 'G1', B: 'G2', C: 'R1' };
const followUpTemplate = (stage: number, variant: string) => `F${Math.min(3, Math.max(1, stage))}${variant === 'A' ? 'A' : 'B'}`;

/** Label und Titel eines gesendeten Demo-Ereignisses wie bei neuen Ereignissen (`applyAction`). */
function sentLabel(title: string): { label: string | null; title: string } {
  const first = /Template ([A-C])\b/.exec(title);
  if (first) {
    const label = FIRST_TEMPLATE[first[1]];
    return { label, title: `Erstnachricht · Vorlage ${label} gesendet` };
  }
  const followUp = /Follow-up (\d)\D*Variante ([A-C])\b/.exec(title);
  if (followUp) {
    const label = followUpTemplate(Number(followUp[1]), followUp[2]);
    return { label, title: `Follow-up ${followUp[1]} · Variante ${label} gesendet` };
  }
  return { label: null, title };
}

/** Fester Reactivation-Lead (Meta-Ads beendet) mit Erstnachricht-Aufgabe bei Nick – für die R1/R2-Vorlagen und E2E. */
const REACTIVATION_KEY = LEADS.find((lead) => lead.owner === 'nick' && lead.stage === 'first')?.id;
const DAY = 24 * 60 * 60 * 1000;

const seed: DemoSeedLead[] = LEADS.map((lead) => {
  const { events } = buildHistory(lead, NOW);
  const url = `https://www.${linkedinUrl(lead)}`;
  return {
    key: lead.id,
    owner: lead.owner,
    stage: stageOf(lead),
    person: {
      firstName: lead.firstName,
      lastName: lead.lastName,
      headline: `${lead.position} · ${lead.company}`,
      position: lead.position,
      location: lead.region,
      providerId: lead.providerId ?? lead.id,
      publicIdentifier: url.split('/in/')[1] ?? null,
      profileUrl: url,
      networkDistance: lead.stage === 'lead' ? 2 : 1,
    },
    company: { name: lead.company, website: null, industry: lead.industry, region: lead.region },
    assessment: { category: CATEGORY[lead.fit], confidence: 0.9, reason: lead.fitReason, summary: lead.summary },
    template: lead.stage === 'lead' || lead.stage === 'first' ? null : lead.template ? (FIRST_TEMPLATE[lead.template] ?? lead.template) : null,
    ...(lead.id === REACTIVATION_KEY
      ? {
          metaAds: {
            state: 'stopped' as const,
            advertiser: lead.company,
            ads: 4,
            activeAds: 0,
            lastStop: new Date(NOW - 120 * DAY).toISOString().slice(0, 10),
            foreignAds: 0,
            libraryUrl: null,
            note: null,
          },
        }
      : {}),
    followUpsSent: lead.stage === 'lead' || lead.stage === 'first' ? 0 : (lead.followUps?.length ?? 0),
    nextStep: lead.nextStep ?? null,
    events: events.flatMap((event) => {
      const kind = KIND[event.kind];
      if (!kind) return [];
      const isMessage = kind === 'message_sent' || kind === 'message_received';
      // Wie bei neuen Ereignissen: ID der Vorlage („G1“, „F2A“) als Label, Titel im selben Format.
      const sent = kind === 'message_sent' ? sentLabel(event.title) : { label: null, title: event.title };
      const label = sent.label;
      return [
        {
          kind,
          offsetMs: event.at - NOW,
          by: event.by ?? null,
          title: kind === 'created' ? 'Lead gefunden' : sent.title,
          text: isMessage ? (event.detail ?? null) : (event.detail ?? null),
          label,
        },
      ];
    }),
  };
});

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/leads/demoSeed.ts');
writeFileSync(
  target,
  `// Erzeugt von scripts/buildDemoSeed.ts aus src/data/ – nicht von Hand ändern.\n` +
    `import type { DemoSeedLead } from './demoTypes.js';\n\n` +
    `export const DEMO_SEED: DemoSeedLead[] = ${JSON.stringify(seed, null, 2)};\n`,
);
console.log(`${seed.length} Demo-Leads → ${path.relative(process.cwd(), target)}`);
