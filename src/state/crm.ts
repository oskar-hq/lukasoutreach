import { useEffect, useState } from 'react';
import type { CrmMode } from '../../shared/crm';
import { crmApi } from '../lib/leadSearchApi';

interface CrmState {
  mode: CrmMode | null;
  /** Übergabe an Close überhaupt anbieten (`CRM_HANDOVER`) – fehlt das Feld (älteres Backend), wie bisher an. */
  handover: boolean;
}

/** Letzter bekannter Stand – damit die Karte beim nächsten Öffnen nicht erst „lädt“. */
let last: CrmState = { mode: null, handover: true };

/**
 * Stand der Close-Übergabe (`GET /api/crm/status`): `mode` `mock`/`live` = das Backend legt den Lead in Close an,
 * `off` = kein Schlüssel, die Übergabe wird nur eingetragen, null solange unbekannt. `handover` false = Übergabe ganz
 * ausgeblendet (Einstellung „An Close übergeben“ aus, 22.10.). Wird bei jedem Einsatz neu geholt (eine Änderung unter
 * Einstellungen gilt sofort).
 */
export function useCrm(): CrmState {
  const [state, setState] = useState<CrmState>(last);
  useEffect(() => {
    let alive = true;
    crmApi
      .status()
      .then((status) => {
        last = { mode: status.mode, handover: status.handover !== false };
        if (alive) setState(last);
      })
      // Älteres Backend ohne Close: wie bisher nur eintragen.
      .catch((error: { status?: number }) => {
        if (error.status === 404) {
          last = { mode: 'off', handover: true };
          if (alive) setState(last);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
