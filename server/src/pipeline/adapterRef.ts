import type { LeadSearchAdapter } from './adapter.js';

/**
 * Austauschbarer Adapter: Die Einstellungen (Modus, Zugänge) wirken ohne Neustart, indem der Adapter neu gebaut und
 * hier eingesetzt wird. Der Runner holt sich mit `current()` zu Beginn eines Laufs den aktuellen Adapter und arbeitet
 * damit zu Ende – ein laufender Lauf behält seine alten Werte.
 */
export class AdapterRef implements LeadSearchAdapter {
  constructor(private target: LeadSearchAdapter) {}

  set(target: LeadSearchAdapter): void {
    this.target = target;
  }

  current(): LeadSearchAdapter {
    return this.target;
  }

  get mode() {
    return this.target.mode;
  }
  get canQualify() {
    return this.target.canQualify;
  }
  get canCheckAds() {
    return this.target.canCheckAds;
  }
  search: LeadSearchAdapter['search'] = (...args) => this.target.search(...args);
  pendingInvitations: LeadSearchAdapter['pendingInvitations'] = (...args) => this.target.pendingInvitations(...args);
  pauseBeforeProfile: LeadSearchAdapter['pauseBeforeProfile'] = (...args) => this.target.pauseBeforeProfile(...args);
  enrich: LeadSearchAdapter['enrich'] = (...args) => this.target.enrich(...args);
  qualify: LeadSearchAdapter['qualify'] = (...args) => this.target.qualify(...args);
  checkMetaAds: LeadSearchAdapter['checkMetaAds'] = (...args) => this.target.checkMetaAds(...args);
  dedupeDelay: LeadSearchAdapter['dedupeDelay'] = (...args) => this.target.dedupeDelay(...args);
  founderNetworks: NonNullable<LeadSearchAdapter['founderNetworks']> = async (...args) =>
    this.target.founderNetworks ? this.target.founderNetworks(...args) : { networks: [], warnings: [] };
  setupWarnings = (): string[] => this.target.setupWarnings?.() ?? [];
  profileCapacity: NonNullable<LeadSearchAdapter['profileCapacity']> = async (...args) =>
    this.target.profileCapacity ? this.target.profileCapacity(...args) : Infinity;
}
