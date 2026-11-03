import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AUTH_FOUNDER_IDS, defaultFounderName } from '../../../shared/auth.js';
import { AUTO_SEARCH_FOCUS_LABELS, type AutoSearchListResponse, type AutoSearchSchedule, type AutoSearchUpdate, type Weekday } from '../../../shared/autoSearch.js';
import type { LinkedInAccountLimits, LinkedInAccountsResponse } from '../../../shared/linkedin.js';
import {
  SETTINGS,
  SETTING_GROUP_LABELS,
  SETTING_KEYS,
  settingDefinition,
  type SettingDefinition,
  type SettingKey,
  type SettingState,
  type SettingValue,
  type SettingsResponse,
} from '../../../shared/settings.js';

/**
 * Einstellungen per Claude-App (Wunsch des Nutzers 31.10.): Die Gründer beschreiben in eigenen Worten, was anders
 * laufen soll. Oft gibt es dafür schon eine Einstellung, die sie nur nicht finden. Claude liest alles Einstellbare
 * mit Erklärung und aktuellem Wert (`find_settings`), ändert es über dieselben Routen wie die Oberfläche
 * (Rechte, Prüfungen und Verlauf gelten unverändert) – und sagt ehrlich, wenn es etwas noch nicht gibt.
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export type CockpitCall = <T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) => Promise<{ ok: true; body: T } | { ok: false; message: string }>;

/** Satz für Wünsche, die es (noch) nicht gibt – steht auch in den Server-Anweisungen. */
export const NOT_BUILT_YET = 'Das ist leider noch nicht gebaut. Wende dich bitte an die Entwickler.';

export const SETTINGS_INSTRUCTIONS = `Einstellungen: Möchte der Nutzer, dass etwas anders läuft (Grenzen, Zeiten, Suche, Follow-ups, KI, Accounts …), ruf zuerst find_settings auf und prüf, ob es dafür schon eine Einstellung gibt – meistens gibt es sie. Dann erklär kurz, welche es ist, und nenn alten und neuen Wert; ändere erst nach seinem Ja (außer er hat es schon klar so verlangt) mit change_setting, change_auto_search oder change_account_limits. Ist sie mit „nur in der Oberfläche“ markiert, sag ihm, wo er sie im Cockpit findet (Einstellungen → Bereich). Gibt es nichts Passendes, sag genau: „${NOT_BUILT_YET}“ – und fasse in einem Satz zusammen, was er sich wünscht, damit er es weitergeben kann. Erfinde keine Einstellungen.`;

/** Im Chat änderbar: alles außer Geheimnissen, Passwort-Rückfrage, Probe-Änderungen und `.env`-Werten. */
function chatBlock(definition: SettingDefinition): string | null {
  if (definition.readOnlyReason) return `nur über die .env auf dem Server: ${definition.readOnlyReason}`;
  if (definition.type === 'secret') return 'Zugangsschlüssel – nur in der Oberfläche';
  if (definition.reauth) return 'braucht dein Passwort – nur in der Oberfläche';
  if (definition.trial) return 'wird erst auf Probe geändert – nur in der Oberfläche';
  return null;
}

const CHAT_KEYS = SETTINGS.filter((definition) => !chatBlock(definition)).map((definition) => definition.key);

function showValue(definition: SettingDefinition, value: SettingValue | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'nicht gesetzt';
  if (definition.type === 'boolean') return value === true ? 'an' : 'aus';
  if (definition.type === 'choice') {
    const option = definition.options?.find((entry) => entry.value === value);
    return option ? `${option.label} (${String(value)})` : String(value);
  }
  return String(value);
}

function allowed(definition: SettingDefinition): string {
  switch (definition.type) {
    case 'boolean':
      return 'an/aus (true/false)';
    case 'choice':
      return (definition.options ?? []).map((option) => `${option.value} = ${option.label}`).join(' · ');
    case 'integer':
    case 'number': {
      const range = [definition.min !== undefined ? `ab ${definition.min}` : '', definition.max !== undefined ? `bis ${definition.max}` : ''].filter(Boolean).join(' ');
      return `${definition.type === 'integer' ? 'ganze Zahl' : 'Zahl'}${range ? ` ${range}` : ''}${definition.allowOff ? ' oder „off“' : ''}`;
    }
    case 'url':
      return 'Adresse (https://…)';
    default:
      return 'Text';
  }
}

function settingLine(definition: SettingDefinition, state: SettingState | undefined): string {
  const block = chatBlock(definition);
  const current = definition.type === 'secret' ? (state?.secret?.set ? 'gesetzt' : 'nicht gesetzt') : showValue(definition, state?.value);
  const source = state?.source === 'default' ? ' (Standard)' : state?.source === 'env' ? ' (aus der .env)' : '';
  return [
    `- **${definition.label}** · key ${definition.key} · jetzt: ${current}${source}${block ? ` · ${block}` : ` · erlaubt: ${allowed(definition)}`}`,
    `  ${definition.help}`,
  ].join('\n');
}

const WEEKDAY_LABELS: Record<Weekday, string> = { 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So' };

function scheduleLines(schedule: AutoSearchSchedule): string[] {
  const percent = schedule.kapitalanlagePercent ?? 50;
  return [
    `### ${defaultFounderName(schedule.founder)} (founder ${schedule.founder})`,
    `- eingeschaltet (enabled): ${schedule.enabled ? 'ja' : 'nein'}`,
    `- Tage (days, 1 = Mo … 7 = So): ${schedule.days.map((day) => WEEKDAY_LABELS[day]).join(', ') || 'keine'}`,
    `- Uhrzeit (time): ${schedule.time} · zweiter Termin (second_time): ${schedule.secondTime ?? 'aus'}`,
    `- Stichwörter (keywords): ${schedule.profile.keywords.join(', ') || '–'}`,
    `- Positionen (positions): ${schedule.profile.positions.join(', ') || '–'}`,
    `- Region (region): ${schedule.profile.region || '–'} · Profile pro Lauf (max_results): ${schedule.profile.maxResults}`,
    `- Tagesziel qualifizierte Leads (daily_target): ${schedule.dailyTarget ?? 'aus (ein Lauf je Termin)'} · höchstens Läufe pro Tag (max_rounds): ${schedule.maxRounds ?? '–'}`,
    `- KI-Tagesbudget in Euro (daily_budget_eur): ${schedule.dailyBudgetEur ?? 'ohne Budget'}`,
    `- Zielgruppen-Mix (kapitalanlage_percent): ${percent} % ${AUTO_SEARCH_FOCUS_LABELS.kapitalanlage_vertrieb}, ${100 - percent} % ${AUTO_SEARCH_FOCUS_LABELS.finanzdienstleister}`,
  ];
}

const limitText = (value: number | null | undefined, fallback: number | undefined) => (value === null || value === undefined ? `Standard (${fallback ?? '–'})` : String(value));

/** Wert aus dem Chat in den Typ der Einstellung bringen („25“ → 25, „an“ → true). */
function coerce(definition: SettingDefinition, value: string | number | boolean | null): SettingValue | null {
  if (value === null) return null;
  if ((definition.type === 'integer' || definition.type === 'number') && typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (definition.allowOff && text.toLowerCase() === 'off') return 'off';
    const number = Number(text);
    return text && Number.isFinite(number) ? number : value;
  }
  if (definition.type === 'boolean' && typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'an', 'ja', 'on', '1'].includes(text)) return true;
    if (['false', 'aus', 'nein', 'off', '0'].includes(text)) return false;
  }
  if ((definition.type === 'text' || definition.type === 'choice' || definition.type === 'url') && typeof value !== 'string') return String(value);
  return value;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function registerSettingsTools(server: McpServer, call: CockpitCall): void {
  server.registerTool(
    'find_settings',
    {
      title: 'Einstellungen nachsehen',
      description:
        'Alles, was sich im Cockpit einstellen lässt – mit Erklärung, aktuellem Wert und erlaubten Werten: allgemeine Einstellungen (Lead-Suche, Senden über LinkedIn, Arbeitszeiten, Tagesstapel, Follow-ups, KI, Firmendaten, Sicherungen …), die automatische Suche je Gründer und die Tagesgrenzen je LinkedIn-Account. Immer zuerst aufrufen, wenn der Nutzer etwas anders haben möchte.',
      annotations: READ,
    },
    async () => {
      const settings = await call<SettingsResponse>('GET', '/api/settings');
      if (!settings.ok) return fail(settings.message);
      const states = new Map(settings.body.settings.map((state) => [state.key, state] as const));
      const lines = ['# Einstellungen im Cockpit', 'Ändern mit change_setting (key, value). value null = zurück auf Standard.'];
      if (settings.body.safeMode) lines.push('Achtung: Notfallmodus – Werte lassen sich gerade nur zurücksetzen.');
      for (const group of Object.keys(SETTING_GROUP_LABELS) as Array<keyof typeof SETTING_GROUP_LABELS>) {
        const definitions = SETTINGS.filter((definition) => definition.group === group);
        if (!definitions.length) continue;
        lines.push('', `## ${SETTING_GROUP_LABELS[group]}`);
        for (const definition of definitions) lines.push(settingLine(definition, states.get(definition.key)));
      }

      lines.push('', '## Automatische Suche (Einstellungen → Automatische Suche)', 'Ändern mit change_auto_search (founder + nur die Felder, die sich ändern sollen).');
      const auto = await call<AutoSearchListResponse>('GET', '/api/auto-search');
      if (auto.ok) for (const schedule of auto.body.schedules) lines.push(...scheduleLines(schedule));
      else lines.push(`Nicht lesbar: ${auto.message}`);

      lines.push('', '## Tagesgrenzen je LinkedIn-Account (Einstellungen → Senden über LinkedIn)', 'Ändern mit change_account_limits (account_id + Grenzen, null = Standard).');
      const accounts = await call<LinkedInAccountsResponse>('GET', '/api/linkedin/accounts');
      if (!accounts.ok) lines.push(`Nicht lesbar: ${accounts.message}`);
      else if (!accounts.body.accounts.length) lines.push('Keine LinkedIn-Accounts verbunden.');
      else {
        for (const account of accounts.body.accounts) {
          const who = account.assignedTo ? `Gründer-Account ${defaultFounderName(account.assignedTo)}` : account.warmup ? 'wird aufgewärmt' : 'Such-Account';
          const defaults = account.limitDefaults;
          lines.push(
            `- **${account.name}** (account_id ${account.id}) · ${who} · Profile/Tag (profiles_per_day): ${limitText(account.limits?.profilesPerDay, defaults?.profilesPerDay)} · Suchtreffer/Tag (search_results_per_day): ${limitText(account.limits?.searchResultsPerDay, defaults?.searchResultsPerDay)} · Anfragen/Tag (invites_per_day): ${limitText(account.limits?.invitesPerDay, defaults?.invitesPerDay)}`,
          );
        }
      }

      lines.push(
        '',
        '## Nur in der Oberfläche',
        '- Vorlagen (Anfragen und Nachrichten): Einstellungen → Vorlagen (lesen mit list_templates)',
        '- Such-Reihenfolge der LinkedIn-Accounts, Accounts zuordnen: Einstellungen → Senden über LinkedIn',
        '- Konten und Mitarbeiter, Passwort: Konto-Menü oben rechts',
        '- Sicherung jetzt erstellen, Software-Update starten: Einstellungen → Sicherungen bzw. Software-Update',
        '- Wer hat was geändert: Einstellungen → Verlauf',
      );
      return ok(lines.join('\n'));
    },
  );

  server.registerTool(
    'change_setting',
    {
      title: 'Einstellung ändern',
      description:
        'Eine allgemeine Einstellung ändern (key aus find_settings). Wird geprüft wie in der Oberfläche und im Verlauf vermerkt. Zugangsschlüssel und Werte mit Passwort-Rückfrage gehen nur in der Oberfläche.',
      inputSchema: {
        key: z.enum(SETTING_KEYS).describe('Schlüssel aus find_settings, z. B. NEW_LEADS_PER_DAY'),
        value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).describe('Neuer Wert; null = zurück auf Standard'),
        confirmed: z.boolean().optional().describe('true, nachdem der Nutzer eine Rückfrage dieser Einstellung bestätigt hat'),
      },
      annotations: WRITE,
    },
    async ({ key, value, confirmed }) => {
      const definition = settingDefinition(key as SettingKey);
      const block = chatBlock(definition);
      if (block) return fail(`„${definition.label}“ lässt sich hier nicht ändern (${block}). Im Cockpit: Einstellungen → ${SETTING_GROUP_LABELS[definition.group]}.`);
      const next = coerce(definition, value);
      const question = next === null ? undefined : definition.confirm?.[String(next)];
      if (question && !confirmed) return ok(`Rückfrage vor dem Speichern – frag den Nutzer und ruf dann mit confirmed: true erneut auf:\n${question}`);

      const before = await call<SettingsResponse>('GET', '/api/settings');
      if (!before.ok) return fail(before.message);
      const old = before.body.settings.find((state) => state.key === key);
      const saved = await call<SettingsResponse>('PUT', '/api/settings', { changes: { [key]: next }, version: before.body.version });
      if (!saved.ok) return fail(saved.message);
      const now = saved.body.settings.find((state) => state.key === key);
      return ok(`Gespeichert: „${definition.label}“ von ${showValue(definition, old?.value)} auf ${showValue(definition, now?.value)}${now?.source === 'default' ? ' (Standard)' : ''}. Steht im Verlauf der Einstellungen.`);
    },
  );

  const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit als HH:MM');
  server.registerTool(
    'change_auto_search',
    {
      title: 'Automatische Suche ändern',
      description: 'Zeitplan und Suchprofil der automatischen Lead-Suche eines Gründers ändern. Nur die Felder angeben, die sich ändern sollen – der Rest bleibt.',
      inputSchema: {
        founder: z.enum(AUTH_FOUNDER_IDS),
        enabled: z.boolean().optional(),
        days: z.array(z.number().int().min(1).max(7)).max(7).optional().describe('1 = Montag … 7 = Sonntag'),
        time: time.optional(),
        second_time: time.nullable().optional().describe('zweiter Termin am Tag, null = aus'),
        keywords: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        positions: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        region: z.string().trim().max(200).optional(),
        max_results: z.number().int().min(1).optional().describe('Profile pro Lauf'),
        daily_target: z.number().int().min(1).nullable().optional().describe('qualifizierte Leads pro Tag, null = aus'),
        max_rounds: z.number().int().min(1).optional(),
        daily_budget_eur: z.number().min(0).nullable().optional().describe('null = ohne Budget'),
        kapitalanlage_percent: z.number().int().min(0).max(100).optional().describe('Anteil Kapitalanlage in 10er-Schritten, Rest Finanzdienstleister'),
      },
      annotations: WRITE,
    },
    async (input) => {
      const list = await call<AutoSearchListResponse>('GET', '/api/auto-search');
      if (!list.ok) return fail(list.message);
      const current = list.body.schedules.find((schedule) => schedule.founder === input.founder);
      if (!current) return fail(`Die automatische Suche von ${defaultFounderName(input.founder)} darfst du nicht ändern.`);
      const update: AutoSearchUpdate = {
        enabled: input.enabled ?? current.enabled,
        days: (input.days as Weekday[] | undefined) ?? current.days,
        time: input.time ?? current.time,
        secondTime: input.second_time !== undefined ? input.second_time : (current.secondTime ?? null),
        profile: {
          keywords: input.keywords ?? current.profile.keywords,
          positions: input.positions ?? current.profile.positions,
          region: input.region ?? current.profile.region,
          maxResults: input.max_results ?? current.profile.maxResults,
        },
        ...(input.daily_target !== undefined ? { dailyTarget: input.daily_target } : {}),
        ...(input.max_rounds !== undefined ? { maxRounds: input.max_rounds } : {}),
        ...(input.daily_budget_eur !== undefined ? { dailyBudgetEur: input.daily_budget_eur } : {}),
        ...(input.kapitalanlage_percent !== undefined ? { kapitalanlagePercent: input.kapitalanlage_percent } : {}),
      };
      const saved = await call<AutoSearchSchedule>('PUT', `/api/auto-search/${input.founder}`, update);
      if (!saved.ok) return fail(saved.message);
      return ok(['Gespeichert. Automatische Suche jetzt:', ...scheduleLines(saved.body)].join('\n'));
    },
  );

  const limit = z.number().int().min(0).nullable().optional();
  server.registerTool(
    'change_account_limits',
    {
      title: 'Grenzen eines LinkedIn-Accounts ändern',
      description: 'Eigene Tagesgrenzen eines LinkedIn-Accounts (account_id aus find_settings). null = Standard. Nie höher als die festen Unipile-Grenzen.',
      inputSchema: {
        account_id: z.string().trim().min(1).max(200),
        profiles_per_day: limit,
        search_results_per_day: limit,
        invites_per_day: limit,
      },
      annotations: WRITE,
    },
    async ({ account_id, profiles_per_day, search_results_per_day, invites_per_day }) => {
      const patch: Partial<LinkedInAccountLimits> = {
        ...(profiles_per_day !== undefined ? { profilesPerDay: profiles_per_day } : {}),
        ...(search_results_per_day !== undefined ? { searchResultsPerDay: search_results_per_day } : {}),
        ...(invites_per_day !== undefined ? { invitesPerDay: invites_per_day } : {}),
      };
      if (!Object.keys(patch).length) return fail('Nichts zu ändern angegeben.');
      const saved = await call<LinkedInAccountLimits>('PUT', `/api/linkedin/accounts/${encodeURIComponent(account_id)}/limits`, patch);
      if (!saved.ok) return fail(saved.message);
      const show = (value: number | null) => (value === null ? 'Standard' : String(value));
      return ok(`Gespeichert: Profile/Tag ${show(saved.body.profilesPerDay)} · Suchtreffer/Tag ${show(saved.body.searchResultsPerDay)} · Anfragen/Tag ${show(saved.body.invitesPerDay)}.`);
    },
  );
}

/** Für Tests: Schlüssel, die im Chat änderbar sind. */
export const MCP_CHANGEABLE_SETTING_KEYS: readonly SettingKey[] = CHAT_KEYS;
