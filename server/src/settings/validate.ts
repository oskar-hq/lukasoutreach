import {
  settingDefinition,
  type SettingDefinition,
  type SettingKey,
  type SettingValue,
} from '../../../shared/settings.js';
import { parseWorkDays, validTimeZone } from '../config.js';

/**
 * Prüfung eines einzelnen Werts nach dem Katalog `shared/settings.ts` (Typ, Grenzen, Muster, Adressen).
 * Meldungen sind fertige deutsche Sätze für die Oberfläche. Querregeln zwischen mehreren Werten prüft der Dienst.
 */

export type Checked = { ok: true; value: SettingValue } | { ok: false; message: string };

const MAX_TEXT = 500;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const bad = (message: string): Checked => ({ ok: false, message });

/** Nur die Adresse: kein Pfad, keine Query, kein Fragment, keine Zugangsdaten; https (http nur lokal). */
export function normalizeOrigin(input: string, { allowBareHost = false, allowHttp = false } = {}): { ok: true; value: string } | { ok: false; message: string } {
  const text = input.trim();
  if (!text) return { ok: false, message: 'Bitte eine Adresse angeben.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : allowBareHost ? `https://${text}` : text;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: 'Das ist keine gültige Adresse (z. B. https://beispiel.de).' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (LOCAL_HOSTS.has(url.hostname) || allowHttp))) {
    return { ok: false, message: 'Die Adresse muss mit https:// beginnen.' };
  }
  if (url.username || url.password) return { ok: false, message: 'Die Adresse darf keine Zugangsdaten enthalten.' };
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, message: 'Bitte nur die Adresse ohne Pfad, Parameter und Anker angeben.' };
  }
  return { ok: true, value: url.origin };
}

export function validateValue(definition: SettingDefinition, value: unknown): Checked {
  const { key, type } = definition;
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : bad('Bitte „an“ oder „aus“ wählen.');
    case 'integer':
    case 'number': {
      if (definition.allowOff && typeof value === 'string' && value.trim().toLowerCase() === 'off') return { ok: true, value: 'off' };
      if (typeof value !== 'number' || !Number.isFinite(value)) return bad('Bitte eine Zahl angeben.');
      if (type === 'integer' && !Number.isInteger(value)) return bad('Bitte eine ganze Zahl angeben.');
      if (definition.min !== undefined && value < definition.min) return bad(`Mindestens ${definition.min}.`);
      if (definition.max !== undefined && value > definition.max) return bad(`Höchstens ${definition.max}.`);
      return { ok: true, value };
    }
    case 'choice': {
      const allowed = definition.options?.map((option) => option.value) ?? [];
      return typeof value === 'string' && allowed.includes(value) ? { ok: true, value } : bad('Bitte einen der angebotenen Werte wählen.');
    }
    case 'text':
    case 'secret':
    case 'url': {
      if (typeof value !== 'string') return bad('Bitte einen Text angeben.');
      // '' = ausdrücklich „nicht gesetzt“ (überdeckt die .env).
      if (value === '') return { ok: true, value: '' };
      const text = value.trim();
      if (text.length > MAX_TEXT) return bad(`Höchstens ${MAX_TEXT} Zeichen.`);
      if (/[\r\n\0]/.test(text)) return bad('Keine Zeilenumbrüche erlaubt.');
      if (definition.minLength && text.length < definition.minLength) return bad(`Mindestens ${definition.minLength} Zeichen.`);
      if (definition.pattern && !new RegExp(definition.pattern).test(text)) return bad('Das Format stimmt nicht.');
      if (type === 'url') {
        const origin = normalizeOrigin(text, { allowBareHost: key === 'UNIPILE_DSN', allowHttp: key === 'PUBLIC_URL' });
        if (!origin.ok) return origin;
        if (key === 'UNIPILE_DSN' && !new URL(origin.value).hostname.endsWith('.unipile.com')) {
          return bad('Die Adresse muss auf .unipile.com enden (z. B. https://api68.unipile.com:19881).');
        }
        return { ok: true, value: origin.value };
      }
      if (key === 'CLAY_WEBHOOK_URL' && !/^https:\/\//i.test(text)) return bad('Die Adresse muss mit https:// beginnen.');
      if (key === 'SLACK_WEBHOOK_URL' && !/^https:\/\/hooks\.slack\.com\//.test(text)) return bad('Die Adresse muss mit https://hooks.slack.com/ beginnen.');
      const linkedin = linkedinProblem(key, text);
      if (linkedin) return bad(linkedin);
      return { ok: true, value: text };
    }
  }
}

/** Wert → Text für die Umgebung (`loadConfig` liest Texte). */
export function toEnv(value: SettingValue): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
}

export function definitionOf(key: string): SettingDefinition | null {
  try {
    return settingDefinition(key as SettingKey);
  } catch {
    return null;
  }
}

/** Pause unter 3 s schützt den Account nicht mehr (Schutzgrenze aus CLAUDE.md: 3–8 s). */
export const LINKEDIN_PAUSE_MIN_SECONDS = 3;
export const LINKEDIN_PAUSE_MAX_SECONDS = 600;

/**
 * Querregeln innerhalb eines LinkedIn-Werts (Vertrag `shared/settings.ts`): Pause „von-bis“ mit von ≥ 3, bis ≥ von,
 * bis ≤ 600; Arbeitszeit von < bis; Arbeitstage aufsteigend; Zeitzone gültig. Das Muster hat `validateValue` schon
 * geprüft. null = in Ordnung, sonst der Satz für die Oberfläche.
 */
function linkedinProblem(key: SettingKey, text: string): string | null {
  switch (key) {
    case 'LINKEDIN_PAUSE_SECONDS': {
      const [from, to] = text.split('-').map(Number);
      if (from < LINKEDIN_PAUSE_MIN_SECONDS) return `Mindestens ${LINKEDIN_PAUSE_MIN_SECONDS} Sekunden Pause – kürzere Pausen fallen LinkedIn auf.`;
      if (to < from) return 'Die zweite Zahl darf nicht kleiner als die erste sein (z. B. „3-8“).';
      if (to > LINKEDIN_PAUSE_MAX_SECONDS) return `Höchstens ${LINKEDIN_PAUSE_MAX_SECONDS} Sekunden.`;
      return null;
    }
    case 'LINKEDIN_WORK_HOURS': {
      const [from, to] = text.split('-').map(Number);
      return from < to ? null : 'Das Ende der Arbeitszeit muss nach dem Anfang liegen (z. B. „8-19“).';
    }
    case 'LINKEDIN_WORK_DAYS':
      return parseWorkDays(text) ? null : 'Bitte Tage von 1 (Montag) bis 7 (Sonntag) aufsteigend angeben, z. B. „1-5“ oder „1-5,7“.';
    case 'LINKEDIN_TIMEZONE':
      return validTimeZone(text) ? null : 'Diese Zeitzone gibt es nicht. Bitte z. B. „Europe/Berlin“ angeben.';
    default:
      return null;
  }
}
