import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinkedinAccountState, LinkedinAccountStatus } from '../../shared/leadSearch.js';
import { UnipileWatch } from '../src/system/unipileWatch.js';

/** Prüfung mit nachgebautem Status – zählt onDown/onOk. */
function watch(states: LinkedinAccountState[]) {
  const calls = { down: 0, ok: 0 };
  let enabled = true;
  const queue = [...states];
  const log = { warn() {}, error() {} } as unknown as ConstructorParameters<typeof UnipileWatch>[0]['log'];
  const instance = new UnipileWatch({
    enabled: () => enabled,
    status: async (): Promise<LinkedinAccountStatus> => ({ state: queue.shift() ?? 'ok', name: null, message: 'Test' }),
    onDown: () => calls.down++,
    onOk: () => calls.ok++,
    log,
  });
  return { instance, calls, disable: () => (enabled = false) };
}

test('Unipile-Prüfung: „nicht erreichbar“ meldet erst nach zwei Prüfungen in Folge (kein Flattern)', async () => {
  const { instance, calls } = watch(['unreachable', 'ok', 'unreachable', 'ok', 'unreachable', 'unreachable', 'unreachable']);
  await instance.check(); // Aussetzer
  await instance.check(); // ok → Zähler zurück
  await instance.check(); // Aussetzer
  await instance.check(); // ok
  assert.equal(calls.down, 0, 'einzelne Aussetzer melden nichts');
  await instance.check();
  assert.equal(calls.down, 0);
  await instance.check();
  assert.equal(calls.down, 1, 'zweiter Fehlschlag in Folge meldet');
  await instance.check();
  assert.equal(calls.down, 2, 'bleibt gemeldet (Zusammenfassen erledigt die Meldung selbst)');
});

test('Unipile-Prüfung: abgelaufener Account (reconnect/missing) meldet sofort', async () => {
  const { instance, calls } = watch(['reconnect', 'missing']);
  await instance.check();
  assert.equal(calls.down, 1);
  await instance.check();
  assert.equal(calls.down, 2);
});

test('Unipile-Prüfung aus (Simulation, Token entfernt): offene Meldung verschwindet', async () => {
  const { instance, calls, disable } = watch(['reconnect']);
  await instance.check();
  assert.equal(calls.down, 1);
  disable();
  assert.equal(await instance.check(), null);
  assert.equal(calls.ok, 1);
});
