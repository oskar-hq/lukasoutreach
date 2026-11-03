import type { FastifyBaseLogger } from 'fastify';
import { AUTH_FOUNDER_IDS, type AuthFounderId } from '../../shared/auth.js';
import { UnipileClient } from './adapters/live/unipileClient.js';
import { loadConfigWithSettings } from './settings/effective.js';
import { openDatabase } from './db/database.js';
import { LeadStore } from './leads/leadStore.js';
import { LinkedInError, LinkedInService } from './linkedin/service.js';

/**
 * Echte LinkedIn-Aktionen auf dem Server prüfen (Roadmap Phase 3: erst ein Test, dann das Cockpit):
 *   docker compose exec backend node dist/server/src/linkedinCli.js konten
 *   docker compose exec backend node dist/server/src/linkedinCli.js status
 *   docker compose exec backend node dist/server/src/linkedinCli.js test-anfrage nick https://www.linkedin.com/in/kollege
 *   docker compose exec backend node dist/server/src/linkedinCli.js test-anfrage nick https://www.linkedin.com/in/kollege --ja
 *   docker compose exec backend node dist/server/src/linkedinCli.js abgleich
 *   docker compose exec backend node dist/server/src/linkedinCli.js fortsetzen nick
 * Lokal: npm run linkedin --prefix server -- status
 *
 * `konten` und `status` lesen nur. `test-anfrage` ohne `--ja` zeigt nur, an wen die Anfrage ginge.
 */

const USAGE = `LinkedIn-Aktionen

  konten                                   bei Unipile verbundene Accounts mit ID (für UNIPILE_ACCOUNT_NICK/_JOHANNES)
  status                                   Modus, Limits, Pausen je Gründer
  test-anfrage <gründer> <profil> [--notiz "Text"] [--ja]
                                           genau EINE Vernetzungsanfrage an ein Profil (URL oder Kennung);
                                           ohne --ja nur anzeigen, an wen sie ginge
  abgleich                                 angenommene Anfragen und Antworten jetzt holen
  fortsetzen <gründer>                     Pause nach einem Limit- oder Zugangsfehler aufheben
`;

function fail(message: string): never {
  console.error(`Fehler: ${message}`);
  process.exit(1);
}

const log = {
  info: () => undefined,
  warn: (data: unknown, message?: string) => console.error(message ?? '', JSON.stringify(data)),
  error: (data: unknown, message?: string) => console.error(message ?? '', JSON.stringify(data)),
} as unknown as FastifyBaseLogger;

function founderArg(value: string | undefined): AuthFounderId {
  if (!value || !(AUTH_FOUNDER_IDS as readonly string[]).includes(value)) fail(`Gründer angeben: ${AUTH_FOUNDER_IDS.join(' | ')}`);
  return value as AuthFounderId;
}

/** „https://www.linkedin.com/in/max-muster/“ → „max-muster“; eine Kennung bleibt, wie sie ist. */
export function profileIdentifier(value: string): string {
  const match = value.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return decodeURIComponent(match ? match[1] : value).trim();
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'hilfe' || command === '--help') {
    console.log(USAGE);
    return;
  }
  const config = loadConfigWithSettings();
  const db = openDatabase(config.dataDir);
  const service = new LinkedInService({ config, db, leads: new LeadStore(db), log });

  switch (command) {
    case 'konten': {
      const { dsn, apiKey } = config.unipile;
      if (!dsn || !apiKey) fail('UNIPILE_DSN und UNIPILE_API_KEY fehlen in der .env.');
      const { items } = await new UnipileClient({ dsn, apiKey }).listAccounts(AbortSignal.timeout(30_000));
      const linkedin = items.filter((account) => (account.type ?? '').toUpperCase() === 'LINKEDIN');
      if (!linkedin.length) console.log('Kein LinkedIn-Account bei Unipile verbunden.');
      for (const account of linkedin) {
        const used = AUTH_FOUNDER_IDS.filter((founder) => config.linkedin.accounts[founder] === account.id);
        console.log(`${account.id}  ${account.name ?? ''}${used.length ? `  ← ${used.join(', ')}` : ''}`);
      }
      break;
    }
    case 'status': {
      const status = service.status();
      console.log(`Modus: ${status.mode}${status.mode === 'off' ? ' (LINKEDIN_ACTIONS=on setzen, Unipile eintragen)' : ''}`);
      const { fromHour, toHour, days, timeZone } = status.workHours;
      console.log(`Arbeitszeit: ${fromHour}–${toHour} Uhr, Tage ${days.join(',')} (${timeZone}) · jetzt ${status.withinWorkHours ? 'innerhalb' : 'außerhalb'}`);
      for (const account of status.accounts) {
        console.log(
          `${account.founder}: ${account.connected ? 'Account eingetragen' : 'kein Account'} · Anfragen heute ${account.invitesToday.used}/${account.invitesToday.limit}, ` +
            `7 Tage ${account.invitesWeek.used}/${account.invitesWeek.limit} · Nachrichten heute ${account.messagesToday.used}/${account.messagesToday.limit}` +
            (account.pausedUntil ? ` · PAUSIERT bis ${new Date(account.pausedUntil).toLocaleString('de-DE')}: ${account.pauseReason}` : ''),
        );
      }
      break;
    }
    case 'test-anfrage': {
      const founder = founderArg(args[0]);
      const profile = args[1];
      if (!profile || profile.startsWith('--')) fail('Profil angeben (LinkedIn-URL oder Kennung).');
      const noteIndex = args.indexOf('--notiz');
      const note = noteIndex >= 0 ? args[noteIndex + 1] : undefined;
      if (note !== undefined && note.length > 300) fail('Die Notiz darf höchstens 300 Zeichen haben.');
      const identifier = profileIdentifier(profile);
      if (!args.includes('--ja')) {
        const { dsn, apiKey } = config.unipile;
        const accountId = config.linkedin.accounts[founder];
        if (!dsn || !apiKey || !accountId) fail(`UNIPILE_DSN, UNIPILE_API_KEY und UNIPILE_ACCOUNT_${founder.toUpperCase()} müssen gesetzt sein.`);
        // Nur lesen (notify=false): zeigen, an wen die Anfrage ginge.
        const found = await new UnipileClient({ dsn, apiKey }).getProfile({ accountId, identifier }, AbortSignal.timeout(30_000));
        console.log(`Die Anfrage ginge von ${founder} an: ${[found.first_name, found.last_name].filter(Boolean).join(' ')} (${found.headline ?? ''})`);
        console.log('Noch nichts gesendet. Zum Senden denselben Befehl mit --ja am Ende ausführen.');
        break;
      }
      const result = await service.testInvite(founder, identifier, note);
      console.log(`Gesendet: Vernetzungsanfrage von ${founder} an ${result.name} (invitation_id ${result.invitationId ?? '–'}).`);
      break;
    }
    case 'abgleich': {
      const result = await service.sync();
      console.log(`Angenommen: ${result.accepted.length} · neue Antworten: ${result.replied.length}`);
      for (const problem of result.problems) console.log(`Hinweis: ${problem}`);
      break;
    }
    case 'fortsetzen': {
      const founder = founderArg(args[0]);
      console.log(service.guard.clearPause(founder) ? `Pause für ${founder} aufgehoben.` : `${founder} war nicht pausiert.`);
      break;
    }
    default:
      console.log(USAGE);
      fail(`Unbekannter Befehl „${command}“.`);
  }
  db.close();
}

main().catch((error: unknown) => {
  if (error instanceof LinkedInError) fail(error.message);
  fail(error instanceof Error ? error.message : String(error));
});
