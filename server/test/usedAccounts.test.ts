import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, usedAccountIds } from '../src/config.js';
import { UnipileClient } from '../src/adapters/live/unipileClient.js';
import { tempDataDir } from './helpers.js';

// Instanz Lukas 03.11.: mehrere Cockpits teilen sich einen Unipile-Zugang – nur freigegebene Accounts nutzen.

const ACCOUNTS = ['acc_lukas', 'acc_nick', 'acc_scrape1', 'acc_scrape2'].map((id) => ({ object: 'Account', type: 'LINKEDIN', id, name: id }));

function fakeFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({ object: 'AccountList', items: ACCOUNTS }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

test('ohne Auswahl nutzt das Cockpit alle Accounts (wie bisher)', async () => {
  const config = loadConfig({ LEAD_SEARCH_MODE: 'live', DATA_DIR: tempDataDir() });
  assert.deepEqual(usedAccountIds(config), []);
  const client = new UnipileClient({ dsn: 'https://unipile.test', apiKey: 'k', fetch: fakeFetch(), onlyAccounts: () => usedAccountIds(config) });
  const { items } = await client.listAccounts(AbortSignal.timeout(1000));
  assert.equal(items.length, 4);
});

test('mit Auswahl sieht das Cockpit nur die gewählten plus Gründer- und Aufwärm-Accounts', async () => {
  const config = loadConfig({
    LEAD_SEARCH_MODE: 'live',
    DATA_DIR: tempDataDir(),
    UNIPILE_ACCOUNTS_USED: 'acc_scrape1',
    UNIPILE_ACCOUNT_NICK: 'acc_lukas',
  });
  assert.deepEqual(usedAccountIds(config).sort(), ['acc_lukas', 'acc_scrape1']);
  const client = new UnipileClient({ dsn: 'https://unipile.test', apiKey: 'k', fetch: fakeFetch(), onlyAccounts: () => usedAccountIds(config) });
  const { items } = await client.listAccounts(AbortSignal.timeout(1000));
  assert.deepEqual(items.map((account) => account.id).sort(), ['acc_lukas', 'acc_scrape1']);
  // Die Einstellungen brauchen alle, um weitere freizugeben.
  const all = await client.listAccounts(AbortSignal.timeout(1000), { all: true });
  assert.equal(all.items.length, 4);
});
