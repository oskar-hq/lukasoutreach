#!/usr/bin/env node
/**
 * PreToolUse-Hook (Edit/Write/MultiEdit/NotebookEdit): Leitplanke für zwei parallel arbeitende Agents.
 *
 * Ist AGENT_ROLE gesetzt (frontend | backend) und soll eine Datei aus dem Bereich des ANDEREN Agents
 * bearbeitet werden, fragt Claude Code den Nutzer vorher („ask“). Dateien im Vertrag (shared/) sind erlaubt,
 * bekommen aber einen Hinweis auf die Vertragsregeln. Ohne AGENT_ROLE macht der Hook nichts.
 *
 * Die Bereiche stehen in scripts/agent-areas.mjs.
 */
import path from 'node:path';
import { ownerOf } from './agent-areas.mjs';

const LABEL = { frontend: 'Frontend', backend: 'Backend' };

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function respond(output) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }));
}

async function main() {
  const role = (process.env.AGENT_ROLE ?? '').trim().toLowerCase();
  if (role !== 'frontend' && role !== 'backend') return;

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const file = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (typeof file !== 'string' || !file) return;

  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (relative.startsWith('..')) return;

  if (relative.startsWith('shared/')) {
    respond({
      additionalContext:
        'Vertragsdatei (shared/): nur additiv ändern, als eigener Commit „contract: …“, beide Typprüfungen grün halten ' +
        '(npm run typecheck) und die Änderung in deiner Handoff-Datei unter „Vertragsänderungen“ eintragen. Siehe CLAUDE.md.',
    });
    return;
  }

  const owner = ownerOf(relative);
  if (!owner || owner === role) return;
  respond({
    permissionDecision: 'ask',
    permissionDecisionReason:
      `${relative} gehört dem ${LABEL[owner]}-Agent (du bist ${LABEL[role]}). Erlaubt nur in den Ausnahmen aus CLAUDE.md ` +
      `(minimaler Fix nach einer Vertragsänderung, E2E-Erwartungen nach geänderten Mock-Zahlen). ` +
      `Sonst den Wunsch in docs/agents/${role}.md unter „Brauche von der anderen Seite“ eintragen.`,
  });
}

await main();
