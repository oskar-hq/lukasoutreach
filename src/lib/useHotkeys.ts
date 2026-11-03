import { useEffect, useRef } from 'react';

export type HotkeyMap = Partial<Record<string, () => void>>;

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

// Wie kam der Fokus aufs aktuelle Element? (:focus-visible taugt nicht – Chrome setzt es bei jedem Tastendruck.)
let lastInput: 'keyboard' | 'pointer' = 'pointer';
let focusedByKeyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (lastInput = 'keyboard'), true);
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), true);
  window.addEventListener('focusin', () => (focusedByKeyboard = lastInput === 'keyboard'), true);
}

/**
 * Per Tastatur fokussierter Knopf, Link, Tab oder Menüeintrag: ↵ und Leertaste gehören dort dem Element selbst.
 * Nach einem Mausklick bleibt ↵ die Haupt-Aktion der Seite.
 */
export function isActivatableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (!focusedByKeyboard) return false;
  return !!target.closest('button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]');
}

/**
 * Globale Tastaturkürzel. Schlüssel: event.key in Kleinbuchstaben (z. B. 'arrowright', 'e', '1').
 * Wird ignoriert, solange in ein Textfeld getippt wird oder Modifier gedrückt sind.
 */
export function useHotkeys(map: HotkeyMap, enabled = true) {
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if ((event.key === 'Enter' || event.key === ' ') && isActivatableTarget(event.target)) return;
      // Offene Dialoge/Panels haben Vorrang.
      if (document.querySelector('[aria-modal="true"]')) return;
      const handler = mapRef.current[event.key.toLowerCase()];
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
