import type { MotionValue } from 'motion/react';
import { useEffect, useRef, type RefObject } from 'react';

/** Ab so vielen Pixeln nach unten gilt die Bewegung als Wischen (darunter: Tippen). */
const SLOP = 6;
/** Nach oben folgt das Sheet nur zäh (Gummiband), wie beim Griff. */
const RUBBER = 0.06;

/** Elemente, auf denen Ziehen etwas anderes bedeutet – dort startet kein Wischen. */
const NO_SWIPE = 'input[type="range"], textarea, [data-no-swipe]';

/** Nächster scrollbarer Vorfahr innerhalb des Sheets (oder null). */
function scrollerOf(target: Element | null, root: HTMLElement): HTMLElement | null {
  for (let el = target as HTMLElement | null; el && el !== root; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/**
 * Bottom-Sheet mit dem Finger wegwischen – auf dem ganzen Sheet, wie bei iOS. Über Touch-Events statt Pointer-Events:
 * Nur so lässt sich das native Scrollen per `preventDefault` abfangen, ohne dass der Browser die Geste mit
 * `pointercancel` an sich zieht. Regeln:
 *   - Nach unten und der Inhalt unter dem Finger ist ganz oben (oder scrollt gar nicht) → das Sheet folgt dem Finger.
 *   - Nach oben, seitlich oder Inhalt nicht oben → normales Scrollen, kein Wischen.
 *   - Beim Loslassen entscheidet `onRelease(offset, velocity px/s, height)` (schließen oder zurückfedern).
 */
export function useSheetSwipe(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  y: MotionValue<number>,
  onRelease: (offset: number, velocity: number, height: number) => void,
) {
  const release = useRef(onRelease);
  release.current = onRelease;

  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    let state: 'idle' | 'pending' | 'drag' = 'idle';
    let startX = 0;
    let startY = 0;
    let scroller: HTMLElement | null = null;
    // Letzte Punkte für die Geschwindigkeit beim Loslassen.
    let samples: { y: number; t: number }[] = [];

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        state = 'idle';
        return;
      }
      const target = event.target as Element | null;
      if (target?.closest(NO_SWIPE)) return;
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      scroller = scrollerOf(target, root);
      samples = [{ y: touch.clientY, t: event.timeStamp }];
      state = 'pending';
    };

    const onMove = (event: TouchEvent) => {
      if (state === 'idle') return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (state === 'pending') {
        const atTop = !scroller || scroller.scrollTop <= 0;
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !atTop) {
          // Kein Wischen nach unten → dem Browser überlassen (Scrollen), erst beim nächsten Finger neu prüfen.
          if (Math.abs(dy) >= SLOP || Math.abs(dx) >= SLOP) state = 'idle';
          return;
        }
        // Nach unten am oberen Rand: schon jetzt abfangen, sonst übernimmt der Browser die Geste.
        event.preventDefault();
        if (dy < SLOP) return;
        state = 'drag';
        startY = touch.clientY;
      }
      event.preventDefault();
      const offset = touch.clientY - startY;
      y.set(offset > 0 ? offset : offset * RUBBER);
      samples.push({ y: touch.clientY, t: event.timeStamp });
      if (samples.length > 5) samples.shift();
    };

    const onEnd = (event: TouchEvent) => {
      if (state !== 'drag') {
        state = 'idle';
        return;
      }
      state = 'idle';
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      const velocity = dt > 0 ? ((last.y - first.y) / dt) * 1000 : 0;
      // Zu lange stillgehalten → kein Schwung mehr.
      const still = event.timeStamp - last.t > 100;
      release.current(y.get(), still ? 0 : velocity, root.getBoundingClientRect().height);
    };

    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onEnd);
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
  }, [ref, enabled, y]);
}
