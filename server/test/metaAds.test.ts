import assert from 'node:assert/strict';
import { test } from 'node:test';
import { germanDate, metaAdsLabel } from '../../shared/leadSearch.js';
import { adLibraryUrl, companySearchTerm, domainOf, evaluateAds, manualMetaAds, sameCompany, uncheckedAds, type ArchivedAd } from '../src/ads/metaAds.js';

const today = new Date('2026-10-02T09:00:00Z');

test('Suchbegriff: Firmenname ohne Rechtsform', () => {
  assert.equal(companySearchTerm('Achterberg Wohnbau GmbH & Co. KG'), 'Achterberg Wohnbau');
  assert.equal(companySearchTerm('Nordlicht Wohnbau AG'), 'Nordlicht Wohnbau');
  assert.equal(companySearchTerm('Siebrecht Immobilien e. K.'), 'Siebrecht Immobilien');
  assert.equal(companySearchTerm('Muster Projekt UG (haftungsbeschränkt)'), 'Muster Projekt');
  assert.equal(companySearchTerm('Kettler Invest & Immobilien'), 'Kettler Invest & Immobilien');
  assert.equal(companySearchTerm('Agentur Bau GmbH'), 'Agentur Bau', 'Rechtsform nur als eigenes Wort');
});

test('Domain aus der Website', () => {
  assert.equal(domainOf('https://www.Muster-Wohnbau.de/projekte?x=1'), 'muster-wohnbau.de');
  assert.equal(domainOf('muster.de'), 'muster.de');
  assert.equal(domainOf(''), null);
  assert.equal(domainOf('keine-domain'), null);
});

test('Eigene Anzeige erkennen: gleicher Name trotz Rechtsform/Umlaut, Branchenwörter allein reichen nicht', () => {
  assert.ok(sameCompany('Achterberg Wohnbau', 'Achterberg Wohnbau GmbH & Co. KG'));
  assert.ok(sameCompany('Höfling Immobilien', 'Hoefling Vermögensimmobilien GmbH'));
  assert.ok(sameCompany('Wendt und Söhne', 'Wendt & Söhne Projektentwicklung GmbH'));
  assert.ok(sameCompany('KayaRealInvest', 'Kaya Real Invest GmbH'));
  assert.ok(!sameCompany('Immobilien Invest Gruppe', 'Kaya Real Invest GmbH'));
  assert.ok(!sameCompany('Anderer Vertrieb GmbH', 'Kapital Invest 3 GmbH'));
  assert.ok(!sameCompany('Immobilien GmbH', 'Immobilien Invest GmbH'), 'ohne Eigennamen nur bei exakt gleichem Namen');
});

test('Auswertung: aktiv, beendet, keine – Fremdtreffer zählen nicht', () => {
  const company = { name: 'Muster Wohnbau GmbH', website: 'https://www.muster-wohnbau.de' };
  const own = (id: string, stop?: string): ArchivedAd => ({
    id,
    page_id: '123',
    page_name: 'Muster Wohnbau',
    ad_delivery_start_time: '2026-01-01',
    ad_delivery_stop_time: stop,
  });
  const foreign: ArchivedAd = { id: 'f', page_id: '9', page_name: 'Neubau-Portal', ad_delivery_start_time: '2026-09-01' };

  const running = evaluateAds([own('1'), own('2', '2026-04-01'), foreign], company, { today, term: 'Muster Wohnbau' });
  assert.equal(running.state, 'active');
  assert.equal(running.activeAds, 1);
  assert.equal(running.ads, 2);
  assert.equal(running.foreignAds, 1);
  assert.equal(running.lastStop, null);
  assert.equal(running.advertiser, 'Muster Wohnbau');
  assert.equal(running.libraryUrl, 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=DE&view_all_page_id=123&search_type=page&media_type=all');
  assert.equal(metaAdsLabel(running), 'Aktive Meta-Ads (1) – von Hand prüfen');

  // Enddatum heute oder später: läuft noch
  assert.equal(evaluateAds([own('1', '2026-10-02')], company, { today, term: 'x' }).state, 'active');
  assert.equal(evaluateAds([own('1', '2026-12-31')], company, { today, term: 'x' }).state, 'active');

  const stopped = evaluateAds([own('1', '2026-04-01'), own('2', '2026-08-12'), own('2', '2026-08-12')], company, { today, term: 'x' });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.ads, 2, 'doppelte Anzeigen nur einmal');
  assert.equal(stopped.lastStop, '2026-08-12');
  assert.equal(metaAdsLabel(stopped), 'Meta-Ads beendet am 12.08.2026');

  const none = evaluateAds([foreign], company, { today, term: 'Muster Wohnbau' });
  assert.equal(none.state, 'none');
  assert.equal(none.note, 'Nur Fremdtreffer (1 Anzeige anderer Werbetreibender)');
  assert.equal(none.libraryUrl, adLibraryUrl({ term: 'Muster Wohnbau' }));
  assert.match(none.libraryUrl ?? '', /q=Muster%20Wohnbau/);
  assert.equal(metaAdsLabel(none), 'Keine Meta-Ads gefunden');
  assert.equal(evaluateAds([], company, { today, term: 'x' }).note, null);

  // Anderer Seitenname, aber Link auf die eigene Website → eigene Anzeige
  const viaDomain = evaluateAds(
    [{ id: 'd', page_name: 'Wohnen am See', ad_creative_link_captions: ['MUSTER-WOHNBAU.DE'], ad_delivery_start_time: '2026-09-20' }],
    company,
    { today, term: 'x' },
  );
  assert.equal(viaDomain.state, 'active');
});

test('Datum auf Deutsch', () => {
  assert.equal(germanDate('2026-08-12'), '12.08.2026');
  assert.equal(germanDate('2026-08-12T10:00:00+0000'), '12.08.2026');
});

test('Von Hand eingetragen: Link zur Seite des Werbetreibenden bleibt, sonst Suche nach der Firma', () => {
  const found = adLibraryUrl({ pageId: '123' });
  const previous = { ...uncheckedAds('x', 'Depant GmbH'), state: 'active' as const, libraryUrl: found, advertiser: 'Depant' };
  const kept = manualMetaAds({ state: 'stopped', lastStop: '2026-10-09' }, 'Depant GmbH', previous);
  assert.equal(kept.libraryUrl, found);
  assert.equal(kept.advertiser, 'Depant');
  assert.equal(kept.lastStop, '2026-10-09');
  const searched = manualMetaAds({ state: 'none' }, 'Depant GmbH', uncheckedAds('x', 'Depant GmbH'));
  assert.match(searched.libraryUrl ?? '', /q=Depant&search_type=keyword_unordered/);
});
