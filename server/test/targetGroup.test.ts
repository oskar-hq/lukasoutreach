import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EnrichedProfile, Qualification, SearchHit } from '../../shared/leadSearch.js';
import { LARGE_GROUP_REASON, applyTargetRules, largeGroupOf } from '../src/qualify/targetGroup.js';

const hit = (headline: string): SearchHit => ({
  providerId: 'ACoTG1',
  publicIdentifier: 'tg',
  firstName: 'Tina',
  lastName: 'Test',
  headline,
  location: 'Köln',
  networkDistance: 2,
  profileUrl: null,
});
const profile = (companyName: string | null, headline = 'Geschäftsführerin', position = 'Geschäftsführerin'): EnrichedProfile => ({
  headline,
  position,
  companyName,
  companyDescription: null,
  companyWebsite: null,
  companyIndustry: null,
  location: 'Köln',
});
const fdl: Qualification = { category: 'finanzdienstleister', qualified: true, confidence: 0.85, reason: 'FDL mit Team.', summary: 'FDL. GF.' };

test('Zielgruppe 27.10.: Konzerne und große Strukturvertriebe sind nie qualifiziert', () => {
  assert.equal(largeGroupOf(hit('x'), profile('Deutsche Vermögensberatung AG')), 'Deutsche Vermögensberatung');
  assert.equal(largeGroupOf(hit('x'), profile('DVAG Direktion Köln')), 'Deutsche Vermögensberatung');
  assert.equal(largeGroupOf(hit('x'), profile('Swiss Life Select Deutschland GmbH')), 'Swiss Life Select');
  assert.equal(largeGroupOf(hit('x'), profile('Hauk Finanzpartner GmbH')), null);
  // Ohne Firmenname zählen Position und Headline; mit Firmenname nur die Firma („ehemals DVAG“ in der Headline).
  assert.equal(largeGroupOf(hit('Regionaldirektor der DVAG'), profile(null, 'Regionaldirektor der DVAG')), 'Deutsche Vermögensberatung');
  assert.equal(largeGroupOf(hit('GF · vorher 10 Jahre DVAG'), profile('Muster Finanz GmbH', 'GF · vorher 10 Jahre DVAG')), null);

  const rejected = applyTargetRules(hit('x'), profile('MLP Finanzberatung SE'), fdl);
  assert.equal(rejected.qualified, false);
  assert.ok(rejected.reason.startsWith(LARGE_GROUP_REASON));
  assert.equal(applyTargetRules(hit('x'), profile('Muster Finanz GmbH'), fdl), fdl, 'mittelgroß bleibt, wie die KI sagt');
  const notQualified = { ...fdl, qualified: false };
  assert.equal(applyTargetRules(hit('x'), profile('OVB Holding'), notQualified), notQualified, 'nicht qualifiziert bleibt unverändert');
});
