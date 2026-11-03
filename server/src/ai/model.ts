/**
 * `output_config.effort: 'low'` nur für Modelle, die Effort kennen: Haiku 4.5 und älter nicht. Haiku 5.5 kennt ihn
 * (Standard dort „medium“) – bis 12.10. bekam es keinen Wert und dachte damit mehr (und teurer) als nötig.
 */
export function lowEffort(model: string): { effort?: 'low' } {
  return /claude-(3|haiku-4|haiku-3)/.test(model) ? {} : { effort: 'low' };
}
