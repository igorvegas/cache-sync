export const SCHEMA_VERSION = '1.0.0';
export const TZ = 'Europe/Kyiv';

const decode = (s) =>
  String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Смещение Europe/Kyiv (в минутах) для локального времени. */
function kyivOffsetMinutes(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  });
  let off = 0;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess - off * 60000)).map((x) => [x.type, x.value]));
    off = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - (guess - off * 60000)) / 60000;
  }
  return off;
}

/** "14.11.2026" + "11:25" -> "2026-11-14T11:25:00+02:00" (или null). */
export function toIso(dateStr, timeStr) {
  const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(dateStr ?? '').trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr ?? '').trim());
  if (!d || !t) return null;
  const [dd, mo, y, hh, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  const off = kyivOffsetMinutes(y, mo, dd, hh, mi);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${y}-${p2(mo)}-${p2(dd)}T${p2(hh)}:${p2(mi)}:00${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

function makeId(address, startIso) {
  // стабильный id: адрес + время начала (без процента, он постоянно меняется)
  let h = 5381;
  const s = `${address.toLowerCase()}|${startIso ?? ''}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const isPlannedColor = (c) => /^#?60b6d9$/i.test(String(c ?? '').trim());

/**
 * Разбор HTML страницы (после выполнения JS).
 * Возвращает { found: bool, outages: [] }. found=false -> страница не та / список не отрисован.
 */
export function parseRepairsHtml(html) {
  const found = /class="shutdown-crush-list"/.test(html) && /repairs-table/.test(html);
  if (!found) return { found: false, outages: [] };
  const outages = [];
  const itemRe = /<li class="shutdown-crush-item"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = itemRe.exec(html))) {
    const body = m[1];
    const num = Number(decode((/<p[^>]*>([\s\S]*?)<\/p>/.exec(body) || [])[1] ?? ''));
    const placeRaw = decode((/<p class="place"[^>]*>([\s\S]*?)<\/p>/.exec(body) || [])[1] ?? '');
    const progress = /shutdown-crush-value">\s*(\d+)\s*%/.exec(body);
    const times = [...body.matchAll(/<p class="shutdown-time"([^>]*)>([\s\S]*?)<\/p>/g)].map((t) => {
      const spans = [...t[2].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((s) => decode(s[1]));
      const color = (/color:\s*([^;"]+)/.exec(t[1]) || [])[1]?.trim() ?? null;
      return { iso: toIso(spans[0], spans[1]), raw: spans.join(' ').trim(), color };
    });
    if (!placeRaw) continue;
    const partial = /,\s*частково\s*$/i.test(placeRaw);
    const address = placeRaw.replace(/,\s*частково\s*$/i, '').trim();
    const start = times[0] ?? null;
    const restore = times[1] ?? null;
    outages.push({
      id: makeId(address, start?.iso),
      number: Number.isFinite(num) ? num : null,
      address,
      partial,
      progressPercent: progress ? Number(progress[1]) : null,
      start: start?.iso ?? null,
      restore: restore?.iso ?? null,
      // голубой (#60b6d9) = «Час плановий», белый/без цвета = «Час фактичний» (легенда на сайте)
      restoreKind: restore?.iso ? (isPlannedColor(restore.color) ? 'planned' : 'actual') : null,
      restoreColor: restore?.color ?? null,
      rawStart: start?.raw ?? null,
      rawRestore: restore?.raw ?? null,
    });
  }
  return { found: true, outages };
}

export function validateOutages(res) {
  if (!res?.found) return { ok: false, reason: 'список отключений не найден на странице' };
  const broken = res.outages.filter((o) => !o.start);
  if (broken.length) return { ok: false, reason: `${broken.length} запис(ей) без разобранного времени начала` };
  return { ok: true, count: res.outages.length };
}

/** Сравнение записей. Номер строки (number) не учитываем: он сдвигается при удалении записей выше. */
export function comparable(outages) {
  return JSON.stringify(
    (outages ?? [])
      .map(({ number, ...rest }) => rest)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function okStatus(at = new Date().toISOString()) {
  return { status: 'parsed', ok: true, code: 200, message: null, at };
}
export function failureStatus(message, at = new Date().toISOString()) {
  const text = String(message ?? 'нет данных').split('\n')[0].trim().slice(0, 200) || 'нет данных';
  return { status: 'failed', ok: false, code: null, message: text, at };
}
export function sameFailure(existing, next) {
  return Boolean(existing) && existing.ok === false && existing.message === next.message;
}
