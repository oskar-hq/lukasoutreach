import { createInterface } from 'node:readline';
import { ACCOUNT_NAME_MAX_LENGTH, AUTH_FOUNDER_IDS, AUTH_ROLE_LABELS, type AuthFounderId, type AuthRole } from '../../shared/auth.js';
import { AccountStore, USERNAME_RULE, isFounderId, normalizeUsername, validUsername } from './auth/accounts.js';
import { InviteStore, inviteLink } from './auth/invites.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLengthOk } from './auth/password.js';
import { SessionStore } from './auth/sessions.js';
import type { Config } from './config.js';
import { loadConfigWithSettings } from './settings/effective.js';
import { openDatabase } from './db/database.js';

/**
 * Konten verwalten – auf dem Server im Backend-Container:
 *   docker compose exec backend node dist/server/src/accountsCli.js list
 *   docker compose exec backend node dist/server/src/accountsCli.js add nick nick "Nick"
 *   docker compose exec backend node dist/server/src/accountsCli.js add oskar admin "Oskar"
 *   docker compose exec backend node dist/server/src/accountsCli.js add anna nick "Anna" --mitarbeiter
 *   docker compose exec backend node dist/server/src/accountsCli.js password nick
 *   docker compose exec backend node dist/server/src/accountsCli.js remove nick
 *   docker compose exec backend node dist/server/src/accountsCli.js invite nick nick "Nick"
 *   docker compose exec backend node dist/server/src/accountsCli.js invite anna nick "Anna" --mitarbeiter
 *   docker compose exec backend node dist/server/src/accountsCli.js invite nick --reset
 *   docker compose exec backend node dist/server/src/accountsCli.js uninvite nick
 * Lokal: npm run accounts --prefix server -- list
 *
 * Das Passwort wird verdeckt abgefragt (zweimal). Ohne Terminal (z. B. per Pipe) wird eine Zeile von stdin gelesen.
 * Passwort ändern oder Konto entfernen beendet alle Sitzungen des Kontos und macht offene Einladungslinks ungültig.
 * `invite` schreibt nur den Link nach stdout (eine Zeile), alle Hinweise nach stderr – so lässt er sich weiterreichen.
 */

const USAGE = `Konten verwalten

  list                                      alle Konten mit Rolle anzeigen
  add <anmeldename> <zuordnung> [anzeigename] [--mitarbeiter]
                                            Konto anlegen oder ersetzen
  password <anmeldename>                    Passwort ändern
  remove <anmeldename>                      Konto entfernen
  invite <anmeldename> <zuordnung> [anzeigename] [--mitarbeiter]
                                            Einladungslink: Konto selbst einrichten (gilt 7 Tage, einmal)
  invite <anmeldename> --reset              Link für ein bestehendes Konto: neues Passwort setzen (gilt 24 h)
  uninvite <anmeldename>                    offene Einladungslinks widerrufen

  zuordnung:  ${AUTH_FOUNDER_IDS.join(' | ')}  → Gründer-Konto (mit --mitarbeiter: Mitarbeiter dieses Gründers)
              admin           → Admin-Konto ohne eigenen Tagesstapel (darf alles außer über LinkedIn senden)
  Beispiele:  add oskar admin "Oskar"   ·   invite anna nick "Anna" --mitarbeiter
`;

/** Rolle und Gründer aus „<zuordnung> [--mitarbeiter]“. */
function roleOf(raw: string | undefined, assistant: boolean): { role: AuthRole; founder: AuthFounderId | null } {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'admin') {
    if (assistant) fail('--mitarbeiter geht nur zusammen mit einem Gründer (nick oder johannes), nicht mit admin.');
    return { role: 'admin', founder: null };
  }
  if (!isFounderId(value)) fail(`Zuordnung muss ${AUTH_FOUNDER_IDS.join(', ')} oder admin sein.`);
  return { role: assistant ? 'assistant' : 'founder', founder: value };
}

/** „Mitarbeiter (nick)“, „Gründer (nick)“, „Admin“ */
function roleText(role: AuthRole, founder: AuthFounderId | null): string {
  return founder ? `${AUTH_ROLE_LABELS[role]} (${founder})` : AUTH_ROLE_LABELS[role];
}

function fail(message: string): never {
  console.error(`Fehler: ${message}`);
  process.exit(1);
}

/** Liest eine Zeile; im Terminal ohne Echo. */
function ask(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input });
      // Erst auflösen, dann schließen – close() feuert „close“ sofort und würde sonst '' liefern.
      rl.once('line', (line) => {
        resolve(line);
        rl.close();
      });
      rl.once('close', () => resolve(''));
    });
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

async function askPassword(): Promise<string> {
  const password = await ask('Neues Passwort: ');
  if (!passwordLengthOk(password)) fail(`Das Passwort braucht ${PASSWORD_MIN_LENGTH} bis ${PASSWORD_MAX_LENGTH} Zeichen.`);
  if (process.stdin.isTTY && (await ask('Passwort wiederholen: ')) !== password) fail('Die Passwörter stimmen nicht überein.');
  return password;
}

/** Öffentliche Adresse für den Link (Vertrag: PUBLIC_URL, mit Secure-Cookie nur https). */
function publicUrl(config: Config): string {
  const url = config.auth.publicUrl;
  if (url) {
    if (config.auth.cookieSecure && !url.startsWith('https://')) {
      fail(`PUBLIC_URL muss mit https:// beginnen (ist: „${url}“). Ohne HTTPS zusätzlich AUTH_COOKIE_SECURE=false setzen.`);
    }
    return url;
  }
  if (!config.auth.cookieSecure) return 'http://localhost:5173';
  fail('PUBLIC_URL fehlt in der .env, z. B. PUBLIC_URL=https://lukas.ylvalabs.de – sonst weiß der Link nicht, wohin er zeigt.');
}

/** Anzeigename: angegeben (auf die erlaubte Länge geprüft) oder aus dem Anmeldenamen. */
function displayName(raw: string | undefined, username: string): string {
  const name = (raw ?? '').trim() || username.charAt(0).toUpperCase() + username.slice(1);
  if (name.length > ACCOUNT_NAME_MAX_LENGTH) fail(`Der Anzeigename darf höchstens ${ACCOUNT_NAME_MAX_LENGTH} Zeichen haben.`);
  return name;
}

async function main() {
  const [command, ...allArgs] = process.argv.slice(2);
  const assistant = allArgs.includes('--mitarbeiter');
  const args = allArgs.filter((arg) => arg !== '--mitarbeiter');
  const config = loadConfigWithSettings();
  const db = openDatabase(config.dataDir);
  const accounts = new AccountStore(db);
  const sessions = new SessionStore(db);
  const invites = new InviteStore(db);

  try {
    switch (command) {
      case 'list': {
        const users = accounts.list();
        if (!users.length) console.log('Noch keine Konten angelegt.');
        for (const user of users) console.log(`${user.username.padEnd(20)} ${roleText(user.role, user.founder).padEnd(22)} ${user.name}`);
        // Selbst registriert, wartet auf Freigabe (Cockpit → Konten).
        for (const waiting of accounts.listRegistrations()) console.log(`${waiting.username.padEnd(20)} ${'wartet auf Freigabe'.padEnd(22)} ${waiting.name}`);
        break;
      }
      case 'add': {
        const username = normalizeUsername(args[0] ?? '');
        if (!validUsername(username)) fail(USERNAME_RULE);
        const { role, founder } = roleOf(args[1], assistant);
        const name = displayName(args[2], username);
        const existed = accounts.exists(username);
        await accounts.save({ username, name, founder, role }, await askPassword());
        invites.revoke(username);
        const ended = existed ? sessions.deleteForUser(username) : 0;
        console.log(`${existed ? `Konto „${username}“ ersetzt, ${ended} Sitzung(en) beendet` : `Konto „${username}“ angelegt`} – ${roleText(role, founder)}.`);
        break;
      }
      case 'password': {
        const username = normalizeUsername(args[0] ?? '');
        const account = accounts.findStored(username);
        if (!account) fail(`Konto „${username}“ gibt es nicht.`);
        await accounts.save(account, await askPassword());
        invites.revoke(username);
        console.log(`Passwort geändert, ${sessions.deleteForUser(username)} Sitzung(en) beendet.`);
        break;
      }
      case 'remove': {
        const username = normalizeUsername(args[0] ?? '');
        if (!accounts.remove(username)) fail(`Konto „${username}“ gibt es nicht.`);
        // Auch abgelaufene Links erledigen – sonst stünde der Name unter „Konten“ wieder als eingeladen.
        invites.discard(username);
        console.log(`Konto „${username}“ entfernt, ${sessions.deleteForUser(username)} Sitzung(en) beendet.`);
        break;
      }
      case 'invite': {
        const reset = args.includes('--reset');
        const [rawName, rawFounder, rawDisplay] = args.filter((arg) => arg !== '--reset');
        const username = normalizeUsername(rawName ?? '');
        if (!validUsername(username)) fail(USERNAME_RULE);
        const url = publicUrl(config);
        const existing = accounts.findStored(username);
        let invite: { username: string; name: string; role: AuthRole; founder: AuthFounderId | null; reset: boolean };
        if (existing) {
          if (!reset) {
            fail(`Konto „${username}“ gibt es schon. Ein Link würde sein Passwort ersetzen – dafür „invite ${username} --reset“ verwenden.`);
          }
          invite = { username, name: existing.name, role: existing.role, founder: existing.founder, reset: true };
          console.error(`Achtung: Dieser Link ersetzt das Passwort von „${username}“. Er gilt 24 Stunden und nur einmal.`);
        } else {
          if (reset) fail(`Konto „${username}“ gibt es nicht – für ein neues Konto ohne --reset, mit Zuordnung (${AUTH_FOUNDER_IDS.join(', ')} oder admin).`);
          if (!rawFounder) fail(`Für ein neues Konto die Zuordnung angeben: ${AUTH_FOUNDER_IDS.join(', ')} oder admin.`);
          const { role, founder } = roleOf(rawFounder, assistant);
          const name = displayName(rawDisplay, username);
          invite = { username, name, role, founder, reset: false };
          console.error(`Einladung für „${username}“ (${name}, ${roleText(role, founder)}). Gilt 7 Tage und nur einmal.`);
        }
        const { token } = invites.create(invite);
        console.error('Link sicher weitergeben (z. B. direkt per Signal), nicht öffentlich posten:');
        console.log(inviteLink(url, token));
        break;
      }
      case 'uninvite': {
        const username = normalizeUsername(args[0] ?? '');
        const count = invites.revoke(username);
        invites.discard(username); // abgelaufene ebenfalls, damit der Name nicht mehr als eingeladen erscheint
        console.log(count ? `${count} offene(r) Link(s) für „${username}“ widerrufen.` : `Kein offener Link für „${username}“.`);
        break;
      }
      default:
        console.log(USAGE);
        if (command && command !== 'help') process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

await main();
