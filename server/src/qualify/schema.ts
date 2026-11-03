import { z } from 'zod';
import { LEAD_CATEGORIES, isQualifyingCategory, type Qualification } from '../../../shared/leadSearch.js';
import { hiringFromAi } from './hiring.js';

/**
 * Form, die das LLM liefern soll (structured output). Bewusst ohne Wertebereiche –
 * die prüft `parseQualification` danach selbst, damit die Validierung nicht vom Modell abhängt.
 */
export const QualificationOutputSchema = z.object({
  category: z.enum(LEAD_CATEGORIES),
  qualified: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
  summary: z.string(),
  /** Hiring-Signal (13.10.): gesuchte Stelle, wenn die Daten ausdrücklich sagen, dass die Firma Mitarbeiter sucht. */
  hiringRole: z.string().nullable(),
});

export type QualificationOutput = z.infer<typeof QualificationOutputSchema>;

/** Strenge Validierung der Rohausgabe (Wertebereiche, Längen). */
const ValidatedSchema = z.object({
  category: z.enum(LEAD_CATEGORIES),
  qualified: z.boolean(),
  confidence: z
    .number()
    // Häufiger Ausrutscher: 85 statt 0.85 – eindeutig umrechenbar, alles andere ist ungültig.
    .transform((value) => (value > 1 && value <= 100 ? value / 100 : value))
    .pipe(z.number().min(0).max(1)),
  reason: z.string().trim().min(3).max(400),
  summary: z.string().trim().min(3).max(700),
  // Fehlt bei älteren Ausgaben bzw. Testservern – dann kein Signal.
  hiringRole: z.string().max(400).nullish(),
});

export class QualificationValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`KI-Ausgabe ungültig: ${issues.join('; ')}`);
    this.name = 'QualificationValidationError';
  }
}

/**
 * Prüft die KI-Ausgabe und wendet die strenge Regel an: qualifiziert ist ein Lead nur, wenn
 * (1) die Kategorie qualifizierend ist (`QUALIFYING_CATEGORIES`: Kapitalanlage-Vertrieb, Finanzdienstleister, Bauträger mit Vertrieb),
 * (2) das Modell selbst „qualified“ sagt und (3) die Sicherheit mindestens `minConfidence` beträgt.
 */
export function parseQualification(raw: unknown, minConfidence: number): Qualification {
  const result = ValidatedSchema.safeParse(raw);
  if (!result.success) {
    throw new QualificationValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'Ausgabe'}: ${issue.message}`),
    );
  }
  const { category, qualified, confidence, reason, summary, hiringRole } = result.data;
  const hiring = hiringFromAi(hiringRole);
  return {
    category,
    qualified: qualified && isQualifyingCategory(category) && confidence >= minConfidence,
    confidence: Math.round(confidence * 100) / 100,
    reason,
    summary,
    ...(hiring ? { hiring } : {}),
  };
}
