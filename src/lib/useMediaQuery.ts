import { useSyncExternalStore } from 'react';

/** Folgt einer CSS-Media-Query (z. B. Handy-Breite) und rendert bei jedem Wechsel neu. */
export function useMediaQuery(query: string): boolean {
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

/** Handy-Breite (unter Tailwinds `sm`, 640 px): Tab-Leiste unten statt Navigation oben – wie eine iOS-App. */
export const PHONE_QUERY = '(max-width: 639.98px)';

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
