#!/usr/bin/env node
/**
 * Lagebild für zwei parallel arbeitende Agents: aktive Branches, wer dort was ändert (Frontend/Backend/Vertrag),
 * und der neueste Stand beider Handoff-Dateien (docs/agents/*.md) – egal auf welchem Branch er liegt.
 *
 *   npm run agents:status            Ausgabe für Menschen und Agents
 *   node scripts/agents-status.mjs --hook   als SessionStart-Hook (JSON mit additionalContext)
 *
 * Schlägt nie fehl: ohne Netz oder Git zeigt es, was lokal bekannt ist.
 */
import { execFileSync } from 'node:child_process';
import { ownerOf } from './agent-areas.mjs';

const INTEGRATION_BRANCH = 'main';
const ACTIVE_DAYS = 14;
const HANDOFF_LINES = 40;
const asHook = process.argv.includes('--hook');

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim();
  } catch {
    return null;
  }
}

function areasOf(files) {
  const areas = new Set();
  for (const file of files) {
    if (file.startsWith('shared/')) areas.add('Vertrag (shared/)');
    else if (ownerOf(file) === 'frontend') areas.add('Frontend');
    else if (ownerOf(file) === 'backend') areas.add('Backend');
    else areas.add('Gemeinsam');
  }
  return [...areas];
}

function build() {
  const lines = [];
  const say = (text = '') => lines.push(text);
  const role = (process.env.AGENT_ROLE ?? '').trim().toLowerCase();
  const fetched = git('fetch', '--quiet', '--prune', 'origin') !== null;
  const base = `origin/${INTEGRATION_BRANCH}`;
  const hasBase = git('rev-parse', '--verify', '--quiet', base) !== null;
  const current = git('rev-parse', '--abbrev-ref', 'HEAD');

  say(`Agent-Status · Integrations-Branch: ${INTEGRATION_BRANCH}${fetched ? '' : ' (git fetch fehlgeschlagen – Stand evtl. veraltet)'}`);
  if (role === 'frontend' || role === 'backend') {
    say(`Deine Rolle: ${role} (aus AGENT_ROLE). Regeln und Bereiche: CLAUDE.md.`);
  } else {
    say('Deine Rolle: unbekannt (AGENT_ROLE nicht gesetzt). Nimm sie aus der Nachricht des Nutzers, sonst frag nach: Frontend- oder Backend-Agent?');
  }

  if (current && hasBase) {
    const behind = Number(git('rev-list', '--count', `HEAD..${base}`) ?? 0);
    const ahead = Number(git('rev-list', '--count', `${base}..HEAD`) ?? 0);
    const hint = behind > 0 ? ` → zuerst \`git merge ${base}\`` : '';
    say(`Dein Branch: ${current} · ${ahead} eigene Commits · ${behind} Commits hinter ${INTEGRATION_BRANCH}${hint}`);
  }

  // Aktive Branches (außer dem eigenen und dem Integrations-Branch)
  const now = Date.now() / 1000;
  const refs = (git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\t%(committerdate:unix)\t%(committerdate:relative)\t%(subject)', 'refs/remotes/origin') ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, unix, relative, subject] = line.split('\t');
      return { ref, unix: Number(unix), relative, subject };
    })
    .filter((entry) => entry.ref.startsWith('origin/') && entry.ref !== 'origin/HEAD' && entry.ref !== base && entry.ref !== `origin/${current}`)
    .filter((entry) => now - entry.unix < ACTIVE_DAYS * 86_400);

  say();
  if (!hasBase) {
    say(`Integrations-Branch ${base} nicht gefunden – Branch-Vergleich übersprungen.`);
  } else if (!refs.length) {
    say(`Keine anderen aktiven Branches in den letzten ${ACTIVE_DAYS} Tagen.`);
  } else {
    say(`Andere aktive Branches (letzte ${ACTIVE_DAYS} Tage):`);
    for (const entry of refs.slice(0, 8)) {
      const ahead = Number(git('rev-list', '--count', `${base}..${entry.ref}`) ?? 0);
      if (ahead === 0) continue;
      const files = (git('diff', '--name-only', `${base}...${entry.ref}`) ?? '').split('\n').filter(Boolean);
      const contract = files.filter((file) => file.startsWith('shared/'));
      say(`- ${entry.ref.replace('origin/', '')} · ${entry.relative} · ${ahead} Commits · ändert: ${areasOf(files).join(', ') || '–'}`);
      say(`  letzter Commit: ${entry.subject}`);
      if (contract.length) say(`  ⚠ Vertragsänderung noch nicht im Integrations-Branch: ${contract.join(', ')}`);
    }
  }

  // Neuester Stand jeder Handoff-Datei über alle Branches
  for (const side of ['backend', 'frontend']) {
    const file = `docs/agents/${side}.md`;
    let best = null;
    for (const ref of [base, ...refs.map((entry) => entry.ref)]) {
      const time = Number(git('log', '-1', '--format=%ct', ref, '--', file) ?? 0);
      if (time && (!best || time > best.time)) best = { ref, time };
    }
    say();
    if (!best) {
      say(`Handoff ${side}: noch keine Einträge.`);
      continue;
    }
    const content = git('show', `${best.ref}:${file}`) ?? '';
    const relative = git('log', '-1', '--format=%cr', best.ref, '--', file) ?? '';
    say(`Handoff ${side} (Stand von ${best.ref.replace('origin/', '')}, ${relative}):`);
    const body = content.split('\n');
    for (const line of body.slice(0, HANDOFF_LINES)) say(`  ${line}`);
    if (body.length > HANDOFF_LINES) say(`  … (gekürzt – ganze Datei: git show ${best.ref}:${file})`);
  }
  return lines.join('\n');
}

const text = build();
if (asHook) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
} else {
  process.stdout.write(`${text}\n`);
}
