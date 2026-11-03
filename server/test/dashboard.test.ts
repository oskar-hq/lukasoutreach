import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardResponse } from '../../shared/dashboard.js';
import type { LeadListResponse } from '../../shared/leads.js';
import { computeDashboard, dayRange, type DashboardEventRow } from '../src/dashboard/dashboard.js';
import { mockApp } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10, 10); // Sa 10.10.2026, 12 Uhr in Berlin
const at = (daysAgo: number, hour = 10) => NOW - daysAgo * DAY + (hour - 10) * 3600 * 1000;
const OPTIONS = { now: NOW, days: 14, timeZone: 'Europe/Berlin', maxFollowUps: 3 };

function row(lead: string, owner: string, kind: string, daysAgo: number, extra: Partial<DashboardEventRow> = {}): DashboardEventRow {
  return { lead_id: lead, owner, template: null, kind, at: at(daysAgo), label: null, ...extra };
}

test('Tage: lückenlos bis heute, auch über die Zeitumstellung', () => {
  assert.deepEqual(dayRange(NOW, 3, 'Europe/Berlin'), ['2026-10-08', '2026-10-09', '2026-10-10']);
  const afterDst = Date.UTC(2026, 9, 26, 10); // Zeitumstellung am 25.10.
  assert.deepEqual(dayRange(afterDst, 3, 'Europe/Berlin'), ['2026-10-24', '2026-10-25', '2026-10-26']);
  // 23:30 Uhr UTC ist in Berlin schon der nächste Tag.
  assert.equal(dayRange(Date.UTC(2026, 9, 10, 23, 30), 1, 'Europe/Berlin')[0], '2026-10-11');
});

test('Zählregeln, Vorlagen und Follow-up-Stufen', () => {
  const rows: DashboardEventRow[] = [
    // A (Nick): Anfrage, angenommen, Erstnachricht A, Follow-up 1, Antwort, Termin, Übergabe
    row('a', 'nick', 'invite_sent', 9, { template: 'A' }),
    row('a', 'nick', 'invite_accepted', 8, { template: 'A' }),
    row('a', 'nick', 'message_sent', 7, { template: 'A', label: 'A' }),
    row('a', 'nick', 'message_sent', 5, { template: 'A', label: 'B' }),
    row('a', 'nick', 'message_received', 4, { template: 'A' }),
    row('a', 'nick', 'message_sent', 4, { template: 'A' }),
    row('a', 'nick', 'message_received', 3, { template: 'A' }),
    row('a', 'nick', 'meeting_booked', 2, { template: 'A' }),
    row('a', 'nick', 'handed_over', 1, { template: 'A' }),
    // B (Nick): Erstnachricht B, zwei Follow-ups, keine Antwort
    row('b', 'nick', 'invite_sent', 9, { template: 'B' }),
    row('b', 'nick', 'message_sent', 7, { template: 'B', label: 'B' }),
    row('b', 'nick', 'message_sent', 5, { template: 'B' }),
    row('b', 'nick', 'message_sent', 3, { template: 'B' }),
    // C (Johannes): Erstnachricht vor dem Zeitraum → zählt nicht für Vorlagen/Stufen, Antwort aber als Tageswert
    row('c', 'johannes', 'message_sent', 30, { template: 'A', label: 'A' }),
    row('c', 'johannes', 'message_received', 2, { template: 'A' }),
    // D (Johannes): Antwort direkt nach der Erstnachricht
    row('d', 'johannes', 'message_sent', 6, { template: 'C', label: 'C' }),
    row('d', 'johannes', 'message_received', 6, { template: 'C' }),
    // Unbekannter Besitzer wird ignoriert
    row('x', 'fremd', 'invite_sent', 1),
  ];
  const result = computeDashboard(rows, [{ owner: 'nick', stage: 'new', n: 4 }, { owner: 'johannes', stage: 'replied', n: 2 }], OPTIONS);
  assert.equal(result.from, '2026-09-27');
  assert.equal(result.to, '2026-10-10');
  assert.equal(result.days.nick.length, 14);

  const sum = (founder: 'nick' | 'johannes', key: keyof Omit<DashboardResponse['days']['nick'][number], 'date'>) =>
    result.days[founder].reduce((total, day) => total + day[key], 0);
  assert.deepEqual(
    ['requests', 'accepted', 'messaged', 'replies', 'meetings', 'handovers'].map((key) => sum('nick', key as 'requests')),
    [2, 1, 2, 1, 1, 1],
    'Nick: je Lead nur die erste Nachricht und die erste Antwort',
  );
  assert.equal(result.days.nick.find((day) => day.date === '2026-10-03')!.messaged, 2);
  assert.deepEqual([sum('johannes', 'messaged'), sum('johannes', 'replies')], [1, 2]);

  assert.deepEqual(result.templates.nick, [
    { template: 'A', messaged: 1, replied: 1 },
    { template: 'B', messaged: 1, replied: 0 },
  ]);
  assert.deepEqual(result.templates.johannes, [{ template: 'C', messaged: 1, replied: 1 }], 'C liegt vor dem Zeitraum');

  assert.deepEqual(result.followUps.nick, [
    { stage: 0, reached: 2, replied: 0 },
    { stage: 1, reached: 2, replied: 1 },
    { stage: 2, reached: 1, replied: 0 },
    { stage: 3, reached: 0, replied: 0 },
  ]);
  assert.deepEqual(result.followUps.johannes[0], { stage: 0, reached: 1, replied: 1 });
  assert.equal(result.pipeline.nick.new, 4);
  assert.equal(result.pipeline.johannes.replied, 2);
  assert.equal(result.pipeline.johannes.new, 0);
});

test('Route in der Simulation: Zahlen aus den Demo-Leads, neue Aktion zählt heute', async () => {
  const app = mockApp();
  const response = await app.inject({ method: 'GET', url: '/api/dashboard' });
  assert.equal(response.statusCode, 200);
  const result = response.json() as DashboardResponse;
  assert.equal(result.days.nick.length, 112);
  assert.equal(result.timeZone, 'Europe/Berlin');
  const pipelineTotal = Object.values(result.pipeline).flatMap((stages) => Object.values(stages)).reduce((a, b) => a + b, 0);
  assert.equal(pipelineTotal, 30);
  const total = (key: 'requests' | 'messaged' | 'replies') => [...result.days.nick, ...result.days.johannes].reduce((sum, day) => sum + day[key], 0);
  assert.ok(total('requests') > 0 && total('messaged') > 0 && total('replies') > 0);
  assert.ok(result.templates.nick.length > 0);

  const { leads } = (await app.inject({ method: 'GET', url: '/api/leads?stage=new&owner=nick&limit=1' })).json() as LeadListResponse;
  await app.inject({ method: 'POST', url: `/api/leads/${leads[0].id}/events`, payload: { action: 'invite_sent' } });
  const after = (await app.inject({ method: 'GET', url: '/api/dashboard?days=7' })).json() as DashboardResponse;
  assert.equal(after.days.nick.length, 7);
  const before = result.days.nick.at(-1)!.requests;
  assert.equal(after.days.nick.at(-1)!.requests, before + 1);

  assert.equal((await app.inject({ method: 'GET', url: '/api/dashboard?days=3' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/dashboard?days=999' })).statusCode, 400);
});
