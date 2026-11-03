import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QualificationValidationError, parseQualification } from '../src/qualify/schema.js';

const base = {
  category: 'kapitalanlage_vertrieb',
  qualified: true,
  confidence: 0.9,
  reason: 'Vertreibt Kapitalanlage-Immobilien an Privatanleger.',
  summary: 'Kapitalanlage-Vertrieb aus Hamburg. Der Geschäftsführer entscheidet selbst.',
};

test('gültige Ausgabe einer qualifizierenden Kategorie bleibt qualifiziert', () => {
  const result = parseQualification(base, 0.6);
  assert.equal(result.qualified, true);
  assert.equal(result.category, 'kapitalanlage_vertrieb');
  assert.equal(result.confidence, 0.9);
});

test('nur die ersten beiden Kategorien sind qualifiziert – auch wenn das Modell etwas anderes sagt', () => {
  for (const category of ['makler', 'hausverwaltung', 'asset_manager_bestandshalter', 'bauunternehmen_fuer_dritte', 'sonstiges']) {
    const result = parseQualification({ ...base, category, qualified: true }, 0.6);
    assert.equal(result.qualified, false, category);
  }
  assert.equal(parseQualification({ ...base, category: 'bautraeger_projektentwickler' }, 0.6).qualified, true);
});

test('streng ausgelegt: zu geringe Sicherheit oder „nicht qualifiziert“ vom Modell → aussortiert', () => {
  assert.equal(parseQualification({ ...base, confidence: 0.55 }, 0.6).qualified, false);
  assert.equal(parseQualification({ ...base, qualified: false }, 0.6).qualified, false);
});

test('Sicherheit in Prozent wird umgerechnet, Unsinn wird abgelehnt', () => {
  assert.equal(parseQualification({ ...base, confidence: 85 }, 0.6).confidence, 0.85);
  assert.throws(() => parseQualification({ ...base, confidence: -0.2 }, 0.6), QualificationValidationError);
  assert.throws(() => parseQualification({ ...base, confidence: 250 }, 0.6), QualificationValidationError);
});

test('ungültige Struktur wird mit verständlicher Meldung abgelehnt', () => {
  assert.throws(() => parseQualification({ ...base, category: 'immobilienmakler' }, 0.6), QualificationValidationError);
  assert.throws(() => parseQualification({ ...base, reason: '' }, 0.6), QualificationValidationError);
  assert.throws(() => parseQualification('kein json', 0.6), QualificationValidationError);
  assert.throws(() => parseQualification({ category: 'makler' }, 0.6), /qualified/);
});
