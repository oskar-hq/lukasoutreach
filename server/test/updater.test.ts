import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import {
  CHANGES_MAX,
  GIT_AUTH_MESSAGE,
  createHandler,
  createUpdater,
  ensureToken,
  sanitize,
  tokenMatches,
  type RunOptions,
  type RunResult,
} from '../../deploy/updater/server.mjs';
import { tempDataDir } from './helpers.js';

/**
 * Update-Dienst (`deploy/updater/server.mjs`) mit nachgebautem git und Docker: Es läuft kein echter Befehl.
 */

const SEP = '\x1f';
const OLD = 'a1b2c3d000000000000000000000000000000000';
const NEW = 'c0ffee1000000000000000000000000000000000';
const PROJECT_DIR = '/srv/Scraper';

interface Call {
  command: string;
  args: string[];
  options?: RunOptions;
}

function fakeRunner(
  options: { behind?: number; caddy?: boolean; composeFails?: boolean; fetchFails?: boolean; authFails?: boolean; changedFiles?: string; workingDir?: string; frontendRecreated?: boolean; fetchDelayMs?: number; pruneFails?: boolean | 'throw' } = {},
) {
  const calls: Call[] = [];
  let composeUps = 0;
  let activeRefWriters = 0;
  let maxRefWriters = 0;
  let head = OLD;
  let behind = options.behind ?? 2;
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const line = (sha: string, title: string) => `${sha}${SEP}1759740000${SEP}${title}`;
  const run = async (command: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    calls.push({ command, args, options: opts });
    const joined = args.join(' ');
    if (command === 'git') {
      if (args[0] === 'fetch' || args[0] === 'merge') {
        activeRefWriters += 1;
        maxRefWriters = Math.max(maxRefWriters, activeRefWriters);
        await new Promise((resolve) => setTimeout(resolve, options.fetchDelayMs ?? 0));
        activeRefWriters -= 1;
      }
      if (args[0] === 'fetch') {
        if (options.authFails) return { code: 128, stdout: '', stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" };
        return options.fetchFails ? { code: 128, stdout: '', stderr: "fatal: could not read from 'https://oskar:ghp_GEHEIM123@github.com/oskar-hq/Scraper.git'" } : ok();
      }
      if (joined === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return ok('origin/main\n');
      if (joined === 'rev-parse HEAD') return ok(`${head}\n`);
      if (args[0] === 'log' && args.at(-1) === 'HEAD') return ok(head === OLD ? line(OLD, 'Alter Stand') : line(NEW, 'Übergabe an Close'));
      if (args[0] === 'log' && args.at(-1) === '@{u}') return ok(line(NEW, 'Übergabe an Close'));
      if (args[0] === 'rev-list') return ok(`${behind}\n`);
      if (args[0] === 'log' && args.at(-1) === 'HEAD..@{u}') return ok([line(NEW, 'Übergabe an Close'), line('b4d5e6f000', 'Lead-Suche schneller')].join('\n'));
      if (args[0] === 'merge') {
        head = NEW;
        behind = 0;
        return ok();
      }
      if (args[0] === 'diff') return ok(options.changedFiles ?? '');
    }
    if (command === 'docker') {
      if (args[0] === 'inspect') {
        return ok(
          JSON.stringify([
            {
              Config: {
                Image: 'outreach-cockpit-updater:latest',
                Labels: {
                  'com.docker.compose.project': 'scraper',
                  'com.docker.compose.project.working_dir': options.workingDir ?? PROJECT_DIR,
                  'com.docker.compose.project.config_files': `${PROJECT_DIR}/docker-compose.yml`,
                },
              },
              Mounts: [{ Source: '/home/oskar', Destination: '/hosthome' }],
            },
          ]),
        );
      }
      if (args[0] === 'ps' && joined.includes('service=caddy')) return ok(options.caddy ? 'abc123\n' : '');
      if (args[0] === 'ps' && joined.includes('service=outreach-cockpit')) return ok(options.frontendRecreated && composeUps > 0 ? 'front2\n' : 'front1\n');
      if (args[0] === 'compose') {
        if (options.composeFails) return { code: 1, stdout: '', stderr: 'failed to build: https://x:pw@registry' };
        if (args.includes('up')) composeUps += 1;
        return ok();
      }
      if (args[0] === 'run') return ok('helper\n');
      if ((args[0] === 'image' || args[0] === 'builder') && args[1] === 'prune') {
        if (options.pruneFails === 'throw') throw new Error('docker weg');
        return options.pruneFails ? { code: 1, stdout: '', stderr: 'Error response from daemon: a prune operation is already running' } : ok('Total reclaimed space: 1.2GB\n');
      }
    }
    return { code: 1, stdout: '', stderr: `unerwartet: ${command} ${joined}` };
  };
  return { run, calls, maxRefWriters: () => maxRefWriters };
}

function setup(runnerOptions: Parameters<typeof fakeRunner>[0] = {}, stateFile = path.join(tempDataDir(), 'state.json')) {
  const fake = fakeRunner(runnerOptions);
  const updater = createUpdater({
    run: fake.run,
    repoDir: PROJECT_DIR,
    stateFile,
    selfId: 'abc',
    gitUser: { uid: 1000, gid: 1000, home: '/hosthome' },
    now: () => 1_000_000,
    baseEnv: { PATH: '/usr/bin', HOME: '/root', SECRET_IN_ENV: 'nie-weitergeben' },
  });
  return { ...fake, updater, stateFile };
}

test('Updater: Status mit fetch, Versionen und Änderungen; git als Besitzer des Repos', async () => {
  const { updater, calls } = setup();
  const status = await updater.status();
  assert.equal(status.behind, 2);
  assert.deepEqual(status.current, { commit: 'a1b2c3d', title: 'Alter Stand', date: 1759740000_000 });
  assert.equal(status.latest.commit, 'c0ffee1');
  assert.deepEqual(status.changes.map((change) => change.title), ['Übergabe an Close', 'Lead-Suche schneller']);
  assert.equal(status.checkedAt, 1_000_000);
  assert.equal(status.running, false);
  assert.equal(calls[0].args[0], 'fetch');
  assert.ok(calls.some((call) => call.args.includes(`-n${CHANGES_MAX}`)));
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.equal(call.options?.uid, 1000);
    assert.equal(call.options?.cwd, PROJECT_DIR);
    assert.equal(call.options?.env?.HOME, '/hosthome');
    assert.equal(call.options?.env?.GIT_TERMINAL_PROMPT, '0');
    assert.equal(call.options?.env?.SECRET_IN_ENV, undefined, 'keine fremden Umgebungsvariablen an git');
  }

  const calls2 = calls.length;
  await updater.status({ fetch: false });
  assert.ok(!calls.slice(calls2).some((call) => call.args[0] === 'fetch'), 'fetch=0 ohne git fetch');
});

test('Updater: Update holt, baut ohne den Dienst selbst, mit Profil public, Protokoll übersteht Neustart', async () => {
  const { updater, calls, stateFile } = setup({ caddy: true });
  const { status, done } = await updater.update('Nick\n<script>');
  assert.equal(status.running, true);
  assert.equal(status.lastRun?.ok, null);
  assert.equal(status.lastRun?.by, 'Nick<script>', 'Steuerzeichen entfernt');
  await assert.rejects(updater.update('Johannes'), { code: 'update_running', status: 409 });
  await done;

  assert.equal(updater.running, false);
  assert.equal(updater.state.lastRun?.ok, true);
  assert.equal(updater.state.lastRun?.message, 'Auf c0ffee1 aktualisiert.');
  const compose = calls.find((call) => call.args[0] === 'compose')!;
  assert.deepEqual(compose.args, [
    'compose', '-p', 'scraper', '--project-directory', PROJECT_DIR, '-f', `${PROJECT_DIR}/docker-compose.yml`, '--profile', 'public',
    'up', '-d', '--build', 'outreach-cockpit', 'backend', 'caddy',
  ]);
  assert.ok(!compose.args.includes('updater'));
  assert.equal(compose.options?.uid, undefined, 'docker als root');
  assert.equal(compose.options?.env?.PWD, PROJECT_DIR);
  assert.equal(compose.options?.env?.HOME, '/home/oskar', 'HOME des Servers für ${HOME} in der Compose-Datei');
  assert.equal(compose.options?.env?.APP_COMMIT, NEW);
  assert.equal(compose.options?.env?.APP_COMMIT_TITLE, 'Übergabe an Close');
  assert.ok(!calls.some((call) => call.args[0] === 'run'), 'Dienst selbst unverändert → kein Neubau');

  // Neuer Prozess liest das Protokoll
  const again = createUpdater({ run: fakeRunner({ behind: 0 }).run, repoDir: PROJECT_DIR, stateFile, selfId: 'abc' });
  assert.equal(again.state.lastRun?.message, 'Auf c0ffee1 aktualisiert.');
  await assert.rejects(again.update('Nick'), { code: 'up_to_date', status: 409 });
});

test('Updater: ohne Caddy kein Profil public; geänderter Dienst → Hilfs-Container baut ihn neu', async () => {
  const { updater, calls } = setup({ changedFiles: 'deploy/updater/server.mjs\n' });
  await (await updater.update('Nick')).done;
  const compose = calls.find((call) => call.args[0] === 'compose')!;
  assert.ok(!compose.args.includes('--profile'));
  assert.deepEqual(compose.args.slice(-5), ['up', '-d', '--build', 'outreach-cockpit', 'backend']);
  const helper = calls.find((call) => call.args[0] === 'run')!;
  assert.ok(helper, 'Hilfs-Container gestartet');
  assert.ok(helper.args.includes('outreach-cockpit-updater:latest'));
  assert.deepEqual(helper.args.slice(-5), ['up', '-d', '--build', '--no-deps', 'updater']);
  assert.ok(helper.args.includes(`${PROJECT_DIR}:${PROJECT_DIR}`));
});

test('Updater: nach erfolgreichem Update aufräumen (feste Argumente), vor dem Neubau des Dienstes; Fehler dabei egal', async () => {
  const { updater, calls } = setup({ changedFiles: 'deploy/updater/server.mjs\n' });
  await (await updater.update('Nick')).done;
  const prunes = calls.filter((call) => call.args[1] === 'prune');
  assert.deepEqual(prunes.map((call) => [call.command, ...call.args]), [
    ['docker', 'image', 'prune', '-f'],
    ['docker', 'builder', 'prune', '-f', '--filter', 'until=168h'],
  ]);
  assert.ok(calls.indexOf(prunes[1]) < calls.findIndex((call) => call.args[0] === 'run'), 'vor dem Hilfs-Container');

  for (const pruneFails of [true, 'throw'] as const) {
    const failing = setup({ pruneFails });
    await (await failing.updater.update('Nick')).done;
    assert.equal(failing.updater.state.lastRun?.ok, true, `Update gilt trotzdem (${pruneFails})`);
    assert.equal(failing.updater.state.lastRun?.message, 'Auf c0ffee1 aktualisiert.');
  }

  // Gescheitertes Update räumt nicht auf
  const broken = setup({ composeFails: true });
  await (await broken.updater.update('Nick')).done;
  assert.ok(!broken.calls.some((call) => call.args[1] === 'prune'));
});

test('Updater: Fehler beim Bauen ohne Geheimnisse; neuer Versuch auch ohne neue Commits erlaubt', async () => {
  const { updater } = setup({ composeFails: true });
  await (await updater.update('Nick')).done;
  assert.equal(updater.state.lastRun?.ok, false);
  assert.match(updater.state.lastRun!.message, /Bauen\/Neustarten ging nicht/);
  assert.ok(!updater.state.lastRun!.message.includes('pw@'), 'Zugangsdaten entfernt');
  assert.equal(updater.state.pendingBuild, true);
  // behind ist jetzt 0 (git schon gemerged), trotzdem kein up_to_date
  const retry = await updater.update('Nick');
  assert.equal(retry.status.running, true);
  await retry.done;
});

test('Updater: fetch-Fehler ohne Token in der Meldung; unterbrochener Lauf wird als Fehler vermerkt', async () => {
  const { updater } = setup({ fetchFails: true });
  await assert.rejects(updater.status(), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'git_failed');
    assert.ok(!error.message.includes('ghp_GEHEIM123'), error.message);
    assert.match(error.message, /https:\/\/github\.com\/oskar-hq/);
    return true;
  });
  assert.equal(updater.running, false);

  const stateFile = path.join(tempDataDir(), 'state.json');
  writeFileSync(stateFile, JSON.stringify({ lastRun: { startedAt: 1, finishedAt: null, ok: null, message: 'läuft', by: 'Nick' }, checkedAt: 1 }));
  const restarted = createUpdater({ run: fakeRunner().run, repoDir: PROJECT_DIR, stateFile, selfId: 'abc', now: () => 5 });
  assert.equal(restarted.state.lastRun?.ok, false);
  assert.equal(restarted.state.lastRun?.finishedAt, 5);
  assert.match(restarted.state.lastRun!.message, /unterbrochen/);
});

test('Updater: falsch eingebundener Projektordner bricht ab', async () => {
  const { updater } = setup({ workingDir: '/anderer/ordner' });
  await (await updater.update('Nick')).done;
  assert.equal(updater.state.lastRun?.ok, false);
  assert.match(updater.state.lastRun!.message, /Projektordner/);
});

test('Updater: sanitize, Schlüsselvergleich und Schlüsseldatei', () => {
  assert.equal(sanitize('fatal: https://user:tok@github.com/a.git und ssh://git@github.com/x'), 'fatal: https://github.com/a.git und ssh://github.com/x');
  assert.equal(sanitize('a\n  b'), 'a b');
  assert.ok(sanitize('x'.repeat(1000)).length <= 401);
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abd', 'abc'), false);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches(undefined, 'abc'), false);
  assert.equal(tokenMatches('abc', ''), false);

  const file = path.join(tempDataDir(), 'shared', 'updater.token');
  const token = ensureToken(file, { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o400);
  assert.equal(ensureToken(file), token, 'bleibt beim nächsten Start gleich');
  assert.equal(readFileSync(file, 'utf8').trim(), token);
});

test('Updater: HTTP nur mit Schlüssel', async () => {
  const { updater } = setup();
  const server = createServer(createHandler(updater, 'richtiger-schluessel'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/status`)).status, 401);
    assert.equal((await fetch(`${url}/status`, { headers: { authorization: 'Bearer falsch' } })).status, 401);
    const ok = await fetch(`${url}/status?fetch=0`, { headers: { authorization: 'Bearer richtiger-schluessel' } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { behind: number }).behind, 2);
    const started = await fetch(`${url}/update`, { method: 'POST', headers: { authorization: 'Bearer richtiger-schluessel' }, body: JSON.stringify({ by: 'Nick' }) });
    assert.equal(started.status, 202);
    const busy = await fetch(`${url}/update`, { method: 'POST', headers: { authorization: 'Bearer richtiger-schluessel' }, body: '{}' });
    assert.ok([202, 409].includes(busy.status));
    assert.equal((await fetch(`${url}/nichts`, { headers: { authorization: 'Bearer richtiger-schluessel' } })).status, 404);
  } finally {
    // Hintergrund-Lauf zu Ende kommen lassen
    while (updater.running) await new Promise((resolve) => setTimeout(resolve, 5));
    server.close();
  }
});

test('Updater: Frontend wird nach dem Update neu gestartet, wenn nur das Backend neu erstellt wurde', async () => {
  const kept = setup();
  await (await kept.updater.update('Nick')).done;
  const restart = kept.calls.find((call) => call.args[0] === 'compose' && call.args.includes('restart'));
  assert.ok(restart, 'restart outreach-cockpit');
  assert.deepEqual(restart.args.slice(-2), ['restart', 'outreach-cockpit']);

  const recreated = setup({ frontendRecreated: true });
  await (await recreated.updater.update('Nick')).done;
  assert.ok(!recreated.calls.some((call) => call.args.includes('restart')), 'neu erstellt → kein Neustart nötig');
  assert.equal(recreated.updater.state.lastRun?.ok, true);
});

test('Updater: pendingBuild im Status; Stand ohne fetch aus dem Zwischenspeicher', async () => {
  const { updater, calls } = setup({ composeFails: true });
  const first = await updater.status({ fetch: false });
  assert.equal(first.pendingBuild, false);
  const before = calls.length;
  await updater.status({ fetch: false });
  assert.equal(calls.length, before, 'zweites GET ohne git');
  await (await updater.update('Nick')).done;
  const after = await updater.status({ fetch: false });
  assert.equal(after.pendingBuild, true);
  assert.equal(after.behind, 0, 'neu berechnet nach dem Merge');
});

test('Updater: fetch und merge nie gleichzeitig (Ref-Sperre)', async () => {
  const fake = setup({ fetchDelayMs: 20 });
  const results = await Promise.all([fake.updater.status(), fake.updater.status(), fake.updater.update('Nick').then((r) => r.done)]);
  assert.equal(results.length, 3);
  assert.equal(fake.maxRefWriters(), 1);
});

test('Updater: abgelehnter git-Zugang → klarer Satz, auch im Protokoll', async () => {
  const { updater } = setup({ authFails: true });
  await assert.rejects(updater.update('Automatisch (nachts)'), { code: 'git_auth', message: GIT_AUTH_MESSAGE });
  assert.equal(updater.state.lastRun?.ok, false);
  assert.equal(updater.state.lastRun?.message, GIT_AUTH_MESSAGE);
  assert.match(GIT_AUTH_MESSAGE, /UPDATER_GIT_HOME/);
  assert.equal(updater.running, false);
});
