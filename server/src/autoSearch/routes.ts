import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AUTH_FOUNDER_IDS, authRole, type AuthFounderId } from '../../../shared/auth.js';
import {
  AUTO_SEARCH_TIME_ZONE,
  autoSearchProblem,
  type AutoSearchField,
  type AutoSearchListResponse,
  type AutoSearchUpdate,
  type Weekday,
} from '../../../shared/autoSearch.js';
import type { ApiErrorBody } from '../../../shared/leadSearch.js';
import { autoSearchDenial } from '../auth/roles.js';
import { SearchProfileSchema } from '../pipeline/profileSchema.js';
import { RunBusyError } from '../pipeline/runner.js';
import type { AutoSearchPlanner } from './planner.js';

/**
 * Routen `/api/auto-search*` laut Vertrag `shared/autoSearch.ts`. Mitarbeiter sperrt zentral `roleDenial`
 * (`auth/roles.ts`); fremde Gründer prüft `autoSearchDenial` hier.
 */

/** Sätze, wenn schon die Form der Anfrage nicht stimmt (vor `autoSearchProblem`). */
const SHAPE_MESSAGES: Record<AutoSearchField, string> = {
  enabled: 'Bitte angeben, ob die automatische Suche an oder aus ist.',
  days: 'Wochentage nur von Montag bis Sonntag.',
  time: 'Bitte eine Uhrzeit wie 07:00 angeben.',
  secondTime: 'Bitte eine Uhrzeit wie 14:00 angeben (oder keine).',
  'profile.keywords': 'Bitte die Stichwörter als Liste angeben.',
  'profile.positions': 'Bitte die Positionen als Liste angeben.',
  'profile.region': 'Bitte eine Region angeben.',
  'profile.maxResults': 'Bitte angeben, wie viele Profile pro Lauf abgerufen werden.',
  dailyTarget: 'Bitte angeben, wie viele qualifizierte Leads pro Tag gesucht werden (oder keins).',
  maxRounds: 'Bitte angeben, wie viele Suchläufe pro Tag höchstens laufen.',
  dailyBudgetEur: 'Bitte ein Tagesbudget in Euro angeben (oder keins).',
  kapitalanlagePercent: 'Bitte den Anteil Kapitalanlage in Prozent angeben (0 bis 100).',
};

const PROFILE_FIELDS = ['keywords', 'positions', 'region', 'maxResults'] as const;

/** Nur die Form (Typen) – Inhalte prüft danach `autoSearchProblem` aus dem Vertrag mit feldgenauen Sätzen. */
const UpdateShape = z.object({
  enabled: z.boolean(),
  days: z.array(z.number()).max(14),
  time: z.string().max(10),
  secondTime: z.string().max(10).nullable().optional(),
  profile: z.object({
    keywords: z.array(z.string()).max(100),
    positions: z.array(z.string()).max(100),
    region: z.string().max(200),
    maxResults: z.number(),
  }),
  dailyTarget: z.number().nullable().optional(),
  maxRounds: z.number().optional(),
  dailyBudgetEur: z.number().nullable().optional(),
  kapitalanlagePercent: z.number().optional(),
});

/** Feld zu einem zod-Fehlerpfad (`['profile', 'region']` → `profile.region`). */
function fieldOf(path: readonly PropertyKey[]): AutoSearchField {
  const [first, second] = path;
  if (first === 'enabled' || first === 'days' || first === 'time' || first === 'secondTime' || first === 'dailyTarget' || first === 'maxRounds' || first === 'dailyBudgetEur' || first === 'kapitalanlagePercent') return first;
  const sub = PROFILE_FIELDS.find((key) => key === second);
  return sub ? `profile.${sub}` : 'profile.keywords';
}

const terms = (list: string[]) => [...new Set(list.map((word) => word.trim()).filter(Boolean))];

function sendError(reply: FastifyReply, status: number, code: string, message: string, extra: { field?: string; runId?: string } = {}) {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return reply.status(status).send(body);
}

const FounderParams = z.object({ founder: z.enum(AUTH_FOUNDER_IDS) });

export function registerAutoSearchRoutes(app: FastifyInstance, { planner }: { planner: AutoSearchPlanner }) {
  const founderOf = (params: unknown): AuthFounderId | null => {
    const parsed = FounderParams.safeParse(params);
    return parsed.success ? parsed.data.founder : null;
  };

  app.get('/api/auto-search', async (request): Promise<AutoSearchListResponse> => {
    const user = request.authUser;
    // Gründer sehen nur den eigenen Plan, Admins (und ohne Anmeldung) beide.
    const founders = user && authRole(user) === 'founder' && user.founder ? [user.founder] : [...AUTH_FOUNDER_IDS];
    return { schedules: founders.map((founder) => planner.schedule(founder)), timeZone: AUTO_SEARCH_TIME_ZONE };
  });

  app.put('/api/auto-search/:founder', async (request, reply) => {
    const founder = founderOf(request.params);
    if (!founder) return sendError(reply, 404, 'not_found', 'Diesen Gründer gibt es nicht.');
    const denial = autoSearchDenial(request.authUser, founder);
    if (denial) return sendError(reply, 403, 'not_allowed', denial);

    const parsed = UpdateShape.safeParse(request.body);
    if (!parsed.success) {
      const field = fieldOf(parsed.error.issues[0]?.path ?? []);
      return sendError(reply, 400, 'invalid_request', SHAPE_MESSAGES[field], { field });
    }
    const { enabled, days, time, secondTime, profile, dailyTarget, maxRounds, dailyBudgetEur, kapitalanlagePercent } = parsed.data;
    const update: AutoSearchUpdate = {
      // Leerer Text = zweiter Termin aus.
      ...(secondTime !== undefined ? { secondTime: secondTime?.trim() ? secondTime.trim() : null } : {}),
      ...(dailyTarget !== undefined ? { dailyTarget } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(dailyBudgetEur !== undefined ? { dailyBudgetEur } : {}),
      ...(kapitalanlagePercent !== undefined ? { kapitalanlagePercent } : {}),
      enabled,
      days: [...new Set(days)].sort((a, b) => a - b) as Weekday[],
      time,
      profile: { keywords: terms(profile.keywords), positions: terms(profile.positions), region: profile.region.trim(), maxResults: profile.maxResults },
    };
    const problem = autoSearchProblem(update);
    if (problem) return sendError(reply, 400, 'invalid_request', problem.message, { field: problem.field });
    // Dieselben Grenzen wie beim Start von Hand (gemeinsames Schema) – zur Sicherheit, falls Vertrag und Schema
    // einmal auseinanderlaufen.
    const profileCheck = SearchProfileSchema.safeParse(update.profile);
    if (!profileCheck.success) {
      const field = fieldOf(['profile', ...(profileCheck.error.issues[0]?.path ?? [])]);
      return sendError(reply, 400, 'invalid_request', profileCheck.error.issues[0]?.message ?? SHAPE_MESSAGES[field], { field });
    }

    const saved = planner.save(founder, { ...update, profile: profileCheck.data }, request.authUser?.name ?? null);
    request.log.info(
      { founder, enabled: update.enabled, days: update.days, time: update.time, secondTime: saved.secondTime ?? null, dailyTarget: saved.dailyTarget, maxRounds: saved.maxRounds, dailyBudgetEur: saved.dailyBudgetEur, kapitalanlagePercent: saved.kapitalanlagePercent },
      'Automatische Lead-Suche geändert',
    );
    return saved;
  });

  app.post('/api/auto-search/:founder/run', async (request, reply) => {
    const founder = founderOf(request.params);
    if (!founder) return sendError(reply, 404, 'not_found', 'Diesen Gründer gibt es nicht.');
    const denial = autoSearchDenial(request.authUser, founder);
    if (denial) return sendError(reply, 403, 'not_allowed', denial);
    try {
      const result = planner.runNow(founder);
      if ('problem' in result) return sendError(reply, 400, 'config', result.problem);
      return reply.status(202).send({ runId: result.runId });
    } catch (error) {
      if (error instanceof RunBusyError) return sendError(reply, 409, 'busy', error.message, { runId: error.runId });
      throw error;
    }
  });
}
