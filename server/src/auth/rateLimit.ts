/**
 * Begrenzung der Fehlversuche beim Login (Vertrag `shared/auth.ts`):
 * - je Client-IP 10 Fehlversuche in 15 Minuten;
 * - je Anmeldename 50 Fehlversuche pro Stunde (hoch, damit ein Fremder die Gründer nicht einfach aussperrt);
 * - während einer Sperre wird das Passwort gar nicht geprüft;
 * - ein erfolgreicher Login setzt den Zähler des Namens zurück;
 * - jeder Versuch wird vor dem (langsamen) Passwortvergleich gezählt (`reserve`) und erst bei richtigem Passwort
 *   zurückgenommen (`release`) – sonst kämen beliebig viele gleichzeitige Anfragen an der Sperre vorbei.
 * Feste Zeitfenster ab dem ersten Fehlversuch, Zähler nur im Speicher.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface LimitRule {
  max: number;
  windowMs: number;
}

export const IP_RULE: LimitRule = { max: 10, windowMs: 15 * 60 * 1000 };
export const NAME_RULE: LimitRule = { max: 50, windowMs: 60 * 60 * 1000 };
/** Registrierungen je IP (Vertrag „Registrierung und Einarbeitung“): 5 pro Stunde. */
export const REGISTER_RULE: LimitRule = { max: 5, windowMs: 60 * 60 * 1000 };

export class Counter {
  private windows = new Map<string, Window>();

  constructor(private readonly rule: LimitRule) {}

  /** Restsperre in Millisekunden, 0 = nicht gesperrt. */
  blockedFor(key: string, now: number): number {
    const window = this.current(key, now);
    return window && window.count >= this.rule.max ? window.resetAt - now : 0;
  }

  hit(key: string, now: number): void {
    const window = this.current(key, now);
    if (window) window.count += 1;
    else this.windows.set(key, { count: 1, resetAt: now + this.rule.windowMs });
    if (this.windows.size > 10_000) this.prune(now);
  }

  /** Einen gezählten Versuch zurücknehmen (z. B. vorab gezählt, dann richtiges Passwort). */
  unhit(key: string, now = Date.now()): void {
    const window = this.current(key, now);
    if (window && window.count > 0) window.count -= 1;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private current(key: string, now: number): Window | null {
    const window = this.windows.get(key);
    if (!window) return null;
    if (window.resetAt <= now) {
      this.windows.delete(key);
      return null;
    }
    return window;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

export class LoginLimiter {
  private readonly byIp: Counter;
  private readonly byName: Counter;

  constructor(ipRule: LimitRule = IP_RULE, nameRule: LimitRule = NAME_RULE) {
    this.byIp = new Counter(ipRule);
    this.byName = new Counter(nameRule);
  }

  /** Sekunden bis zum Ende der Sperre (für `Retry-After`), 0 = Anmeldung erlaubt. */
  retryAfter(ip: string, username: string, now = Date.now()): number {
    const ms = Math.max(this.byIp.blockedFor(ip, now), this.byName.blockedFor(username, now));
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  failure(ip: string, username: string, now = Date.now()): void {
    this.byIp.hit(ip, now);
    this.byName.hit(username, now);
  }

  success(username: string): void {
    this.byName.reset(username);
  }

  /**
   * Versuch prüfen und sofort als Fehlversuch zählen – aufrufen **vor** dem `await` auf den Passwortvergleich, damit
   * gleichzeitige Anfragen die Sperre nicht umgehen. 0 = zugelassen, sonst Sekunden bis zum Ende der Sperre.
   * Bei richtigem Passwort danach `release` aufrufen.
   */
  reserve(ip: string, username: string, now = Date.now()): number {
    const retryAfter = this.retryAfter(ip, username, now);
    if (retryAfter > 0) return retryAfter;
    this.failure(ip, username, now);
    return 0;
  }

  /** Richtiges Passwort nach `reserve`: Vorab-Zählung der IP zurücknehmen, Namenszähler zurücksetzen. */
  release(ip: string, username: string, now = Date.now()): void {
    this.byIp.unhit(ip, now);
    this.success(username);
  }
}

/**
 * Begrenzung für Einladungslinks (Vertrag `shared/auth.ts`): eigener Zähler je IP, getrennt vom Login und ohne
 * Namenszähler. Ungültige Links (404) bei `check` und `accept` zählen – 10 in 15 Minuten → 429.
 */
export class InviteLimiter {
  private readonly byIp: Counter;

  constructor(rule: LimitRule = IP_RULE) {
    this.byIp = new Counter(rule);
  }

  retryAfter(ip: string, now = Date.now()): number {
    const ms = this.byIp.blockedFor(ip, now);
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }

  failure(ip: string, now = Date.now()): void {
    this.byIp.hit(ip, now);
  }
}
