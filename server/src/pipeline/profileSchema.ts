import { z } from 'zod';
import { AUTO_SEARCH_PROFILE_LIMITS as LIMITS } from '../../../shared/autoSearch.js';
import { MAX_RESULTS_LIMIT } from '../../../shared/leadSearch.js';

/**
 * Grenzen eines Suchprofils (`SearchProfile`) – gemeinsam für den Start von Hand (`POST /api/lead-search/runs`) und
 * die automatische Suche (`PUT /api/auto-search/:founder`), damit beide dasselbe zulassen. Zahlen aus dem Vertrag
 * (`AUTO_SEARCH_PROFILE_LIMITS`), damit Oberfläche und Backend gleich prüfen.
 */

const terms = z.array(z.string().trim().min(1).max(LIMITS.termLength)).max(LIMITS.terms);

export const SearchProfileSchema = z.object({
  keywords: terms.min(1, 'Mindestens ein Stichwort angeben.'),
  positions: terms.min(1, 'Mindestens eine Position angeben.'),
  region: z.string().trim().min(LIMITS.regionMin).max(LIMITS.regionMax),
  // Limit auch hier: höchstens `MAX_RESULTS_LIMIT` Profile pro Lauf.
  maxResults: z.number().int().min(1).max(MAX_RESULTS_LIMIT),
});
