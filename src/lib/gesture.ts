import { useSyncExternalStore } from 'react';

/**
 * Wohin trägt der Schwung ein Element? Apples Projektion aus „Designing Fluid Interfaces“ (WWDC 2018):
 * exponentielles Abbremsen wie beim Scrollen. `velocity` in px/s, Ergebnis in px.
 */
export function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * Wegwischen zum Schließen (Bottom-Sheet nach unten, Seitenpanel nach rechts): Entschieden wird über die
 * hochgerechnete Endposition, nicht über die Stelle beim Loslassen – ein kurzer, schneller Wisch reicht.
 * `offset` und `velocity` in Schließrichtung positiv.
 */
export function shouldDismiss(offset: number, velocity: number, size: number) {
  if (offset < 24 || velocity < -150) return false; // kaum bewegt oder schon wieder zurück
  return offset + project(velocity) > Math.min(size * 0.5, 220);
}

export { SPRING_BACK } from './motion';

/** Nur Elemente, auf denen Ziehen etwas anderes bedeutet (Klick, Eingabe, Auswahl), starten keine Geste. */
export const NO_GESTURE = 'button, a, input, textarea, select, [role="tab"], [role="button"], [role="menu"], [data-no-swipe]';

/** Reagiert live auf eine Media-Query (z. B. Handy-Breite → Bottom-Sheet). */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
