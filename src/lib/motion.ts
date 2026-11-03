/**
 * Gemeinsame Kurven und Federn (DESIGN.md §8). Neue Animationen nehmen diese Werte statt eigener Literale.
 * Federn sind kritisch gedämpft (`bounce: 0`); Nachschwingen nur nach einer Geste mit Schwung (`SPRING_BACK`).
 */

/** Auftritte und Standard – entspricht `--ease-out` in `src/index.css`. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
/** Schubladen und Seiten – entspricht `--ease-apple`. */
export const EASE_APPLE = [0.32, 0.72, 0, 1] as const;

/** Dialoge, Tabs, Panels. */
export const SPRING = { type: 'spring', bounce: 0, duration: 0.35 } as const;
/** Menüs und Popover. */
export const SPRING_MENU = { type: 'spring', bounce: 0, duration: 0.3 } as const;
/** Seitenwechsel im Fokus-Modus. */
export const SPRING_PAGE = { type: 'spring', bounce: 0, duration: 0.5 } as const;
/** Zurückfedern nach einer Geste, die nicht ausgelöst hat – leichtes Nachschwingen, weil die Geste Schwung hatte. */
export const SPRING_BACK = { type: 'spring', bounce: 0.25, duration: 0.5 } as const;
