import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRepairsHtml, validateOutages, toIso, comparable, failureStatus, sameFailure } from '../scripts/lib/outages.mjs';

const read = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('toIso: зимнее время +02:00, летнее +03:00', () => {
  assert.equal(toIso('14.11.2026', '11:25'), '2026-11-14T11:25:00+02:00');
  assert.equal(toIso('15.07.2026', '09:00'), '2026-07-15T09:00:00+03:00');
  assert.equal(toIso('bad', '11:25'), null);
});

test('parseRepairsHtml: реальные строки', () => {
  const r = parseRepairsHtml(read('list.html'));
  assert.equal(r.found, true);
  assert.equal(r.outages.length, 2);
  const [a, b] = r.outages;
  assert.equal(a.address, 'ШЕВЧЕНКА ПРОСП.');
  assert.equal(a.partial, true);
  assert.equal(a.progressPercent, 6);
  assert.equal(a.start, '2026-11-14T11:25:00+02:00');
  assert.equal(a.restore, '2026-11-14T17:00:00+02:00');
  assert.equal(a.restoreKind, 'planned');
  assert.equal(b.address, 'ЛЕСІ УКРАЇНКИ ПРОСП.');
  assert.notEqual(a.id, b.id);
  assert.equal(validateOutages(r).ok, true);
});

test('пустой список валиден', () => {
  const r = parseRepairsHtml(read('list-empty.html'));
  assert.deepEqual(r, { found: true, outages: [] });
  assert.equal(validateOutages(r).ok, true);
});

test('страница-заглушка невалидна', () => {
  const r = parseRepairsHtml('<html>blocked</html>');
  assert.equal(validateOutages(r).ok, false);
});

test('comparable: учитывает прогресс, игнорирует номер строки', () => {
  const a = parseRepairsHtml(read('list.html')).outages;
  assert.equal(comparable(a), comparable(a.map((o) => ({ ...o, number: 9 }))));
  assert.notEqual(comparable(a), comparable(a.map((o) => ({ ...o, progressPercent: 50 }))));
  const b = a.map((o) => ({ ...o }));
  b[0].restore = '2026-11-14T18:00:00+02:00';
  assert.notEqual(comparable(a), comparable(b));
});

test('failure status', () => {
  const s = failureStatus('x');
  assert.equal(sameFailure(s, failureStatus('x')), true);
});

test('белое время восстановления = фактическое', () => {
  const html = read('list.html').replace('style="color: #60b6d9;"', 'style=""');
  assert.equal(parseRepairsHtml(html).outages[0].restoreKind, 'actual');
});
