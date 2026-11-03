import type { AuthFounderId } from '../../../shared/auth.js';
import type { MetaAdsCheck } from '../../../shared/leadSearch.js';
import type { LeadAssessment, LeadCompany, LeadEventKind, LeadPerson, LeadStage } from '../../../shared/leads.js';

/** Ein Demo-Lead für die Simulation (erzeugt von `scripts/buildDemoSeed.ts`). */
export interface DemoSeedLead {
  /** ID aus der bisherigen Demo, z. B. „n01“. */
  key: string;
  owner: AuthFounderId;
  stage: LeadStage;
  person: LeadPerson;
  company: LeadCompany;
  assessment: LeadAssessment;
  template: string | null;
  /** Nur einzelne Demo-Leads (z. B. Reactivation mit beendeten Anzeigen); sonst ungeprüft. */
  metaAds?: MetaAdsCheck | null;
  followUpsSent: number;
  nextStep: string | null;
  events: {
    kind: LeadEventKind;
    /** Millisekunden relativ zum Anlegen (negativ = in der Vergangenheit). */
    offsetMs: number;
    by: AuthFounderId | null;
    title: string;
    text: string | null;
    label: string | null;
  }[];
}
