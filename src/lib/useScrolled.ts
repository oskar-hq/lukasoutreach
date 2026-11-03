import { useEffect, useState } from 'react';

/** true, sobald Inhalt unter eine schwebende Leiste scrollt – Trennlinie nur dann zeigen. */
export function useScrolled(threshold = 4) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > threshold);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [threshold]);
  return scrolled;
}
