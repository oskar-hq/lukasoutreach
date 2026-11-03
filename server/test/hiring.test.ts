import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectHiring, hiringFromAi } from '../src/qualify/hiring.js';

const profile = (fields: { headline?: string; position?: string; companyDescription?: string }) => ({
  headline: fields.headline ?? '',
  position: fields.position ?? null,
  companyDescription: fields.companyDescription ?? null,
});
const hit = { headline: '' };

test('Hiring-Signal: Stellentitel aus „Wir suchen …“ und „(m/w/d)“', () => {
  assert.deepEqual(detectHiring(hit, profile({ companyDescription: 'Kapitalanlagen in Köln. Wir suchen ab sofort einen Vertriebsmitarbeiter (m/w/d) für unser Team.' })), {
    role: 'Vertriebsmitarbeiter (m/w/d)',
    source: 'profile',
    evidence: 'Firmenbeschreibung: „Kapitalanlagen in Köln. Wir suchen ab sofort einen Vertriebsmitarbeiter (m/w/d) für unser Team.“',
  });
  assert.equal(detectHiring(hit, profile({ headline: 'GF · Wir stellen ein: Immobilienberater Neubau (w/m/d)' }))?.role, 'Immobilienberater Neubau (w/m/d)');
  assert.equal(detectHiring(hit, profile({ companyDescription: 'Offene Stelle: Objektbetreuer (m/w/d) in Leipzig' }))?.role, 'Objektbetreuer (m/w/d)');
  // Headline aus der Suche reicht, wenn das Profil fehlt.
  assert.equal(detectHiring({ headline: 'Inhaber · #hiring' }, null)?.role, null);
});

test('Hiring-Signal: Hinweise ohne Titel, keine Treffer ohne Beleg', () => {
  assert.deepEqual(detectHiring(hit, profile({ headline: 'Geschäftsführer | We are hiring!' })), {
    role: null,
    source: 'profile',
    evidence: 'Headline: „Geschäftsführer | We are hiring!“',
  });
  assert.equal(detectHiring(hit, profile({ companyDescription: 'Wir suchen Vertriebler in ganz Bayern.' }))?.role, 'Vertriebler');
  assert.equal(detectHiring(hit, profile({ headline: 'Geschäftsführer · Kapitalanlage', companyDescription: 'Wachsendes Team mit 40 Mitarbeitenden.' })), null);
  assert.equal(detectHiring(hit, null), null);
});

test('Hiring-Signal aus der KI: leer = keins, „Mitarbeiter“ = Stelle unbekannt', () => {
  assert.equal(hiringFromAi(null), null);
  assert.equal(hiringFromAi('  '), null);
  assert.deepEqual(hiringFromAi('Mitarbeiter'), { role: null, source: 'ai', evidence: null });
  assert.deepEqual(hiringFromAi(' Vertriebsmitarbeiter  (m/w/d) '), { role: 'Vertriebsmitarbeiter (m/w/d)', source: 'ai', evidence: null });
  assert.equal(hiringFromAi('x'.repeat(200))?.role?.length, 80);
});
