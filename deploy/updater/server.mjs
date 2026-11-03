// Update-Dienst des Cockpits (Vertrag shared/system.ts → „Updates“). Ohne Abhängigkeiten, nur Node 22.
//
// Läuft als eigener Container mit Zugriff auf Docker (Socket) und das Projekt-Verzeichnis. Erreichbar nur im
// internen Docker-Netz `updater` (nur das Backend hängt daran), keine veröffentlichten Ports, jede Anfrage braucht den
// gemeinsamen Schlüssel aus `/shared/updater.token` (beim ersten Start erzeugt, Backend liest ihn read-only).
//
//   GET  /status[?fetch=0]  → aktueller und neuester Stand (fetch=1 Standard: vorher `git fetch`)
//   POST /update {by}       → 202 und im Hintergrund: git merge --ff-only, docker compose up -d --build (ohne den
//                             Update-Dienst selbst), danach aufräumen (docker image/builder prune) · 409
//                             update_running | up_to_date
//
// Sicherheit: nur feste Befehle über execFile mit Argument-Listen – nie eine Shell, nie Eingaben aus der Anfrage in
// Befehlen (`by` landet nur im Protokoll). Ausgaben von git/docker werden von Zugangsdaten in Adressen befreit.

import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PORT = 8790;
export const CHANGES_MAX = 30;
/** Diese Dienste baut und startet ein Update neu – der Update-Dienst selbst nie (er würde sich mitten im Lauf beenden). */
export const SERVICES = ['outreach-cockpit', 'backend'];
/** Aufräumen nach einem erfolgreichen Update: verwaiste Abbilder und Bau-Cache älter als 7 Tage (168 h). */
export const PRUNE_COMMANDS = [
  ['image', 'prune', '-f'],
  ['builder', 'prune', '-f', '--filter', 'until=168h'],
];
const SEP = '\x1f';
const LOG_FORMAT = `--format=%H${SEP}%ct${SEP}%s`;

/** Zugangsdaten aus Adressen entfernen (https://user:token@host → https://host), Länge begrenzen. */
export function sanitize(text, max = 400) {
  const clean = String(text ?? '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
    .replace(/(token|password|passwort)=\S+/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

/** Konstanter Vergleich über Hashes (gleiche Länge, keine Laufzeit-Hinweise). */
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Echter Befehlsaufruf: execFile ohne Shell; wirft nie, liefert Exit-Code und Ausgaben. */
export function execRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: options.timeout ?? 60_000, ...options, shell: false },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && code !== 0 ? error.message : '') });
      },
    );
  });
}

/** git lehnt den Zugang ab (fehlende oder falsche Zugangsdaten im Dienst). */
const AUTH_FAILURE = /(Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|Repository not found|returned error: 40[13])/i;
export const GIT_AUTH_MESSAGE =
  'GitHub hat den Zugang abgelehnt: Der Update-Dienst findet die git-Zugangsdaten des Servers nicht. docker compose ohne sudo starten (Benutzer in der Docker-Gruppe) oder UPDATER_GIT_HOME in der .env setzen und den Dienst einmal neu starten (README → Updates).';

export class UpdaterError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Schlüssel lesen oder beim ersten Start erzeugen (nur für den Backend-Benutzer `node`, uid 1000, lesbar). */
export function ensureToken(file, owner = { uid: 1000, gid: 1000 }) {
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const token = randomBytes(32).toString('hex');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o400 });
  try {
    chownSync(tmp, owner.uid, owner.gid);
  } catch {
    // ohne Root (Tests) bleibt der eigene Benutzer
  }
  chmodSync(tmp, 0o400);
  renameSync(tmp, file);
  return token;
}

/**
 * Die Logik des Dienstes – `run` ist austauschbar, damit Tests ohne git und Docker auskommen.
 * @param {object} o
 * @param {(cmd: string, args: string[], opts?: object) => Promise<{code: number, stdout: string, stderr: string}>} o.run
 * @param {string} o.repoDir  Projekt-Verzeichnis im Container (gleicher Pfad wie auf dem Server)
 * @param {string} o.stateFile  Protokoll des letzten Laufs (im gemeinsamen Volume, übersteht Neustarts)
 * @param {string} o.selfId  Eigene Container-ID (`$HOSTNAME`)
 * @param {{uid?: number, gid?: number, home?: string}} [o.gitUser]  git als Besitzer des Repos ausführen
 * @param {() => number} [o.now]
 * @param {(msg: string) => void} [o.log]
 */
export function createUpdater({ run, repoDir, stateFile, selfId, gitUser = {}, now = Date.now, log = () => {}, baseEnv = process.env }) {
  let state = { lastRun: null, checkedAt: null, pendingBuild: false };
  try {
    if (existsSync(stateFile)) state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
  } catch {
    // unlesbares Protokoll: neu anfangen
  }
  // Beim letzten Mal mitten im Lauf beendet (Server-Neustart): als fehlgeschlagen vermerken.
  if (state.lastRun && state.lastRun.finishedAt === null) {
    state.lastRun = { ...state.lastRun, finishedAt: now(), ok: false, message: 'Das Update wurde unterbrochen (Neustart des Servers). Bitte noch einmal starten.' };
    state.pendingBuild = true;
  }
  let running = false;
  let project = null;

  const save = () => {
    try {
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, stateFile);
    } catch (error) {
      log(`Protokoll nicht gespeichert: ${sanitize(error?.message)}`);
    }
  };

  const pathEnv = baseEnv.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const gitEnv = {
    PATH: pathEnv,
    HOME: gitUser.home ?? baseEnv.HOME ?? '/root',
    // nie auf eine Eingabe warten (kein Terminal)
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    LANG: 'C',
  };

  async function git(args, timeout = 120_000) {
    const options = { cwd: repoDir, env: gitEnv, timeout };
    if (typeof gitUser.uid === 'number' && gitUser.uid !== 0) Object.assign(options, { uid: gitUser.uid, gid: gitUser.gid ?? gitUser.uid });
    return run('git', args, options);
  }

  async function gitOk(args, what, timeout) {
    const result = await git(args, timeout);
    if (result.code !== 0) {
      const output = result.stderr || result.stdout;
      if (AUTH_FAILURE.test(output)) throw new UpdaterError(502, 'git_auth', GIT_AUTH_MESSAGE);
      throw new UpdaterError(502, 'git_failed', `${what} ging nicht: ${sanitize(output)}`);
    }
    return result.stdout.trim();
  }

  // git-Befehle, die Refs schreiben (fetch, merge), nie gleichzeitig – sonst scheitert einer an der Ref-Sperre.
  let gitQueue = Promise.resolve();
  function serial(work) {
    const next = gitQueue.then(work, work);
    gitQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  // Zuletzt berechneter Stand (für GET /status?fetch=0 ohne git-Aufrufe); null = neu berechnen.
  let cached = null;

  const version = (line) => {
    const [hash, time, ...subject] = line.split(SEP);
    return { commit: hash.slice(0, 7), title: subject.join(SEP), date: Number(time) * 1000 };
  };

  async function versions() {
    await gitOk(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 'Den Branch auf GitHub finden');
    const current = version(await gitOk(['log', '-1', LOG_FORMAT, 'HEAD'], 'Den aktuellen Stand lesen'));
    const latest = version(await gitOk(['log', '-1', LOG_FORMAT, '@{u}'], 'Den neuesten Stand lesen'));
    const behind = Number(await gitOk(['rev-list', '--count', 'HEAD..@{u}'], 'Neue Versionen zählen')) || 0;
    const log = behind > 0 ? await gitOk(['log', `-n${CHANGES_MAX}`, LOG_FORMAT, 'HEAD..@{u}'], 'Die Änderungen lesen') : '';
    const changes = log ? log.split('\n').filter(Boolean).map(version) : [];
    return { current, latest, behind, changes };
  }

  async function fetchUpstream() {
    await serial(() => gitOk(['fetch', '--quiet'], 'Bei GitHub nachsehen', 180_000));
    state.checkedAt = now();
    cached = null;
    save();
  }

  async function status({ fetch = true } = {}) {
    if (fetch && !running) await fetchUpstream();
    if (!cached || fetch) cached = await versions();
    return { ...cached, checkedAt: state.checkedAt, running, lastRun: state.lastRun, pendingBuild: state.pendingBuild === true };
  }

  /** Projektname, Verzeichnis, Compose-Dateien, Abbild und Home des Servers aus den eigenen Container-Labels. */
  async function discover() {
    if (project) return project;
    const result = await run('docker', ['inspect', selfId], { timeout: 30_000 });
    if (result.code !== 0) throw new UpdaterError(502, 'docker_failed', `Docker ist nicht erreichbar: ${sanitize(result.stderr)}`);
    const info = JSON.parse(result.stdout)[0] ?? {};
    const labels = info.Config?.Labels ?? {};
    const name = labels['com.docker.compose.project'];
    const dir = labels['com.docker.compose.project.working_dir'];
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name) || !dir || !path.isAbsolute(dir)) {
      throw new UpdaterError(502, 'not_compose', 'Der Update-Dienst wurde nicht mit docker compose gestartet.');
    }
    if (path.resolve(dir) !== path.resolve(repoDir)) {
      throw new UpdaterError(502, 'wrong_dir', `Das Projekt liegt unter ${dir}, eingebunden ist aber ${repoDir} – docker compose bitte aus dem Projektordner starten.`);
    }
    const files = String(labels['com.docker.compose.project.config_files'] ?? '')
      .split(',')
      .map((file) => file.trim())
      .filter((file) => path.isAbsolute(file));
    const hostHome = (info.Mounts ?? []).find((mount) => mount.Destination === '/hosthome')?.Source ?? null;
    project = { name, dir, files, image: info.Config?.Image ?? null, hostHome };
    return project;
  }

  function composeArgs(p, publicProfile) {
    return ['compose', '-p', p.name, '--project-directory', p.dir, ...p.files.flatMap((file) => ['-f', file]), ...(publicProfile ? ['--profile', 'public'] : [])];
  }

  function composeEnv(p, extra = {}) {
    // Compose setzt ${PWD} und ${HOME} der docker-compose.yml aus dieser Umgebung ein – also die Pfade des Servers.
    return { PATH: pathEnv, PWD: p.dir, HOME: p.hostHome ?? baseEnv.HOME ?? '/root', ...extra };
  }

  /** ID des laufenden Containers eines Dienstes ('' = keiner). */
  async function containerId(p, service) {
    const result = await run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${p.name}`, '--filter', `label=com.docker.compose.service=${service}`], { timeout: 30_000 });
    return result.code === 0 ? result.stdout.trim() : '';
  }

  /** Läuft Caddy (Profil „public“)? Dann wird es mit gebaut und neu gestartet. */
  async function publicProfileActive(p) {
    return (await containerId(p, 'caddy')).length > 0;
  }

  const finish = (ok, message) => {
    state.lastRun = { ...state.lastRun, finishedAt: now(), ok, message };
    save();
    running = false;
    log(`Update ${ok ? 'fertig' : 'fehlgeschlagen'}: ${message}`);
  };

  async function perform() {
    try {
      const before = (await gitOk(['rev-parse', 'HEAD'], 'Den aktuellen Stand lesen')).trim();
      await serial(() => gitOk(['merge', '--ff-only', '--quiet', '@{u}'], 'Die neue Version holen (git pull --ff-only)'));
      cached = null;
      const after = (await gitOk(['rev-parse', 'HEAD'], 'Den neuen Stand lesen')).trim();
      const head = version(await gitOk(['log', '-1', LOG_FORMAT, 'HEAD'], 'Den neuen Stand lesen'));
      state.pendingBuild = true;
      save();
      const p = await discover();
      const publicProfile = await publicProfileActive(p);
      const services = [...SERVICES, ...(publicProfile ? ['caddy'] : [])];
      const frontendBefore = await containerId(p, 'outreach-cockpit');
      const env = composeEnv(p, { APP_COMMIT: after, APP_COMMIT_TITLE: head.title, APP_COMMIT_DATE: String(head.date) });
      const up = await run('docker', [...composeArgs(p, publicProfile), 'up', '-d', '--build', ...services], { cwd: p.dir, env, timeout: 30 * 60_000 });
      if (up.code !== 0) {
        throw new UpdaterError(502, 'compose_failed', `Neue Version geholt, aber Bauen/Neustarten ging nicht: ${sanitize(up.stderr || up.stdout)}`);
      }
      // Wurde nur das Backend neu erstellt, kennt nginx im Frontend evtl. noch dessen alte Adresse → neu starten.
      const frontendAfter = await containerId(p, 'outreach-cockpit');
      if (frontendAfter && frontendAfter === frontendBefore) {
        const restart = await run('docker', [...composeArgs(p, publicProfile), 'restart', 'outreach-cockpit'], { cwd: p.dir, env, timeout: 5 * 60_000 });
        if (restart.code !== 0) log(`Frontend nicht neu gestartet: ${sanitize(restart.stderr)}`);
      }
      state.pendingBuild = false;
      cached = null;
      finish(true, `Auf ${head.commit} aktualisiert.`);
      // Vor dem Hilfs-Container (der baut gleich den Dienst neu und braucht seinen Cache).
      await pruneDocker();
      await refreshSelf(p, before, after);
    } catch (error) {
      const message = error instanceof UpdaterError ? error.message : `Unerwarteter Fehler: ${sanitize(error?.message)}`;
      // Scheitert erst das Bauen, bleibt `pendingBuild` gesetzt: ein neuer Versuch geht dann auch ohne neue Commits.
      finish(false, message);
    }
  }

  /**
   * Nach einem erfolgreichen Update aufräumen, damit die Platte nicht mit jedem Update voller wird: verwaiste Abbilder
   * (alte Versionen ohne Namen) und Bau-Cache, der älter als eine Woche ist. Feste Argumente; ein Fehler hier ändert
   * das Ergebnis des Updates nie.
   */
  async function pruneDocker() {
    for (const args of PRUNE_COMMANDS) {
      try {
        const result = await run('docker', args, { timeout: 10 * 60_000 });
        if (result.code !== 0) log(`Aufräumen (docker ${args.slice(0, 2).join(' ')}) ging nicht: ${sanitize(result.stderr)}`);
      } catch (error) {
        log(`Aufräumen (docker ${args.slice(0, 2).join(' ')}) ging nicht: ${sanitize(error?.message)}`);
      }
    }
  }

  /**
   * Hat sich der Update-Dienst selbst geändert, baut ihn ein kurzlebiger Hilfs-Container neu (er selbst kann sich nicht
   * ersetzen, ohne mitten im Befehl beendet zu werden). Fehler hier ändern das Ergebnis des Updates nicht.
   */
  async function refreshSelf(p, before, after) {
    const diff = await git(['diff', '--name-only', before, after, '--', 'deploy/updater', 'docker-compose.yml']);
    if (diff.code !== 0 || !diff.stdout.trim() || !p.image) return;
    const env = composeEnv(p);
    const helper = [
      'run', '-d', '--rm', '--name', `${p.name}-updater-refresh`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-v', `${p.dir}:${p.dir}`, '-w', p.dir,
      '-e', `PWD=${p.dir}`, '-e', `HOME=${env.HOME}`,
      '--entrypoint', 'docker', p.image,
      ...composeArgs(p, false), 'up', '-d', '--build', '--no-deps', 'updater',
    ];
    const result = await run('docker', helper, { timeout: 60_000 });
    log(result.code === 0 ? 'Update-Dienst wird neu gebaut.' : `Update-Dienst nicht neu gebaut: ${sanitize(result.stderr)}`);
  }

  /** Startet ein Update. Antwortet sofort (Status mit running), der Rest läuft im Hintergrund. */
  const cleanBy = (by) => String(by ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'Unbekannt';

  async function update(by) {
    if (running) throw new UpdaterError(409, 'update_running', 'Es läuft schon ein Update.');
    running = true;
    try {
      await fetchUpstream();
      const current = await versions();
      if (current.behind === 0 && !state.pendingBuild) throw new UpdaterError(409, 'up_to_date', 'Die Software ist schon aktuell.');
    } catch (error) {
      running = false;
      // Zugang zu GitHub fehlt: im Protokoll festhalten, damit es auch nach einem nächtlichen Versuch sichtbar ist.
      if (error instanceof UpdaterError && error.code === 'git_auth') {
        state.lastRun = { startedAt: now(), finishedAt: now(), ok: false, message: error.message, by: cleanBy(by) };
        save();
      }
      throw error;
    }
    const who = cleanBy(by);
    state.lastRun = { startedAt: now(), finishedAt: null, ok: null, message: 'Das Update läuft …', by: who };
    save();
    log(`Update gestartet von ${who}`);
    const done = perform();
    return { status: await status({ fetch: false }), done };
  }

  return { status, update, discover, get running() { return running; }, get state() { return state; } };
}

/** HTTP-Schicht: Schlüssel prüfen, Routen, JSON. */
export function createHandler(updater, token) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, error) => {
    if (error instanceof UpdaterError) return send(res, error.status, { error: { code: error.code, message: error.message } });
    return send(res, 500, { error: { code: 'internal', message: `Unerwarteter Fehler: ${sanitize(error?.message)}` } });
  };
  return async (req, res) => {
    const auth = String(req.headers.authorization ?? '');
    if (!tokenMatches(auth.startsWith('Bearer ') ? auth.slice(7) : '', token)) return send(res, 401, { error: { code: 'unauthorized', message: 'Schlüssel fehlt oder stimmt nicht.' } });
    const url = new URL(req.url ?? '/', 'http://updater');
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, await updater.status({ fetch: url.searchParams.get('fetch') !== '0' }));
      }
      if (req.method === 'POST' && url.pathname === '/update') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 4096) return send(res, 413, { error: { code: 'too_large', message: 'Anfrage zu groß.' } });
        }
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(res, 400, { error: { code: 'invalid_request', message: 'Ungültiges JSON.' } });
        }
        const { status } = await updater.update(typeof body?.by === 'string' ? body.by : '');
        return send(res, 202, status);
      }
      return send(res, 404, { error: { code: 'not_found', message: 'Unbekannte Route.' } });
    } catch (error) {
      return fail(res, error);
    }
  };
}

export async function main() {
  const repoDir = process.cwd();
  const shared = process.env.UPDATER_SHARED_DIR ?? '/shared';
  const token = ensureToken(path.join(shared, 'updater.token'));
  const uid = Number(process.env.GIT_UID);
  const gid = Number(process.env.GIT_GID);
  const updater = createUpdater({
    run: execRunner,
    repoDir,
    stateFile: path.join(shared, 'updater-state.json'),
    selfId: process.env.HOSTNAME ?? '',
    gitUser: Number.isInteger(uid) ? { uid, gid: Number.isInteger(gid) ? gid : uid, home: process.env.GIT_HOME } : {},
    log: (message) => console.log(`[updater] ${message}`),
  });
  const server = createServer(createHandler(updater, token));
  server.listen(Number(process.env.UPDATER_PORT ?? PORT), '0.0.0.0', () => console.log(`[updater] bereit im Projekt ${repoDir}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
