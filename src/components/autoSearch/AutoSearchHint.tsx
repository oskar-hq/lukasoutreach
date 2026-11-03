import { useEffect, useState } from 'react';
import type { AuthFounderId } from '../../../shared/auth';
import { autoSearchApi } from '../../lib/leadSearchApi';
import { formatNextRun } from './format';

/**
 * Startseite, aufgeklappter Bereich: nächster automatischer Lauf des angezeigten Gründers – nur wenn sein Plan an ist.
 * Ein Aufruf beim Aufklappen; Fehler (ältere Backends ohne Route, keine Rechte) bleiben still.
 */
export function AutoSearchHint({ founder }: { founder: AuthFounderId }) {
  const [nextRunAt, setNextRunAt] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setNextRunAt(null);
    autoSearchApi
      .list({ signal: controller.signal })
      .then((response) => {
        const schedule = response.schedules.find((entry) => entry.founder === founder);
        setNextRunAt(schedule?.enabled && schedule.nextRunAt ? schedule.nextRunAt : null);
      })
      .catch(() => {
        // Nur ein Hinweis – ohne ihn fehlt nichts.
      });
    return () => controller.abort();
  }, [founder]);

  if (!nextRunAt) return null;
  return (
    <p data-testid="home-auto-search">
      Automatische Suche: nächster Lauf {formatNextRun(nextRunAt, { short: true })}
    </p>
  );
}
